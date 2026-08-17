import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAnthropicClient } from "@/lib/ai";
import { resolveFfmpegPath, resolveFontFile } from "@/lib/ffmpegPaths";
import type { MontageStyle } from "@/lib/montageStyles";

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
  let output = "";
  try {
    output = await runFfmpeg(["-i", filePath]);
  } catch (err) {
    // ffmpeg with no output file always "fails" — the info we need is in
    // the error's captured stderr.
    output = err instanceof Error ? err.message : "";
  }
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error("Could not determine video duration");
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

async function extractFrameAt(filePath: string, atSeconds: number, outputPath: string): Promise<void> {
  await runFfmpeg([
    "-ss", String(Math.max(0, atSeconds)),
    "-i", filePath,
    "-frames:v", "1",
    "-q:v", "3",
    "-y", outputPath,
  ]);
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
  const outputArgs = ["-c:v", "libx264", "-c:a", "aac", "-y", options.outputPath];

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
    "-c:a", "aac",
    "-y", opts.outputPath,
  ]);
}

const MONTAGE_FPS = 25;

// zoompan works in whole frames, and it re-evaluates its expression per
// output frame, so motion is expressed as "how much per frame".
function motionFilter(motion: MontageStyle["motion"], frameCount: number, index: number): string | null {
  const size = `:d=${frameCount}:s=1080x1920:fps=${MONTAGE_FPS}`;
  // Centre the zoom origin. zoompan's default origin is the top-left, which
  // makes a zoom drift toward the corner and slide the subject out of frame.
  const centre = ":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";

  switch (motion) {
    case "zoom-in":
      return `zoompan=z='min(zoom+0.0009,1.14)'${centre}${size}`;
    case "zoom-out":
      // Start pushed in and pull back. zoom starts at 1.14 and eases down.
      return `zoompan=z='if(eq(on,1),1.14,max(zoom-0.0009,1.0))'${centre}${size}`;
    case "pan-right":
      // Hold a slight zoom so there's headroom to travel across.
      return `zoompan=z='1.12':x='(iw-iw/zoom)*(on/${frameCount})':y='ih/2-(ih/zoom/2)'${size}`;
    case "alternate":
      // Alternating push/pull is what gives a fast cut sequence its rhythm —
      // every photo moving the same direction reads as one long drift.
      return index % 2 === 0
        ? `zoompan=z='min(zoom+0.0016,1.18)'${centre}${size}`
        : `zoompan=z='if(eq(on,1),1.18,max(zoom-0.0016,1.0))'${centre}${size}`;
    case "none":
      return null;
  }
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

// One photo → one vertical segment with the style's fit and camera move.
// Degrades in two steps rather than failing: motion dropped first, then the
// blurred fit — a plain slideshow still beats losing the feature entirely.
async function createPhotoSegment(
  photoPath: string,
  style: MontageStyle,
  index: number,
  outputPath: string,
): Promise<void> {
  const frameCount = Math.round(style.secondsPerPhoto * MONTAGE_FPS);
  const motion = motionFilter(style.motion, frameCount, index);

  const inputArgs = ["-loop", "1", "-i", photoPath, "-t", String(style.secondsPerPhoto)];
  const outputArgs = ["-r", String(MONTAGE_FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", outputPath];

  // Ordered best → simplest. First that succeeds wins.
  const attempts: string[][] = [];

  if (style.fit === "blurred") {
    const chain = motion ? `${BLURRED_FIT_FILTER},${motion}` : BLURRED_FIT_FILTER;
    attempts.push(["-filter_complex", chain]);
    attempts.push(["-filter_complex", BLURRED_FIT_FILTER]);
  } else {
    const chain = motion ? [...CROP_FILTERS, motion].join(",") : CROP_FILTERS.join(",");
    attempts.push(["-vf", chain]);
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

// Cross-fades between segments using xfade, which needs ffmpeg 4.3+.
// Returns false when unavailable (or when the graph fails) so the caller
// can fall back to hard cuts instead of producing nothing.
async function concatWithTransitions(
  segmentPaths: string[],
  style: MontageStyle,
  outputPath: string,
): Promise<boolean> {
  if (style.transition === "cut" || segmentPaths.length < 2) return false;

  const inputs = segmentPaths.flatMap((p) => ["-i", p]);
  const d = style.transitionSeconds;
  const steps: string[] = [];
  let current = "[0:v]";
  // Each xfade overlaps the pair by `d`, so the running length of everything
  // merged so far is (n * segment) - (transitions * d). The next offset is
  // that length minus one more transition.
  let elapsed = style.secondsPerPhoto;

  for (let i = 1; i < segmentPaths.length; i++) {
    const label = i === segmentPaths.length - 1 ? "[out]" : `[v${i}]`;
    const offset = Math.max(0, elapsed - d);
    steps.push(`${current}[${i}:v]xfade=transition=${style.transition}:duration=${d}:offset=${offset}${label}`);
    current = label;
    elapsed = offset + style.secondsPerPhoto;
  }

  try {
    await runFfmpeg([
      ...inputs,
      "-filter_complex", steps.join(";"),
      "-map", "[out]",
      "-r", String(MONTAGE_FPS),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-y", outputPath,
    ]);
    return true;
  } catch (err) {
    console.error("[video] xfade transitions unavailable, using hard cuts", err);
    return false;
  }
}

export interface PhotoMontageOptions {
  // In display order — first photo opens the video.
  photoPaths: string[];
  style: MontageStyle;
  outputPath: string;
}

// Total runtime of a montage, accounting for transition overlap. Callers
// need this to trim the music track to length.
export function montageDurationSeconds(photoCount: number, style: MontageStyle): number {
  const raw = photoCount * style.secondsPerPhoto;
  if (style.transition === "cut" || photoCount < 2) return raw;
  return raw - (photoCount - 1) * style.transitionSeconds;
}

// Compiles photos into one vertical video in the chosen style. Silent; mix
// music in separately via lib/music.ts#mixTrackIntoClip, which works on any
// video whether or not it already has an audio track.
export async function createPhotoMontage(options: PhotoMontageOptions): Promise<void> {
  const { style } = options;
  if (options.photoPaths.length === 0) throw new Error("No photos to compile");

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-montage-"));
  try {
    const segmentPaths: string[] = [];
    for (const [i, photoPath] of options.photoPaths.entries()) {
      const segPath = path.join(tmpDir, `seg-${i}.mp4`);
      await createPhotoSegment(photoPath, style, i, segPath);
      segmentPaths.push(segPath);
    }

    // Preferred path: real transitions between shots. Returns false on
    // ffmpeg builds without xfade (< 4.3), where we fall through to cuts.
    if (await concatWithTransitions(segmentPaths, style, options.outputPath)) {
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
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-y", options.outputPath,
    ]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
