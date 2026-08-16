import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAnthropicClient } from "@/lib/ai";
import { resolveFfmpegPath, resolveFontFile } from "@/lib/ffmpegPaths";

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

const MONTAGE_FPS = 25;

// One photo → one short vertical clip with a slow Ken Burns zoom. Falls
// back to a plain static-frame segment if zoompan misbehaves on this
// ffmpeg build (same defensive pattern as the drawtext fallback above) —
// a slideshow with hard cuts still beats losing the whole feature.
async function createPhotoSegment(photoPath: string, secondsPerPhoto: number, outputPath: string): Promise<void> {
  const frameCount = Math.round(secondsPerPhoto * MONTAGE_FPS);
  const kenBurnsFilter = [
    ...CROP_FILTERS,
    `zoompan=z='min(zoom+0.0012,1.12)':d=${frameCount}:s=1080x1920:fps=${MONTAGE_FPS}`,
  ].join(",");

  const inputArgs = ["-loop", "1", "-i", photoPath, "-t", String(secondsPerPhoto)];
  const outputArgs = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", outputPath];

  try {
    await runFfmpeg([...inputArgs, "-vf", kenBurnsFilter, ...outputArgs]);
  } catch {
    await runFfmpeg([...inputArgs, "-vf", CROP_FILTERS.join(","), ...outputArgs]);
  }
}

// Exported so callers elsewhere (e.g. re-mixing audio on an existing
// montage) can compute its total duration without re-deriving this number.
export const DEFAULT_MONTAGE_SECONDS_PER_PHOTO = 2.5;

export interface PhotoMontageOptions {
  // In display order — first photo opens the video.
  photoPaths: string[];
  secondsPerPhoto?: number;
  outputPath: string;
}

// Compiles several photos into one vertical video with a Ken Burns zoom per
// photo and hard cuts between them — the same shape as an Instagram/TikTok
// photo-slideshow post. Silent; mix in music separately via
// lib/music.ts#mixTrackIntoClip, which works on any video regardless of
// whether it already has an audio track.
export async function createPhotoMontage(options: PhotoMontageOptions): Promise<void> {
  const secondsPerPhoto = options.secondsPerPhoto ?? DEFAULT_MONTAGE_SECONDS_PER_PHOTO;
  if (options.photoPaths.length === 0) throw new Error("No photos to compile");

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-montage-"));
  try {
    const segmentPaths: string[] = [];
    for (const [i, photoPath] of options.photoPaths.entries()) {
      const segPath = path.join(tmpDir, `seg-${i}.mp4`);
      await createPhotoSegment(photoPath, secondsPerPhoto, segPath);
      segmentPaths.push(segPath);
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
