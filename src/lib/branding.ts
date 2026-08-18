// Server-only: ffmpeg + network fetches. Never import from a "use client"
// component (see lib/music.ts for the same constraint).
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFfmpegPath, resolveFontFile } from "@/lib/ffmpegPaths";
import { VIDEO_FPS, intermediateEncode, deliveryEncode } from "@/lib/encoding";

const WIDTH = 1080;
const HEIGHT = 1920;
// Must stay identical to the montage frame rate — the bookend cards are
// concatenated with the montage, and mismatched rates yield a
// variable-frame-rate file that players scrub badly.
const FPS = VIDEO_FPS;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), args);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1200)}`)),
    );
  });
}

// Filter-arg escaping: see the same helper in lib/video.ts. Colons and
// backslashes are filtergraph syntax, so a Windows path breaks the graph
// unless it's converted and escaped.
function escapeForFilterArg(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function escapeDrawtextValue(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/%/g, "\\%").replace(/'/g, "");
}

export interface BrandAssets {
  logoUrl: string | null;
  brandColorsJson: string;
  businessName: string;
}

/** First brand colour, or a near-black default. ffmpeg wants 0xRRGGBB. */
function primaryColor(brandColorsJson: string): string {
  try {
    const colors = JSON.parse(brandColorsJson) as string[];
    const hex = colors.find((c) => /^#[0-9a-f]{6}$/i.test(c));
    if (hex) return `0x${hex.slice(1)}`;
  } catch {
    // Fall through to the default.
  }
  return "0x121212";
}

// Logos live at an arbitrary URL the client typed into their brand profile.
// Returns a local path, or null if it can't be fetched — every caller treats
// a missing logo as "skip branding" rather than an error, since a broken
// logo URL shouldn't fail a whole video render.
async function downloadLogo(logoUrl: string, intoDir: string): Promise<string | null> {
  try {
    const response = await fetch(logoUrl);
    if (!response.ok) {
      console.error("[branding] logo fetch failed", response.status, logoUrl);
      return null;
    }
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) {
      console.error("[branding] logo URL is not an image", type, logoUrl);
      return null;
    }
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    const logoPath = path.join(intoDir, `logo.${ext}`);
    await writeFile(logoPath, Buffer.from(await response.arrayBuffer()));
    return logoPath;
  } catch (err) {
    console.error("[branding] logo download error", err);
    return null;
  }
}

// A title card: brand-coloured background, logo centred, optional caption
// under it. Silent audio is added so it can concat with a video that has a
// music track — without a matching stream, concat drops audio entirely.
async function createBrandCard(opts: {
  logoPath: string;
  bgColor: string;
  caption: string | null;
  durationSeconds: number;
  outputPath: string;
}): Promise<void> {
  const { logoPath, bgColor, caption, durationSeconds, outputPath } = opts;

  // Logo fits inside a centred box at ~55% width, preserving aspect ratio.
  const filters = [
    `[1:v]scale=${Math.round(WIDTH * 0.55)}:-1:force_original_aspect_ratio=decrease[logo]`,
    `[0:v][logo]overlay=(W-w)/2:(H-h)/2-80[withlogo]`,
  ];

  let lastLabel = "withlogo";
  if (caption) {
    const text = escapeDrawtextValue(caption.slice(0, 60));
    filters.push(
      `[${lastLabel}]drawtext=fontfile=${escapeForFilterArg(resolveFontFile())}:text=${text}:fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h/2+180[out]`,
    );
    lastLabel = "out";
  }

  const args = [
    "-f", "lavfi", "-i", `color=c=${bgColor}:s=${WIDTH}x${HEIGHT}:d=${durationSeconds}:r=${FPS}`,
    "-loop", "1", "-i", logoPath,
    "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`,
    "-filter_complex", filters.join(";"),
    "-map", `[${lastLabel}]`,
    "-map", "2:a",
    "-t", String(durationSeconds),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    ...intermediateEncode(),
    "-c:a", "aac",
    "-r", String(FPS),
    "-y", outputPath,
  ];

  try {
    await runFfmpeg(args);
  } catch (err) {
    // drawtext needs a working font; some ffmpeg builds have a broken
    // fontconfig link (see lib/video.ts). Retry without the caption rather
    // than losing the card.
    if (!caption) throw err;
    console.error("[branding] card caption failed, rendering logo only", err);
    await createBrandCard({ ...opts, caption: null });
  }
}

export interface BookendOptions {
  intro: boolean;
  outro: boolean;
  outroText: string | null;
}

