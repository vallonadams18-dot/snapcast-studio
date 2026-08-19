// Manual event-media upload validation. The same rule as webhooks (WH-2) and
// the Brand Kit: the LEADING BYTES decide what a file is. Filename,
// extension, and the browser-supplied MIME type are never trusted — a valid
// MP4 that arrives as application/octet-stream is still a video, and an HTML
// file named .mp4 is still not.
//
// This was the root cause of "video upload doesn't work": mediaType used to
// come from file.type, so any picker that sent a generic MIME produced a
// Media row typed "photo" — which the grid renders as a broken image and the
// video editor never sees.
import { detectMediaType, MAX_SNIFF_BYTES, type DetectedType } from "./webhooks/safeDownload.ts";

// Deliberately aligned with the platforms this footage is destined for:
// TikTok's iPhone app caps uploads at ~288MB and Instagram's API ceiling is
// 300MB, so 300MB accepts anything a phone would hand those apps. It is
// also the most this droplet can safely buffer per upload (2GB RAM, whole
// file held in memory during validation) — raising it further needs a
// streaming-ingest rework, not just a bigger number. Mirrored client-side
// in UploadForm for instant feedback; nginx client_max_body_size must stay
// above it (see deploy/nginx-snapcast.conf, 350M).
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

export type EventUploadVerdict =
  | { ok: true; detected: DetectedType }
  | { ok: false; error: string };

export function validateEventUpload(head: Uint8Array, totalBytes: number): EventUploadVerdict {
  if (totalBytes <= 0) return { ok: false, error: "The file is empty." };
  if (totalBytes > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `File is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB).` };
  }

  const detected = detectMediaType(head.subarray(0, MAX_SNIFF_BYTES));
  if (detected) return { ok: true, detected };

  // Recognise the HEIC/HEIF/AVIF family well enough to explain it. iPhones
  // convert to JPEG on web upload by default, but "Keep Originals" users
  // will hit this — a targeted message beats a generic rejection.
  if (head.length >= 12) {
    const ftyp = String.fromCharCode(...head.subarray(4, 8));
    const brand = String.fromCharCode(...head.subarray(8, 12)).toLowerCase();
    if (ftyp === "ftyp" && /^(hei|hev|mif|msf|avif|avis)/.test(brand)) {
      return {
        ok: false,
        error:
          "iPhone HEIC/HEIF photos aren't supported yet. In Settings → Camera → Formats choose \"Most Compatible\", or share the photo as a JPEG.",
      };
    }
  }

  return {
    ok: false,
    error: "That file doesn't look like a photo or video we can use. Use JPEG, PNG, WebP images or MP4, MOV, WebM videos.",
  };
}

/**
 * The name a stored upload should carry: the client's base name (sanitised
 * later by randomFileKey) with the extension REPLACED by the one derived
 * from the detected bytes. A PNG named "clip.mp4" stores as .png, so the
 * web server serves it with the content type it really has.
 */
export function keyNameWithDetectedExtension(originalName: string, extension: string): string {
  const base = originalName.replace(/\.[^.]*$/, "").trim() || "upload";
  return `${base}.${extension}`;
}
