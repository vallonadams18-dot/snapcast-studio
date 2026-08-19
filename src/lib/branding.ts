// Server-only: ffmpeg + network fetches. Never import from a "use client"
// component (see lib/music.ts for the same constraint).
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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
  /** Legacy customer-hosted logo URL (the old text-field workflow). */
  logoUrl: string | null;
  /**
   * Storage ref for a logo uploaded through the Brand Kit — a disk path for
   * local storage, an absolute URL for S3/R2. Wins over logoUrl when set.
   */
  logoStorageRef: string | null;
  brandColorsJson: string;
  businessName: string;
}

export function hasAnyLogo(assets: BrandAssets): boolean {
  return Boolean(assets.logoStorageRef || assets.logoUrl);
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

// The logo the render should actually use: the Brand-Kit-uploaded asset when
// present (read straight from disk locally, fetched from our own bucket for
// S3/R2), falling back to the legacy customer-hosted URL. A stored asset
// that has gone missing falls back too, rather than failing the render.
async function resolveLogo(assets: BrandAssets, intoDir: string): Promise<string | null> {
  if (assets.logoStorageRef) {
    if (/^https?:\/\//i.test(assets.logoStorageRef)) {
      const downloaded = await downloadLogo(assets.logoStorageRef, intoDir);
      if (downloaded) return downloaded;
    } else {
      try {
        await access(assets.logoStorageRef);
        return assets.logoStorageRef;
      } catch {
        console.error("[branding] stored logo missing on disk, falling back", assets.logoStorageRef);
      }
    }
  }
  if (assets.logoUrl) return downloadLogo(assets.logoUrl, intoDir);
  return null;
}

// Blurred-fill framing shared by uploaded intro/outro media: whatever the
// source aspect (portrait, landscape, square), the frame is filled with a
// blurred cover-scaled copy and the media itself is fitted inside untouched.
// Mirrors the montage's fallback framing so bookends match the body visually.
const BLURRED_FIT =
  `split=2[bk_bg][bk_fg];` +
  `[bk_bg]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=luma_radius=32:luma_power=2[bk_bgb];` +
  `[bk_fg]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[bk_fgs];` +
  `[bk_bgb][bk_fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`;

// How long uploaded IMAGE bookends hold on screen. Video bookends keep their
// own length, capped so a long clip can't swallow the actual event video.
const IMAGE_INTRO_SECONDS = 2;
const IMAGE_OUTRO_SECONDS = 2.5;
const VIDEO_BOOKEND_MAX_SECONDS = 6;

// An uploaded intro/outro IMAGE, framed blurred-fit with a slow push-in so
// the card breathes instead of sitting frozen — a static opening frame reads
// as a rendering glitch on a social feed.
async function createImageBookend(opts: {
  imagePath: string;
  durationSeconds: number;
  outputPath: string;
}): Promise<void> {
  const { imagePath, durationSeconds, outputPath } = opts;
  const frames = Math.max(2, Math.round(durationSeconds * FPS));
  // Transparent PNGs must be flattened onto a solid base: video has no
  // alpha channel, so any pixel left transparent would composite to BLACK
  // at the final yuv420p conversion — a client's transparent-background
  // logo card rendered with black blotches. Compose the blurred-fit frame
  // in rgba, then lay the whole thing over white before scaling/motion.
  const flatten =
    `color=c=white:s=${WIDTH}x${HEIGHT}[bk_base];` +
    `[0:v]format=rgba,${BLURRED_FIT}[bk_comp];` +
    `[bk_base][bk_comp]overlay=shortest=1`;
  // Compose the framed still, oversample it, then let zoompan run a gentle
  // 6% push-in across the whole hold. The 2x oversample keeps zoompan's
  // moving crop window from stair-stepping.
  const motionGraph =
    `${flatten},scale=${WIDTH * 2}:${HEIGHT * 2},` +
    `zoompan=z='1+0.06*on/${frames - 1}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}[v]`;
  const staticGraph = `${flatten}[v]`;

  const build = (graph: string, still: boolean) => [
    // The motion graph feeds zoompan ONE frame and lets it generate the
    // sequence; the static fallback loops the image for the duration.
    ...(still ? ["-loop", "1"] : []),
    "-i", imagePath,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-filter_complex", graph,
    "-map", "[v]",
    "-map", "1:a",
    "-t", String(durationSeconds),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    ...intermediateEncode(),
    "-c:a", "aac",
    "-r", String(FPS),
    "-y", outputPath,
  ];

  try {
    await runFfmpeg(build(motionGraph, false));
  } catch (err) {
    // Some ffmpeg builds choke on parts of the motion graph; a static
    // blurred-fit card is still far better than dropping the intro.
    console.error("[branding] image bookend motion failed, rendering static", err);
    await runFfmpeg(build(staticGraph, true));
  }
}

// An uploaded intro/outro VIDEO, normalised to the montage geometry
// (1080x1920, 30fps, H.264/yuv420p, blurred-fit) and length-capped.
//
// AUDIO DECISION — the bookend's native audio is REPLACED with silence, on
// purpose. Bookends are concatenated BEFORE the music mix, and the mixer
// (mixTrackIntoClip) maps `-map 0:v -map "[aout]"` — the licensed track
// replaces the ENTIRE audio bed, so native intro audio could never survive a
// successful mix anyway. And when no music mixes (provider down, licence
// 402), the montage body is silent — a lone burst of intro sound followed by
// silence reads as broken. Silence everywhere is the consistent behaviour.
async function createVideoBookend(opts: { videoPath: string; outputPath: string }): Promise<void> {
  const { videoPath, outputPath } = opts;
  await runFfmpeg([
    "-i", videoPath,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-filter_complex", `[0:v]${BLURRED_FIT}[v]`,
    "-map", "[v]",
    "-map", "1:a",
    "-t", String(VIDEO_BOOKEND_MAX_SECONDS),
    // anullsrc is infinite; end with the (capped) video, whichever is shorter.
    "-shortest",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    ...intermediateEncode(),
    "-c:a", "aac",
    "-r", String(FPS),
    "-y", outputPath,
  ]);
}

export interface BookendMedia {
  /** "none" | "image" | "video" — Account.introKind / Account.outroKind. */
  kind: string;
  /** Storage ref of the uploaded asset — disk path locally, URL on S3/R2. */
  storageRef: string | null;
}

// The uploaded bookend source as a local file ffmpeg can read: the disk path
// itself for local storage, downloaded into the temp dir for S3/R2.
async function resolveBookendMedia(
  media: BookendMedia | undefined,
  intoDir: string,
  name: string,
): Promise<string | null> {
  if (!media || media.kind === "none" || !media.storageRef) return null;
  if (/^https?:\/\//i.test(media.storageRef)) {
    try {
      const response = await fetch(media.storageRef);
      if (!response.ok) {
        console.error("[branding] bookend media fetch failed", response.status, name);
        return null;
      }
      const filePath = path.join(intoDir, `${name}-src`);
      await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
      return filePath;
    } catch (err) {
      console.error("[branding] bookend media download error", name, err);
      return null;
    }
  }
  try {
    await access(media.storageRef);
    return media.storageRef;
  } catch {
    console.error("[branding] bookend media missing on disk", name, media.storageRef);
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
  /** Legacy generated-card toggles — used only when no media is uploaded. */
  intro: boolean;
  outro: boolean;
  outroText: string | null;
  /** Uploaded Brand Kit intro/outro media. Wins over the card toggles. */
  introMedia?: BookendMedia;
  outroMedia?: BookendMedia;
}

// Prepends an intro and/or appends an outro to a finished video. Each side
// independently resolves to: uploaded media (image or video) when the Brand
// Kit has one; else the legacy generated logo card when its toggle is on and
// a logo exists; else nothing. Returns the new bytes, or null when there's
// nothing to do (or a render failure) so callers keep the original video.
//
// Call this BEFORE mixing music, so the track plays across the whole thing
// rather than starting after the intro.
export async function addBrandBookends(
  videoBuffer: Buffer,
  assets: BrandAssets,
  options: BookendOptions,
): Promise<Buffer<ArrayBuffer> | null> {
  const wantsIntroMedia = Boolean(
    options.introMedia && options.introMedia.kind !== "none" && options.introMedia.storageRef,
  );
  const wantsOutroMedia = Boolean(
    options.outroMedia && options.outroMedia.kind !== "none" && options.outroMedia.storageRef,
  );
  const wantsIntroCard = !wantsIntroMedia && options.intro;
  const wantsOutroCard = !wantsOutroMedia && options.outro;
  if (!wantsIntroMedia && !wantsOutroMedia && !wantsIntroCard && !wantsOutroCard) return null;

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-brand-"));
  try {
    // Cards need the logo; uploaded media does not. When ONLY cards are
    // wanted and no logo resolves, bail before paying for the re-encode.
    let logoPath: string | null = null;
    if (wantsIntroCard || wantsOutroCard) {
      logoPath = await resolveLogo(assets, tmpDir);
      if (!logoPath && !wantsIntroMedia && !wantsOutroMedia) return null;
    }

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

    if (wantsIntroMedia) {
      const src = await resolveBookendMedia(options.introMedia, tmpDir, "intro");
      if (src) {
        const introPath = path.join(tmpDir, "intro.mp4");
        try {
          if (options.introMedia!.kind === "video") {
            await createVideoBookend({ videoPath: src, outputPath: introPath });
          } else {
            await createImageBookend({
              imagePath: src,
              durationSeconds: IMAGE_INTRO_SECONDS,
              outputPath: introPath,
            });
          }
          parts.push(introPath);
        } catch (err) {
          // A broken uploaded file should cost the intro, not the render.
          console.error("[branding] intro media render failed, skipping intro", err);
        }
      }
    } else if (wantsIntroCard && logoPath) {
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

    if (wantsOutroMedia) {
      const src = await resolveBookendMedia(options.outroMedia, tmpDir, "outro");
      if (src) {
        const outroPath = path.join(tmpDir, "outro.mp4");
        try {
          if (options.outroMedia!.kind === "video") {
            await createVideoBookend({ videoPath: src, outputPath: outroPath });
          } else {
            await createImageBookend({
              imagePath: src,
              durationSeconds: IMAGE_OUTRO_SECONDS,
              outputPath: outroPath,
            });
          }
          parts.push(outroPath);
        } catch (err) {
          console.error("[branding] outro media render failed, skipping outro", err);
        }
      }
    } else if (wantsOutroCard && logoPath) {
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

    // Every wanted bookend failed to materialise — keep the original.
    if (parts.length === 1) return null;

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
  /** Watermark width as a fraction of the frame width. Default 0.22. */
  scale?: number;
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
  if (!hasAnyLogo(assets)) return null;

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-wm-"));
  try {
    const logoPath = await resolveLogo(assets, tmpDir);
    if (!logoPath) return null;

    const inputExt = kind === "video" ? "mp4" : "jpg";
    const inputPath = path.join(tmpDir, `in.${inputExt}`);
    await writeFile(inputPath, mediaBuffer);
    const outputPath = path.join(tmpDir, `out.${inputExt}`);

    const opacity = Math.min(1, Math.max(0.05, options.opacity));
    // Fraction of the FRAME's width the watermark spans — readable without
    // dominating. Sizing it relative to the logo's own width would be
    // meaningless, since the logo can be any resolution. Clamped so neither
    // an invisible sliver nor a half-frame billboard can be configured.
    const scale = Math.min(0.4, Math.max(0.1, options.scale ?? 0.22));

    // scale2ref scales its FIRST input using the second as the reference,
    // and returns them in that same order. Getting this backwards silently
    // rescales the video to the logo's size instead: a 1080x1920 vertical
    // montage came out 800x600. Logo first, video second.
    const filtersScale2Ref = [
      `[1:v]format=rgba,colorchannelmixer=aa=${opacity}[wmraw]`,
      `[wmraw][0:v]scale2ref=w=iw*${scale}:h=ow/mdar[wm][base]`,
      `[base][wm]overlay=${overlayPosition(options.position)}`,
    ].join(";");

    // Fallback for builds where scale2ref was removed (ffmpeg 7+). Our
    // generated videos are always 1080 wide, so a fixed fraction of that is
    // equivalent; explicitly re-asserting the frame size guards against the
    // overlay changing it.
    const filtersFixed = [
      `[1:v]scale=${Math.round(WIDTH * scale)}:-1,format=rgba,colorchannelmixer=aa=${opacity}[wm]`,
      `[0:v][wm]overlay=${overlayPosition(options.position)}`,
    ].join(";");

    // Watermarking is the last pass in the montage/clip chain, so this is the
    // file a client downloads — encode it at delivery quality with the moov
    // atom up front. Audio is copied, not re-encoded: it was already muxed by
    // the music step and a second aac pass would only lose more.
    // -r is REQUIRED here, not decoration. The logo is a still image, and
    // ffmpeg's image demuxer defaults to 25fps; because scale2ref puts the
    // logo chain first in the graph, the overlay output negotiated to the
    // logo's 25 rather than the video's 30. Every earlier stage delivered 30
    // and this one silently dropped it, so a watermarked montage shipped at
    // 25fps — measured 30/30/30/25 across the pipeline before this line.
    const videoOut = [
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-r", String(FPS),
      ...deliveryEncode(),
      "-c:a", "copy",
    ];
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
