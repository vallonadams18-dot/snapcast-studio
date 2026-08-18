// Brand Kit upload validation — run with:
//   npm run test:brand
// Validation must judge LEADING BYTES only; filename, extension, and client
// MIME type never reach validateBrandUpload at all, which is itself the
// strongest proof they aren't trusted.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateBrandUpload,
  brandAssetKey,
  isBrandSlot,
  maxBytesForSlot,
  LOGO_MAX_BYTES,
  BOOKEND_IMAGE_MAX_BYTES,
  BOOKEND_VIDEO_MAX_BYTES,
} from "./brandAssets.ts";

const enc = new TextEncoder();

/** Pad a header out so short-head heuristics can't interfere. */
function pad(bytes: number[] | Uint8Array, length = 4096): Uint8Array {
  const out = new Uint8Array(length);
  out.set(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes), 0);
  return out;
}

const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = pad([...enc.encode("RIFF"), 0x24, 0x00, 0x00, 0x00, ...enc.encode("WEBP")]);
const GIF = pad(enc.encode("GIF89a"));
// Structurally valid 24-byte ftyp box, brand isom.
const MP4 = pad([
  0x00, 0x00, 0x00, 0x18, ...enc.encode("ftyp"), ...enc.encode("isom"),
  0x00, 0x00, 0x02, 0x00, ...enc.encode("iso2"),
]);
// 16-byte ftyp box, brand "qt  " (QuickTime/MOV).
const MOV = pad([0x00, 0x00, 0x00, 0x10, ...enc.encode("ftyp"), ...enc.encode("qt  "), 0x00, 0x00, 0x00, 0x00]);
// Structurally valid EBML header with webm DocType (mirrors safeDownload tests).
const WEBM = pad([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...enc.encode("webm")]);
const HTML = pad(enc.encode("<!doctype html><html>"));

test("logo accepts PNG, JPEG, and WebP", () => {
  for (const head of [PNG, JPEG, WEBP]) {
    const verdict = validateBrandUpload("logo", head, 1000);
    assert.equal(verdict.ok, true);
  }
  const png = validateBrandUpload("logo", PNG, 1000);
  assert.ok(png.ok && png.detected.contentType === "image/png");
});

test("logo rejects GIF, video, HTML, and empty files", () => {
  for (const head of [GIF, MP4, MOV, WEBM, HTML]) {
    assert.equal(validateBrandUpload("logo", head, 1000).ok, false);
  }
  assert.equal(validateBrandUpload("logo", PNG, 0).ok, false);
});

test("logo enforces its size cap against the real byte count", () => {
  assert.equal(validateBrandUpload("logo", PNG, LOGO_MAX_BYTES).ok, true);
  assert.equal(validateBrandUpload("logo", PNG, LOGO_MAX_BYTES + 1).ok, false);
});

test("intro/outro accept images and videos with per-kind caps", () => {
  for (const slot of ["intro", "outro"] as const) {
    for (const head of [PNG, JPEG, WEBP]) {
      const v = validateBrandUpload(slot, head, 1000);
      assert.ok(v.ok && v.detected.kind === "photo");
    }
    for (const head of [MP4, MOV, WEBM]) {
      const v = validateBrandUpload(slot, head, 1000);
      assert.ok(v.ok && v.detected.kind === "video");
    }
    // An image is held to the image cap even though the slot allows videos
    // that are far larger.
    assert.equal(validateBrandUpload(slot, PNG, BOOKEND_IMAGE_MAX_BYTES + 1).ok, false);
    assert.equal(validateBrandUpload(slot, MP4, BOOKEND_VIDEO_MAX_BYTES).ok, true);
    assert.equal(validateBrandUpload(slot, MP4, BOOKEND_VIDEO_MAX_BYTES + 1).ok, false);
  }
});

test("intro/outro reject GIF and unrecognised bytes", () => {
  assert.equal(validateBrandUpload("intro", GIF, 1000).ok, false);
  assert.equal(validateBrandUpload("outro", HTML, 1000).ok, false);
});

test("detected type comes from bytes, not any declared name", () => {
  // The same bytes always classify the same way — there is no filename or
  // MIME parameter to lie through.
  const v = validateBrandUpload("intro", MOV, 1000);
  assert.ok(v.ok && v.detected.contentType === "video/quicktime" && v.detected.extension === "mov");
});

test("brandAssetKey is namespaced, unique per call, and sanitised", () => {
  const a = brandAssetKey("acct123", "logo", "png");
  const b = brandAssetKey("acct123", "logo", "png");
  assert.ok(a.startsWith("brand/acct123/logo-"));
  assert.ok(a.endsWith(".png"));
  assert.notEqual(a, b); // replacing never overwrites the previous bytes

  // Hostile account id / extension cannot steer the path.
  const evil = brandAssetKey("../../etc", "outro", "../png");
  assert.ok(!evil.includes(".."));
  assert.ok(evil.startsWith("brand/etc/outro-"));
});

test("slot guard and pre-buffer size gate", () => {
  assert.equal(isBrandSlot("logo"), true);
  assert.equal(isBrandSlot("intro"), true);
  assert.equal(isBrandSlot("outro"), true);
  assert.equal(isBrandSlot("banner"), false);
  assert.equal(isBrandSlot(null), false);
  assert.equal(maxBytesForSlot("logo"), LOGO_MAX_BYTES);
  assert.equal(maxBytesForSlot("intro"), BOOKEND_VIDEO_MAX_BYTES);
});
