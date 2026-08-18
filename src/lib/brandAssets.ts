// Brand Kit asset uploads: validation and storage-key rules for the logo,
// intro, and outro media a client uploads directly from their device.
//
// Validation NEVER trusts the filename, the extension, or the client-supplied
// MIME type — only the leading bytes, via the same structural magic-byte
// classifier the webhook downloader uses (src/lib/webhooks/safeDownload.ts).
import { randomUUID } from "node:crypto";
import { detectMediaType, MAX_SNIFF_BYTES, type DetectedType } from "./webhooks/safeDownload.ts";

export const BRAND_SLOTS = ["logo", "intro", "outro"] as const;
export type BrandSlot = (typeof BRAND_SLOTS)[number];

export function isBrandSlot(value: unknown): value is BrandSlot {
  return typeof value === "string" && (BRAND_SLOTS as readonly string[]).includes(value);
}

// Caps are per-asset, enforced against the REAL byte count, not any header.
// A logo is a small graphic; a bookend video only ever contributes a few
// seconds of screen time, so 120MiB is already generous for phone footage.
export const LOGO_MAX_BYTES = 8 * 1024 * 1024;
export const BOOKEND_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const BOOKEND_VIDEO_MAX_BYTES = 120 * 1024 * 1024;

// The logo must support transparency-capable formats the watermark/card
// pipeline can composite: PNG (the recommendation), JPEG, WebP. GIF is
// detectable but rejected everywhere — an animated logo watermark renders as
// its first frame only, which reads as a bug, not a feature.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export function maxBytesForSlot(slot: BrandSlot): number {
  // The pre-buffer gate: the largest a file for this slot could legally be.
  // Kind-specific caps are re-checked after detection.
  return slot === "logo" ? LOGO_MAX_BYTES : BOOKEND_VIDEO_MAX_BYTES;
}

export type BrandUploadVerdict =
  | { ok: true; detected: DetectedType }
  | { ok: false; error: string };

export function validateBrandUpload(
  slot: BrandSlot,
  head: Uint8Array,
  totalBytes: number,
): BrandUploadVerdict {
  if (totalBytes <= 0) return { ok: false, error: "The file is empty." };

  const detected = detectMediaType(head.subarray(0, MAX_SNIFF_BYTES));
  if (!detected) {
    return {
      ok: false,
      error:
        slot === "logo"
          ? "That doesn't look like an image. Use a PNG, JPEG, or WebP file."
          : "That doesn't look like a photo or video. Use PNG, JPEG, WebP, MP4, MOV, or WebM.",
    };
  }

  if (slot === "logo") {
    if (!IMAGE_TYPES.has(detected.contentType)) {
      return { ok: false, error: "Logos must be a PNG, JPEG, or WebP image. A PNG with a transparent background works best." };
    }
    if (totalBytes > LOGO_MAX_BYTES) {
      return { ok: false, error: `That logo is too large — keep it under ${LOGO_MAX_BYTES / (1024 * 1024)}MB.` };
    }
    return { ok: true, detected };
  }

  if (detected.kind === "photo") {
    if (!IMAGE_TYPES.has(detected.contentType)) {
      return { ok: false, error: "GIFs aren't supported here. Use a PNG, JPEG, WebP image or an MP4/MOV video." };
    }
    if (totalBytes > BOOKEND_IMAGE_MAX_BYTES) {
      return { ok: false, error: `That image is too large — keep it under ${BOOKEND_IMAGE_MAX_BYTES / (1024 * 1024)}MB.` };
    }
    return { ok: true, detected };
  }

  if (!VIDEO_TYPES.has(detected.contentType)) {
    return { ok: false, error: "Use an MP4, MOV, or WebM video." };
  }
  if (totalBytes > BOOKEND_VIDEO_MAX_BYTES) {
    return { ok: false, error: `That video is too large — keep it under ${BOOKEND_VIDEO_MAX_BYTES / (1024 * 1024)}MB.` };
  }
  return { ok: true, detected };
}

/**
 * Storage key for a brand asset. ALWAYS unique per upload — replacing a logo
 * writes a new key rather than overwriting the old bytes, so a render that is
 * mid-flight reading the previous file can never observe a half-written
 * replacement, and nothing an older render referenced is ever touched.
 * Old files are deliberately never deleted (see the brand-asset route).
 */
export function brandAssetKey(accountId: string, slot: BrandSlot, extension: string): string {
  // Account ids are cuids (alphanumeric), but the key must be safe even if
  // that ever changes — strip anything that could influence the path.
  const safeAccount = accountId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeExt = extension.replace(/[^a-z0-9]/gi, "");
  return `brand/${safeAccount}/${slot}-${Date.now()}-${randomUUID().slice(0, 8)}.${safeExt}`;
}
