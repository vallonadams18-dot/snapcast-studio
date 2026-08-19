import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAnthropicClient } from "@/lib/ai";
import { resolveFfmpegPath, resolveFontFile } from "@/lib/ffmpegPaths";
import { VIDEO_FPS, intermediateEncode, deliveryEncode } from "@/lib/encoding";
import { parseFfmpegDuration } from "@/lib/probeParsing";
import { isAllHardCuts, type EditPlan, type EditSegment, type SegmentMotion } from "@/lib/editPlan";
import { parseSceneChangeTimes, planVideoSceneWindows, type VideoSceneWindow } from "@/lib/videoScenePlanning";

// ffmpeg's filtergraph mini-language treats `:`, `\`, and unescaped `'` as
// syntax, so any path fed into a filter option (fontfile=, textfile=) needs
// its own escaping on top of the OS path — colons doubly so on Windows
// drive letters. Forward slashes avoid a second layer of backslash escaping.
function escapeForFilterArg(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// ffmpeg binary + font paths are platform-dependent — see lib/ffmpegPaths.ts.

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      // ffmpeg writes normal info (including duration) to stderr even on
      // success, so we always resolve with it and let callers parse/ignore.
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function getVideoDurationSeconds(filePath: string): Promise<number> {
  // `ffmpeg -i` with no output exits non-zero BY DESIGN — the header info
  // lands on stderr. The FULL stderr must be parsed, never the tail of an
  // Error message: runFfmpeg's error truncates stderr to its last 2000
  // chars, and a metadata-heavy container (every real iPhone .mov — extra
  // streams, QuickTime tags, colour info) pushes `Duration:` past that
  // cut. That truncation had the upload validator rejecting perfectly good
  // customer videos as "corrupt".
  const output = await new Promise<string>((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), ["-i", filePath]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      // A container would have to be pathological to print more header
      // than this; cap so a hostile file can't balloon memory.
      if (stderr.length < 512 * 1024) stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", () => resolve(stderr));
  });
  const duration = parseFfmpegDuration(output);
  if (duration === null) throw new Error("Could not determine video duration");
  return duration;
}

/**
 * Frame rate of a rendered file, or null if it can't be read.
 *
 * Every h264 stage is supposed to deliver VIDEO_FPS. This exists so that can
 * be checked at each step of the chain rather than only at the end, where a
 * wrong rate says nothing about which stage introduced it.
 */
export async function getVideoFrameRate(filePath: string): Promise<number | null> {
  let output = "";
  try {
    output = await runFfmpeg(["-i", filePath]);
  } catch (err) {
    // ffmpeg with no output file always "fails"; the stream info is in stderr.
    output = err instanceof Error ? err.message : "";
  }
  const match = output.match(/,\s*([\d.]+)\s*fps\b/);
  return match ? Number(match[1]) : null;
}

export async function extractFrameAt(filePath: string, atSeconds: number, outputPath: string): Promise<void> {
  await runFfmpeg([
    "-ss", String(Math.max(0, atSeconds)),
    "-i", filePath,
    "-frames:v", "1",
    "-q:v", "3",
    "-y", outputPath,
  ]);
}

/**
 * Detect hard visual cuts, then turn them into several distinct short-form
 * windows. Scene detection is advisory: an older ffmpeg build or a single
 * continuous phone take falls back to evenly spaced windows, so the template
 * still transforms the source instead of returning one long central slice.
 */
export async function detectVideoSceneWindows(
  filePath: string,
  durationSeconds: number,
  desiredCount: number,
  windowSeconds: number,
): Promise<VideoSceneWindow[]> {
  let output = "";
  try {
    output = await runFfmpeg([
      "-i", filePath,
      "-vf", "select='gt(scene,0.28)',showinfo",
      "-an",
      "-f", "null",
      "-",
    ]);
  } catch {
    // The deterministic spacing fallback below is deliberately sufficient.
  }
  return planVideoSceneWindows(durationSeconds, parseSceneChangeTimes(output), desiredCount, windowSeconds);
}

export interface HighlightWindow {
  startSeconds: number;
  endSeconds: number;
  reason: string;
}

