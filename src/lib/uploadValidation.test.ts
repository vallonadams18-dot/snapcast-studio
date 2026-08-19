// Event-media upload validation — run with:
//   npm run test:upload
// These are the tests that would have caught the original "video upload
// doesn't work" defect: classification comes from real file bytes, so the
// fixtures are REAL tiny media files (see __fixtures__/), not hand-rolled
// buffers pretending to be video. The client MIME type does not appear in
// this suite at all — which is the point: it must not matter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  validateEventUpload,
  keyNameWithDetectedExtension,
  MAX_UPLOAD_BYTES,
} from "./uploadValidation.ts";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "__fixtures__", name));

const MP4 = fixture("tiny.mp4");
const MOV = fixture("tiny.mov");
const WEBM = fixture("tiny.webm");
const JPG = fixture("tiny.jpg");

test("a real MP4 is a video regardless of what any client claimed", () => {
  const v = validateEventUpload(MP4, MP4.byteLength);
  assert.ok(v.ok);
  assert.equal(v.detected.kind, "video");
  assert.equal(v.detected.contentType, "video/mp4");
  assert.equal(v.detected.extension, "mp4");
});

test("a real MOV (the iPhone container) is a video", () => {
  const v = validateEventUpload(MOV, MOV.byteLength);
  assert.ok(v.ok);
  assert.equal(v.detected.kind, "video");
  assert.equal(v.detected.contentType, "video/quicktime");
});

test("a real WebM is a video", () => {
  const v = validateEventUpload(WEBM, WEBM.byteLength);
  assert.ok(v.ok && v.detected.kind === "video");
});

test("a real JPEG is a photo", () => {
  const v = validateEventUpload(JPG, JPG.byteLength);
  assert.ok(v.ok);
  assert.equal(v.detected.kind, "photo");
});

test("HTML named .mp4 is rejected — bytes, not names, decide", () => {
  const fake = Buffer.from("<!doctype html><script>alert(1)</script>");
  const v = validateEventUpload(fake, fake.byteLength);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /photo or video/);
});

test("truncated MP4 head (bare short ftyp fragment) is rejected", () => {
  // 8 bytes of a declared 24-byte ftyp box — WH-2's structural rule refuses
  // to classify a box that is not fully present.
  const truncated = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const v = validateEventUpload(truncated, truncated.byteLength);
  assert.equal(v.ok, false);
});

test("HEIC gets a targeted, actionable error", () => {
  const heic = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypheic"),
    Buffer.alloc(16),
  ]);
  const v = validateEventUpload(heic, heic.byteLength);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /HEIC/);
});

test("empty and oversized files are rejected; the boundary is inclusive", () => {
  assert.equal(validateEventUpload(MP4, 0).ok, false);
  assert.equal(validateEventUpload(MP4, MAX_UPLOAD_BYTES).ok, true);
  const over = validateEventUpload(MP4, MAX_UPLOAD_BYTES + 1);
  assert.equal(over.ok, false);
  assert.match((over as { error: string }).error, /too large/);
});

test("stored extension follows detection, never the filename", () => {
  assert.equal(keyNameWithDetectedExtension("clip.MOV", "mp4"), "clip.mp4");
  assert.equal(keyNameWithDetectedExtension("photo.exe", "png"), "photo.png");
  assert.equal(keyNameWithDetectedExtension("no-extension", "mov"), "no-extension.mov");
  assert.equal(keyNameWithDetectedExtension(".mp4", "mp4"), "upload.mp4");
  assert.equal(keyNameWithDetectedExtension("my cool vidéo (1).mp4", "mp4"), "my cool vidéo (1).mp4");
});
