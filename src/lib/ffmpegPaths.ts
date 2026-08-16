import { existsSync } from "node:fs";

// Single source of truth for the two external binaries/assets ffmpeg work
// needs. Both were previously hardcoded (and duplicated) as Windows dev-box
// paths in four different files — production Linux servers have neither.
//
// Resolution order is always: explicit env var → platform default → bare
// name and let PATH resolve it. Set FFMPEG_PATH / DRAWTEXT_FONT_FILE in
// production to skip the guessing entirely.

const WINDOWS_FFMPEG_FALLBACK = "C:\\Program Files\\ImageMagick-7.0.8-Q16\\ffmpeg.exe";
const LINUX_FFMPEG_FALLBACKS = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

export function resolveFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  if (process.platform === "win32" && existsSync(WINDOWS_FFMPEG_FALLBACK)) {
    return WINDOWS_FFMPEG_FALLBACK;
  }
  for (const candidate of LINUX_FFMPEG_FALLBACKS) {
    if (existsSync(candidate)) return candidate;
  }

  // Bare name — works anywhere ffmpeg is on PATH, which is the normal case
  // after `apt install ffmpeg`.
  return "ffmpeg";
}

const WINDOWS_FONT_FALLBACK = "C:\\Windows\\Fonts\\arial.ttf";
const LINUX_FONT_FALLBACKS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
];

// Used for burned-in captions on clips. Callers must tolerate this being
// wrong/missing — caption burn-in already falls back to a captionless
// render rather than failing the whole job.
export function resolveFontFile(): string {
  if (process.env.DRAWTEXT_FONT_FILE) return process.env.DRAWTEXT_FONT_FILE;

  if (process.platform === "win32") return WINDOWS_FONT_FALLBACK;
  for (const candidate of LINUX_FONT_FALLBACKS) {
    if (existsSync(candidate)) return candidate;
  }
  return WINDOWS_FONT_FALLBACK;
}