// Visual-first highlight detection: sample frames evenly across the video
// and ask Claude to pick the most energetic contiguous window — crowd
// reactions, motion, key moments — rather than relying on a transcript.
export async function detectHighlightWindow(
  filePath: string,
  durationSeconds: number,
): Promise<HighlightWindow> {
  const sampleCount = Math.min(8, Math.max(4, Math.floor(durationSeconds / 5)));
  const clipLength = Math.min(15, durationSeconds);
  const fallback: HighlightWindow = {
    startSeconds: 0,
    endSeconds: clipLength,
    reason: "Default: start of the video (AI highlight detection unavailable)",
  };

  const anthropic = getAnthropicClient();
  if (!anthropic) return fallback;

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-frames-"));
  try {
    const timestamps = Array.from({ length: sampleCount }, (_, i) => (durationSeconds * i) / sampleCount);
    const frames: { timestamp: number; buffer: Buffer }[] = [];

    for (const [i, ts] of timestamps.entries()) {
      const framePath = path.join(tmpDir, `frame-${i}.jpg`);
      try {
        await extractFrameAt(filePath, ts, framePath);
        frames.push({ timestamp: ts, buffer: await readFile(framePath) });
      } catch {
        // Skip frames ffmpeg couldn't extract (e.g. past EOF); we still
        // work with whatever frames succeeded.
      }
    }

    if (frames.length === 0) return fallback;

    const response = await anthropic.beta.messages.create({
      model: "claude-opus-5",
      // Thinking is on by default even at effort "low" — a small budget here
      // gets fully consumed by thinking with no room left for the JSON
      // output, silently producing no text block at all.
      max_tokens: 1536,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              bestFrameIndex: { type: "integer" },
              reason: { type: "string" },
            },
            required: ["bestFrameIndex", "reason"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: "user",
          content: [
            ...frames.map((f) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: "image/jpeg" as const, data: f.buffer.toString("base64") },
            })),
            {
              type: "text",
              text: [
                `These are ${frames.length} frames sampled evenly across an event video, in order.`,
                "Pick the single frame with the most visual energy — a key moment, crowd reaction, motion, or emotional peak — the kind of moment worth clipping into a highlight reel.",
                "Return its index (0-based, matching the order shown) and a one-sentence reason.",
              ].join(" "),
            },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      console.error("[video] Claude refused the highlight-detection request", response.stop_details);
      return fallback;
    }
    const parsed = response.content.find((block) => block.type === "text");
    if (!parsed || parsed.type !== "text") {
      console.error("[video] No text block in highlight-detection response", { stopReason: response.stop_reason });
      return fallback;
    }

    const json = JSON.parse(parsed.text) as { bestFrameIndex: number; reason: string };
    const picked = frames[json.bestFrameIndex] ?? frames[0];
    const start = Math.max(0, picked.timestamp - clipLength / 2);
    const end = Math.min(durationSeconds, start + clipLength);

    return { startSeconds: start, endSeconds: end, reason: json.reason };
  } catch (err) {
    console.error("[video] detectHighlightWindow failed, falling back to default window", err);
    return fallback;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Guarantees the bytes handed to storage are actually deliverable.
 *
 * Delivery settings (+faststart in particular) were only ever applied by
 * OPTIONAL stages — the music mix and the watermark. When a montage skipped
 * all of them, which happens whenever the client has no logo and the music
 * provider is unavailable, the file shipped as the raw CRF-18 intermediate
 * with its moov atom at the end. A browser then has to fetch the whole file
 * before it can play or scrub, which is the wrong shape for a phone.
 *
 * Prefers a STREAM COPY. Relocating the moov atom needs no re-encode, so
 * this costs milliseconds and loses nothing — re-encoding a finished video
 * purely to move four bytes of index would throw away a generation of
 * quality for no reason. A full delivery encode is the fallback, used only
 * when the copy fails or the frame rate is somehow wrong.
 *
 * Returns the input untouched on any failure: a video without faststart is
 * still a video, and losing it here would be far worse.
 */
export async function finalizeForDelivery(videoBuffer: Buffer): Promise<Buffer<ArrayBuffer>> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-final-"));
  try {
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    await writeFile(inputPath, videoBuffer);

    const fps = await getVideoFrameRate(inputPath).catch(() => null);
    const rateIsRight = fps !== null && Math.abs(fps - VIDEO_FPS) < 0.5;

    if (rateIsRight) {
      try {
        await runFfmpeg(["-i", inputPath, "-c", "copy", "-movflags", "+faststart", "-y", outputPath]);
        return await readFile(outputPath);
      } catch {
        // Fall through to a real encode.
      }
    }

    await runFfmpeg([
      "-i", inputPath,
      "-r", String(VIDEO_FPS),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      ...deliveryEncode(),
      // Copy audio when present, and don't fail when it isn't.
      "-c:a", "copy",
      "-y", outputPath,
    ]);
    return await readFile(outputPath);
  } catch (err) {
    console.error("[video] delivery finalize failed, shipping the video as-is", err);
    return Buffer.from(videoBuffer) as Buffer<ArrayBuffer>;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export interface CreateClipOptions {
  sourcePath: string;
  startSeconds: number;
  endSeconds: number;
  captionText?: string;
  outputPath: string;
}

// drawtext's own mini-language (independent of any shell): backslash and
// the filtergraph separators `:`/`,` need escaping, in that order so we
// don't double-escape the backslashes we just inserted.
function escapeDrawtextValue(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%");
}

const CROP_FILTERS = ["scale=1080:1920:force_original_aspect_ratio=increase", "crop=1080:1920"];

// Cuts the window and crops/pads to vertical 9:16 — everything TikTok/
// Reels/Shorts expect from a clip. Caption burn-in is attempted on top when
// requested, but never blocks the clip: some ffmpeg builds have a broken
// fontconfig link (font lookup fails even with an explicit fontfile), so a
// failed burn-in falls back to a clean captionless clip rather than losing
// the whole clip — the caption still exists as the draft text either way.
export async function createVerticalClip(options: CreateClipOptions): Promise<void> {
  const duration = options.endSeconds - options.startSeconds;
  const inputArgs = ["-ss", String(options.startSeconds), "-i", options.sourcePath, "-t", String(duration)];
  // No -r here on purpose: this is cut from real footage, and forcing a
  // frame rate onto someone's 60fps phone video would resample it for no
  // reason. The bookend/concat step normalises rate later if it runs.
  const outputArgs = [
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    ...deliveryEncode(),
    "-c:a", "aac",
    "-y", options.outputPath,
  ];

  if (options.captionText) {
    const escaped = escapeDrawtextValue(options.captionText.slice(0, 120));
    const drawtextOptions = [
      `fontfile=${escapeForFilterArg(resolveFontFile())}`,
      `text=${escaped}`,
      "fontcolor=white",
      "fontsize=48",
      "box=1",
      "boxcolor=black@0.5",
      "boxborderw=20",
      "x=(w-text_w)/2",
      "y=h-th-120",
    ].join(":");
    const filters = [...CROP_FILTERS, `drawtext=${drawtextOptions}`];

    try {
      await runFfmpeg([...inputArgs, "-vf", filters.join(","), ...outputArgs]);
      return;
    } catch {
      // Fall through to the captionless render below.
    }
  }

  await runFfmpeg([...inputArgs, "-vf", CROP_FILTERS.join(","), ...outputArgs]);
}

// Trims an already-rendered video to a sub-range. Re-encodes rather than
// stream-copying: a copy can only cut on keyframes, so the result would
// start late or open on a frozen frame, and the trimmed audio would drift.
export async function trimVideo(opts: {
  sourcePath: string;
  startSeconds: number;
  endSeconds: number;
  outputPath: string;
}): Promise<void> {
  const duration = Math.max(0.5, opts.endSeconds - opts.startSeconds);
  await runFfmpeg([
    "-ss", String(Math.max(0, opts.startSeconds)),
    "-i", opts.sourcePath,
    "-t", String(duration),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    ...deliveryEncode(),
    "-c:a", "aac",
    "-y", opts.outputPath,
  ]);
}

/**
 * One frame at 30fps. xfade rejects a zero-length blend, so this is how a
 * hard cut is expressed inside a chain that also contains real transitions.
 */
const CUT_AS_XFADE_SECONDS = 0.034;

// Filter expressions must carry plain decimals — a very small step printed
// in exponential form (1e-7) is a syntax error inside a filtergraph.
function fixed(value: number): string {
  return value.toFixed(6);
}

// ------------------------------------------------------------- 2D motion --
//
// Motion is a DIRECT expression of the output frame index `on`, not a
// per-frame recurrence. That is what makes easing possible: progress
// p = on/span runs 0→1 across the segment, an easing curve reshapes it, and
// the zoom or pan position is computed from the eased value each frame.
// (It also retires the old eq(on,0) first-frame hack — a direct expression
// has no accumulated state to seed.) Constant-velocity motion is the single
// biggest "screensaver" tell; easing is what makes a move feel operated.

/**
 * Eased progress 0→1 over an arbitrary progress expression. `p` is the raw
 * linear progress term — `(on/span)` in zoompan's frame domain, `(t/T)` in
 * rotate's time domain — so ONE easing definition drives every moving layer.
 * That is what makes "settle" actually settle: foreground, parallax
 * backdrop and rotation all read the same curve, and when it flattens at
 * 85% the WHOLE composition rests, not just the photo layer.
 */
function easedOf(easing: EditSegment["easing"], p: string): string {
  const easeInOutOf = (q: string) => `if(lt(${q},0.5),2*${q}*${q},1-pow(-2*${q}+2,2)/2)`;
  switch (easing) {
    case "linear":
      return p;
    case "ease-out":
      // Fast start, gentle landing.
      return `(1-pow(1-${p},2))`;
    case "ease-in-out":
      return easeInOutOf(p);
    case "punch":
      // Nearly all of the move lands in the first ~22% of the segment, then
      // holds — the zoom hits WITH the cut, not gradually after it.
      return `min(1,pow(${p}/0.22,0.75))`;
    case "settle":
      // The hero's easing: the move completes by 85% and the final frames
      // REST, so the loop point lands on a composed, motionless frame
      // instead of mid-drift.
      return `if(gte(${p},0.85),1,${easeInOutOf(`(${p}/0.85)`)})`;
  }
}

/** Eased progress in zoompan's frame domain. `span` = frames - 1. */
function easedProgress(easing: EditSegment["easing"], span: number): string {
  return easedOf(easing, `(on/${span})`);
}

/** One zoompan filter executing the segment's move at the given magnitude. */
function motionFilter(
  motion: SegmentMotion,
  frameCount: number,
  magnitude: number,
  easing: EditSegment["easing"],
): string | null {
  if (motion === "none" || magnitude <= 0) return null;

  const span = Math.max(1, frameCount - 1);
  const E = easedProgress(easing, span);
  const size = `:d=${frameCount}:s=1080x1920:fps=${VIDEO_FPS}`;
  // Centre the zoom origin — zoompan's default is top-left, which walks the
  // subject out of frame.
  const centre = ":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
  const M = fixed(Math.min(0.5, magnitude));
  // Pan travel across the frame is (1 - 1/zoom) of its size; invert to get
  // the constant zoom that yields the requested travel.
  const panZoom = fixed(1 / (1 - Math.min(0.5, magnitude)));
  const yCentred = `:y='ih/2-(ih/zoom/2)'`;
  const xCentred = `:x='iw/2-(iw/zoom/2)'`;

  switch (motion) {
    case "push-in":
    case "zoom-punch":
      // zoom-punch differs from push-in only by its easing, which the plan
      // has already chosen — the renderer treats them identically.
      return `zoompan=z='1+${M}*${E}'${centre}${size}`;
    case "pull-out":
      return `zoompan=z='1+${M}*(1-${E})'${centre}${size}`;
    case "pan-right":
      return `zoompan=z='${panZoom}':x='(iw-iw/zoom)*${E}'${yCentred}${size}`;
    case "pan-left":
      return `zoompan=z='${panZoom}':x='(iw-iw/zoom)*(1-${E})'${yCentred}${size}`;
    case "pan-down":
      return `zoompan=z='${panZoom}'${xCentred}:y='(ih-ih/zoom)*${E}'${size}`;
    case "pan-up":
      return `zoompan=z='${panZoom}'${xCentred}:y='(ih-ih/zoom)*(1-${E})'${size}`;
  }
}

/**
 * The preset's grade, applied identically to every segment. Saturation and
 * contrast via eq, a vignette scaled from the look value, and fine grain —
 * the difference between "rendered" and "produced" is mostly this chain.
 */
function gradeChain(look: EditPlan["look"]): string {
  const parts = [`eq=saturation=${fixed(look.saturation)}:contrast=${fixed(look.contrast)}`];
  if (look.vignette > 0) parts.push(`vignette=angle=${fixed(Math.PI * Math.min(0.35, look.vignette))}`);
  if (look.grain > 0) parts.push(`noise=alls=${Math.round(look.grain * 100)}:allf=t`);
  return parts.join(",");
}

/**
 * Slow rotation drift (-d° → +d°) across the segment. The frame is oversized
 * ~10% first so the rotated corners never reveal the edge; at the 2.5° the
 * Party preset uses, the required margin is ~46px against 54px available.
 */
function rotateChain(degrees: number, durationSeconds: number, easing: EditSegment["easing"]): string {
  const d = fixed((degrees * Math.PI) / 180);
  // Rotation reads the same easing curve as every other layer, in rotate's
  // time domain — a settling hero stops turning at 85% too. A linear t/T
  // here kept the composite rotating through the final frame.
  const E = easedOf(easing, `(t/${fixed(Math.max(0.1, durationSeconds))})`);
  return `scale=1188:2112,rotate='(-${d})+2*${d}*${E}':ow=1188:oh=2112:c=black,crop=1080:1920`;
}

// Fits the photo into a 9:16 frame WITHOUT cropping the subject out: the
// whole photo is scaled to fit, and the empty sides are filled with a
// blurred, zoomed copy of the same photo. This is what Reels/TikTok do, and
// it's the fix for landscape group shots losing everyone at the edges — a
// plain center-crop to 1080x1920 discards most of a 3:2 frame's width.
const BLURRED_FIT_FILTER = [
  "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=32[bg]",
  "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]",
  "[bg][fg]overlay=(W-w)/2:(H-h)/2",
].join(";");

/**
 * Two-layer parallax: the blurred backdrop moves at bgMagnitude while the
 * photo itself moves at the segment's own magnitude. The RATE DIFFERENCE is
 * the depth cue — and because the photo's motion is applied to its own
 * padded layer before compositing, the old artefact of the blurred bars
 * zooming in lockstep with the photo is gone.
 */
function parallaxGraph(segment: EditSegment, frameCount: number, motion: string): string {
  const span = Math.max(1, frameCount - 1);
  // The backdrop follows the SEGMENT'S OWN easing at its smaller magnitude —
  // previously it pushed linearly regardless, so a settling hero rested its
  // photo while the blurred backdrop kept crawling through the loop frame.
  const bgE = easedProgress(segment.easing, span);
  const bgM = fixed(Math.min(0.3, segment.bgMagnitude));
  const size = `:d=${frameCount}:s=1080x1920:fps=${VIDEO_FPS}`;
  const centre = ":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
  return [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=32,` +
      `zoompan=z='1+${bgM}*${bgE}'${centre}${size}[bg]`,
    `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
      `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0.0,format=rgba,${motion}[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`,
  ].join(";");
}

// One photo → one vertical segment carrying the plan's exact treatment:
// motion + easing + parallax + grade + drift, all pre-resolved. The renderer
// makes no creative choices — it only executes, and degrades in ordered
// steps so a cosmetic failure can never cost the montage:
//   full treatment → no rotate → no parallax → no grade → no motion → crop.
async function createPhotoSegment(segment: EditSegment, plan: EditPlan, outputPath: string): Promise<void> {
  const frameCount = Math.max(2, Math.round(segment.durationSeconds * VIDEO_FPS));
  const motion = motionFilter(segment.motion, frameCount, segment.motionMagnitude, segment.easing);
  const grade = gradeChain(plan.look);
  const rotate = segment.rotateDriftDegrees > 0 ? rotateChain(segment.rotateDriftDegrees, segment.durationSeconds, segment.easing) : null;

  const inputArgs = ["-loop", "1", "-i", segment.sourcePath, "-t", String(segment.durationSeconds)];
  // Intermediate quality: this segment gets re-encoded at least once more
  // (transition concat, then music, then watermark), so it is encoded finer
  // than delivery to stop those generations compounding.
  const outputArgs = [
    "-r", String(VIDEO_FPS),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    ...intermediateEncode(),
    "-y", outputPath,
  ];

  // Ordered best → simplest. First that succeeds wins.
  const attempts: string[][] = [];

  if (segment.fit === "blurred") {
    if (motion && segment.bgMagnitude > 0) {
      const parallax = parallaxGraph(segment, frameCount, motion);
      if (rotate) attempts.push(["-filter_complex", `${parallax},${grade},${rotate}`]);
      attempts.push(["-filter_complex", `${parallax},${grade}`]);
    }
    // Single-layer composite with motion applied after the fit (the 2C
    // treatment) — the parallax fallback and the no-parallax presets' path.
    if (motion) {
      attempts.push(["-filter_complex", `${BLURRED_FIT_FILTER},${motion},${grade}`]);
      attempts.push(["-filter_complex", `${BLURRED_FIT_FILTER},${motion}`]);
    }
    attempts.push(["-filter_complex", `${BLURRED_FIT_FILTER},${grade}`]);
    attempts.push(["-filter_complex", BLURRED_FIT_FILTER]);
  } else {
    if (motion) {
      attempts.push(["-vf", [...CROP_FILTERS, motion, grade].join(",")]);
      attempts.push(["-vf", [...CROP_FILTERS, motion].join(",")]);
    }
    attempts.push(["-vf", [...CROP_FILTERS, grade].join(",")]);
  }
  attempts.push(["-vf", CROP_FILTERS.join(",")]);

  let lastError: unknown;
  for (const filterArgs of attempts) {
    try {
      await runFfmpeg([...inputArgs, ...filterArgs, ...outputArgs]);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// One VIDEO → one vertical segment (EditPlan v3). The plan has already
// decided the trim window; this normalises the clip to the montage geometry
// so it concatenates seamlessly with photo segments: blurred-fit into
// 1080x1920 (portrait, landscape, square all safe), the plan's grade, 30fps
// CFR, yuv420p, SAR 1. No synthesised camera motion — the clip's own motion
// IS the motion. Audio is stripped: montage segments are silent by
// contract; the licensed track owns the final audio bed (see lib/branding
// for the same decision on bookends).
async function createVideoSegment(segment: EditSegment, plan: EditPlan, outputPath: string): Promise<void> {
  const grade = gradeChain(plan.look);
  // setsar=1 matters here in a way it doesn't for photos: camera files can
  // carry non-square sample aspect ratios, and xfade refuses inputs whose
  // SARs disagree.
  const fitChain = `${BLURRED_FIT_FILTER},setsar=1`;

  const inputArgs = [
    // -ss before -i: input seeking, frame-accurate under re-encode.
    "-ss", String(segment.sourceStartSeconds),
    "-i", segment.sourcePath,
    "-t", String(segment.durationSeconds),
  ];
  const outputArgs = [
    "-an",
    "-r", String(VIDEO_FPS),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    ...intermediateEncode(),
    "-y", outputPath,
  ];

  // Grade is cosmetic — never let it cost the segment.
  const attempts: string[][] = [
    ["-filter_complex", `${fitChain},${grade}`],
    ["-filter_complex", fitChain],
  ];

  let lastError: unknown;
  for (const filterArgs of attempts) {
    try {
      await runFfmpeg([...inputArgs, ...filterArgs, ...outputArgs]);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Cross-fades between segments using xfade, which needs ffmpeg 4.3+.
// Returns false when unavailable (or when the graph fails) so the caller
// can fall back to hard cuts instead of producing nothing.
async function concatWithTransitions(
  segmentPaths: string[],
  segments: EditSegment[],
  outputPath: string,
): Promise<boolean> {
  // A plan of nothing but hard cuts has no blends to build; the caller's
  // concat-demuxer path is both simpler and faster for that case.
  if (segmentPaths.length < 2 || isAllHardCuts(segments)) return false;

  const inputs = segmentPaths.flatMap((p) => ["-i", p]);
  const steps: string[] = [];
  let current = "[0:v]";
  // Each xfade overlaps its pair, so the running length of everything merged
  // so far shrinks by one transition per join. The next offset is that
  // running length minus the transition about to be applied.
  //
  // Both the segment durations AND the transition durations are now read
  // per-segment. Assuming one shared value for either drifts every
  // subsequent join a little further out of place.
  let elapsed = segments[0].durationSeconds;

  for (let i = 1; i < segmentPaths.length; i++) {
    const joining = segments[i - 1];
    // xfade cannot express a zero-length blend, so a hard cut inside a mixed
    // chain becomes a single frame of cross-fade — imperceptible at 30fps,
    // and it lets one video mix rapid cuts with softer transitions.
    const isCut = joining.transitionOut === "cut" || joining.transitionSeconds <= 0;
    const d = isCut ? CUT_AS_XFADE_SECONDS : joining.transitionSeconds;
    const kind = isCut ? "fade" : joining.transitionOut;

    const label = i === segmentPaths.length - 1 ? "[out]" : `[v${i}]`;
    const offset = Math.round(Math.max(0, elapsed - d) * 1000) / 1000;
    steps.push(`${current}[${i}:v]xfade=transition=${kind}:duration=${d}:offset=${offset}${label}`);
    current = label;
    elapsed = offset + segments[i].durationSeconds;
  }

  try {
    await runFfmpeg([
      ...inputs,
      "-filter_complex", steps.join(";"),
      "-map", "[out]",
      "-r", String(VIDEO_FPS),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      ...intermediateEncode(),
      "-y", outputPath,
    ]);
    return true;
  } catch (err) {
    console.error("[video] xfade transitions unavailable, using hard cuts", err);
    return false;
  }
}

export interface PhotoMontageOptions {
  /** The creative instruction sheet. See lib/editPlan.ts. */
  plan: EditPlan;
  outputPath: string;
}

// Executes an EditPlan. Silent; mix music in separately via
// lib/music.ts#mixTrackIntoClip, which works on any video whether or not it
// already has an audio track.
//
// This function makes NO creative decisions. Which photos, in what order,
// for how long, with which camera move and which transition are all settled
// before it is called. Its only job is to turn that into ffmpeg.
export async function createPhotoMontage(options: PhotoMontageOptions): Promise<void> {
  const segments = options.plan.segments;
  if (segments.length === 0) throw new Error("No photos to compile");

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-montage-"));
  try {
    const segmentPaths: string[] = [];
    for (const [i, segment] of segments.entries()) {
      const segPath = path.join(tmpDir, `seg-${i}.mp4`);
      if (segment.mediaKind === "video") {
        await createVideoSegment(segment, options.plan, segPath);
      } else {
        await createPhotoSegment(segment, options.plan, segPath);
      }
      segmentPaths.push(segPath);
    }

    // Preferred path: real transitions between shots. Returns false on
    // ffmpeg builds without xfade (< 4.3), where we fall through to cuts.
    if (await concatWithTransitions(segmentPaths, segments, options.outputPath)) {
      return;
    }

    const concatListPath = path.join(tmpDir, "concat.txt");
    const concatList = segmentPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
    await writeFile(concatListPath, concatList, "utf8");

    // Re-encode rather than -c copy: stream-copying a concat-demuxer output
    // carries over inconsistent per-segment timestamps, which later confuses
    // -shortest when mixing in audio (observed: a 7.5s montage muxed with a
    // 2-minute track came out reporting a 2-minute container duration).
    // Re-encoding here normalizes timestamps once, for a small ffmpeg-time
    // cost per photo, so every downstream step behaves like a normal video.
    await runFfmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-r", String(VIDEO_FPS),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      ...intermediateEncode(),
      "-y", options.outputPath,
    ]);

  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