// Prepends an intro card and/or appends an outro card to a finished video.
// Returns the new bytes, or null when there's nothing to do (no logo, both
// disabled, or a render failure) so callers keep the original video.
//
// Call this BEFORE mixing music, so the track plays across the whole thing
// rather than starting after the logo.
export async function addBrandBookends(
  videoBuffer: Buffer,
  assets: BrandAssets,
  options: BookendOptions,
): Promise<Buffer<ArrayBuffer> | null> {
  if (!options.intro && !options.outro) return null;
  if (!assets.logoUrl) return null;

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-brand-"));
  try {
    const logoPath = await downloadLogo(assets.logoUrl, tmpDir);
    if (!logoPath) return null;

    const bgColor = primaryColor(assets.brandColorsJson);
    const videoPath = path.join(tmpDir, "main.mp4");
    await writeFile(videoPath, videoBuffer);

    // The main video may be silent (montages are, before music is mixed).
    // concat needs every segment to have the same streams, so give it a
    // silent track if it has none — otherwise the branded cards' audio
    // makes the stream layouts mismatch and concat fails.
    const normalizedPath = path.join(tmpDir, "main-norm.mp4");
    await runFfmpeg([
      "-i", videoPath,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map", "0:v",
      // Prefer the real audio when present; fall back to the silent source.
      "-map", "0:a?",
      "-map", "1:a",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      ...intermediateEncode(),
      "-c:a", "aac",
      "-r", String(FPS),
      "-shortest",
      "-y", normalizedPath,
    ]).catch(async () => {
      // If the dual-audio mapping isn't valid for this input, just re-encode
      // as-is; concat below will still work if streams happen to line up.
      await runFfmpeg([
        "-i", videoPath,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", ...intermediateEncode(), "-c:a", "aac",
        "-r", String(FPS), "-shortest", "-y", normalizedPath,
      ]);
    });

    const parts: string[] = [];

    if (options.intro) {
      const introPath = path.join(tmpDir, "intro.mp4");
      await createBrandCard({
        logoPath,
        bgColor,
        caption: null,
        durationSeconds: 1.5,
        outputPath: introPath,
      });
      parts.push(introPath);
    }

    parts.push(normalizedPath);

    if (options.outro) {
      const outroPath = path.join(tmpDir, "outro.mp4");
      await createBrandCard({
        logoPath,
        bgColor,
        caption: options.outroText?.trim() || assets.businessName,
        durationSeconds: 2,
        outputPath: outroPath,
      });
      parts.push(outroPath);
    }

    const listPath = path.join(tmpDir, "concat.txt");
    await writeFile(listPath, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf8");

    const outputPath = path.join(tmpDir, "branded.mp4");
    await runFfmpeg([
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      ...intermediateEncode(),
      "-c:a", "aac",
      "-r", String(FPS),
      "-y", outputPath,
    ]);

    return await readFile(outputPath);
  } catch (err) {
    console.error("[branding] Failed to add intro/outro, keeping original video", err);
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export interface WatermarkOptions {
  position: string;
  opacity: number;
}

function overlayPosition(position: string, margin = 40): string {
  switch (position) {
    case "bottom-left":
      return `${margin}:H-h-${margin}`;
    case "top-right":
      return `W-w-${margin}:${margin}`;
    case "top-left":
      return `${margin}:${margin}`;
    case "bottom-right":
    default:
      return `W-w-${margin}:H-h-${margin}`;
  }
}

// Burns the logo into a video (or a photo) at the chosen corner. Returns
// null on any failure so the caller keeps the unwatermarked original —
// a missing watermark is much better than a missing video.
export async function applyWatermark(
  mediaBuffer: Buffer,
  assets: BrandAssets,
  options: WatermarkOptions,
  kind: "video" | "photo",
): Promise<Buffer<ArrayBuffer> | null> {
  if (!assets.logoUrl) return null;

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-wm-"));
  try {
    const logoPath = await downloadLogo(assets.logoUrl, tmpDir);
    if (!logoPath) return null;

    const inputExt = kind === "video" ? "mp4" : "jpg";
    const inputPath = path.join(tmpDir, `in.${inputExt}`);
    await writeFile(inputPath, mediaBuffer);
    const outputPath = path.join(tmpDir, `out.${inputExt}`);

    const opacity = Math.min(1, Math.max(0.05, options.opacity));

    // Watermark spans ~22% of the FRAME's width — readable without
    // dominating. Sizing it relative to the logo's own width would be
    // meaningless, since the logo can be any resolution.
    //
    // scale2ref scales its FIRST input using the second as the reference,
    // and returns them in that same order. Getting this backwards silently
    // rescales the video to the logo's size instead: a 1080x1920 vertical
    // montage came out 800x600. Logo first, video second.
    const filtersScale2Ref = [
      `[1:v]format=rgba,colorchannelmixer=aa=${opacity}[wmraw]`,
      `[wmraw][0:v]scale2ref=w=iw*0.22:h=ow/mdar[wm][base]`,
      `[base][wm]overlay=${overlayPosition(options.position)}`,
    ].join(";");

    // Fallback for builds where scale2ref was removed (ffmpeg 7+). Our
    // generated videos are always 1080 wide, so a fixed 22% of that is
    // equivalent; explicitly re-asserting the frame size guards against the
    // overlay changing it.
    const filtersFixed = [
      `[1:v]scale=238:-1,format=rgba,colorchannelmixer=aa=${opacity}[wm]`,
      `[0:v][wm]overlay=${overlayPosition(options.position)}`,
    ].join(";");

    // Watermarking is the last pass in the montage/clip chain, so this is the
    // file a client downloads — encode it at delivery quality with the moov
    // atom up front. Audio is copied, not re-encoded: it was already muxed by
    // the music step and a second aac pass would only lose more.
    const videoOut = ["-c:v", "libx264", "-pix_fmt", "yuv420p", ...deliveryEncode(), "-c:a", "copy"];
    const photoOut = ["-q:v", "3"];
    const outArgs = kind === "video" ? videoOut : photoOut;

    try {
      await runFfmpeg(["-i", inputPath, "-i", logoPath, "-filter_complex", filtersScale2Ref, ...outArgs, "-y", outputPath]);
    } catch {
      await runFfmpeg(["-i", inputPath, "-i", logoPath, "-filter_complex", filtersFixed, ...outArgs, "-y", outputPath]);
    }

    return await readFile(outputPath);
  } catch (err) {
    console.error("[branding] Failed to apply watermark, keeping original", err);
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
