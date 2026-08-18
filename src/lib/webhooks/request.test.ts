// Focused tests for the webhook intake boundary. Run with:
//   npm run test:webhooks
// Uses Node's built-in test runner — no test framework dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  MAX_WEBHOOK_BODY_BYTES,
  readBoundedJsonBody,
  decodeUtf8Strict,
  verifyWebhookSignature,
} from "./request.ts";

const JSON_HEADERS = { "content-type": "application/json" };

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

/** A Request whose body is a stream, so no auto Content-Length is attached. */
function streamedRequest(chunks: Uint8Array[], headers: Record<string, string> = JSON_HEADERS): Request {
  return new Request("http://localhost/api/webhooks/x", {
    method: "POST",
    headers,
    body: streamOf(...chunks),
    // Node's fetch requires this for stream bodies; not yet in TS lib types.
    ...({ duplex: "half" } as object),
  });
}

const enc = new TextEncoder();

test("valid JSON below the limit passes through byte-exact", async () => {
  const payload = enc.encode(JSON.stringify({ mediaUrl: "https://example.com/a.jpg" }));
  const result = await readBoundedJsonBody(streamedRequest([payload]));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.bytes, payload);
});

test("exactly 65,536 bytes is accepted", async () => {
  const body = new Uint8Array(MAX_WEBHOOK_BODY_BYTES).fill(0x61);
  const result = await readBoundedJsonBody(streamedRequest([body]));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.bytes.byteLength, MAX_WEBHOOK_BODY_BYTES);
});

test("65,537 bytes is rejected 413", async () => {
  const body = new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 1).fill(0x61);
  const result = await readBoundedJsonBody(streamedRequest([body]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 413);
});

test("oversized Content-Length is rejected before the body is touched", async () => {
  // Duck-typed: a .body getter that throws proves the stream is never read.
  const fake = {
    headers: new Headers({ ...JSON_HEADERS, "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) }),
    get body(): ReadableStream<Uint8Array> | null {
      throw new Error("body must not be read when Content-Length already exceeds the cap");
    },
  } as unknown as Request;
  const result = await readBoundedJsonBody(fake);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 413);
});

test("chunked body crossing the limit is rejected mid-stream", async () => {
  const chunk = new Uint8Array(16 * 1024).fill(0x62);
  // 5 x 16 KiB = 80 KiB, delivered incrementally with no Content-Length.
  const result = await readBoundedJsonBody(streamedRequest([chunk, chunk, chunk, chunk, chunk]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 413);
});

test("a lying small Content-Length still hits the byte-count cap", async () => {
  const big = new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 5).fill(0x63);
  const result = await readBoundedJsonBody(
    streamedRequest([big], { ...JSON_HEADERS, "content-length": "10" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 413);
});

test("missing body yields empty bytes, which then fail JSON parsing downstream", async () => {
  const fake = { headers: new Headers(JSON_HEADERS), body: null } as unknown as Request;
  const result = await readBoundedJsonBody(fake);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.bytes.byteLength, 0);
    const text = decodeUtf8Strict(result.bytes);
    assert.equal(text, "");
    assert.throws(() => JSON.parse(text as string));
  }
});

test("invalid UTF-8 decodes to null, never a replacement character", () => {
  assert.equal(decodeUtf8Strict(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])), null);
});

test("application/json with parameters is accepted", async () => {
  const result = await readBoundedJsonBody(
    streamedRequest([enc.encode("{}")], { "content-type": "application/json; charset=utf-8" }),
  );
  assert.equal(result.ok, true);
});

test("application/*+json is accepted", async () => {
  const result = await readBoundedJsonBody(
    streamedRequest([enc.encode("{}")], { "content-type": "application/cloudevents+json" }),
  );
  assert.equal(result.ok, true);
});

test("unsupported content type is rejected 415", async () => {
  const result = await readBoundedJsonBody(
    streamedRequest([enc.encode("{}")], { "content-type": "text/plain" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 415);
});

test("non-identity Content-Encoding is rejected 415; identity is allowed", async () => {
  const gz = await readBoundedJsonBody(
    streamedRequest([enc.encode("{}")], { ...JSON_HEADERS, "content-encoding": "gzip" }),
  );
  assert.equal(gz.ok, false);
  if (!gz.ok) assert.equal(gz.status, 415);

  const identity = await readBoundedJsonBody(
    streamedRequest([enc.encode("{}")], { ...JSON_HEADERS, "content-encoding": "identity" }),
  );
  assert.equal(identity.ok, true);
});

// --- HMAC ---

const SECRET = "test-webhook-secret";
const sign = (bytes: Uint8Array) => createHmac("sha256", SECRET).update(bytes).digest("hex");

test("valid bare-hex HMAC verifies", () => {
  const bytes = enc.encode('{"mediaUrl":"https://example.com/a.jpg"}');
  assert.equal(verifyWebhookSignature(bytes, sign(bytes), SECRET), true);
});

test("sha256= prefixed HMAC verifies", () => {
  const bytes = enc.encode("{}");
  assert.equal(verifyWebhookSignature(bytes, `sha256=${sign(bytes)}`, SECRET), true);
});

test("invalid HMAC fails", () => {
  const bytes = enc.encode("{}");
  const wrong = sign(enc.encode("something else"));
  assert.equal(verifyWebhookSignature(bytes, wrong, SECRET), false);
});

test("malformed signatures fail safely, never throw", () => {
  const bytes = enc.encode("{}");
  for (const bad of [
    null,
    "",
    "zz".repeat(32), // right length, not hex
    sign(bytes).slice(0, 62), // wrong digest length
    sign(bytes) + "ab", // too long
    "sha512=" + sign(bytes), // unknown prefix stays unstripped -> not 64-hex
    "sha256=", // prefix with nothing
  ]) {
    assert.doesNotThrow(() => {
      assert.equal(verifyWebhookSignature(bytes, bad as string | null, SECRET), false);
    });
  }
});

test("HMAC runs over EXACT raw bytes — invalid UTF-8 still verifies", () => {
  // These bytes are not valid UTF-8. Signing them must still verify, which
  // proves no decode/re-encode happens before verification. (The old code
  // hashed the DECODED string, silently substituting U+FFFD first.)
  const rawInvalid = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x80]);
  assert.equal(verifyWebhookSignature(rawInvalid, sign(rawInvalid), SECRET), true);
  // And the equivalent decoded-then-reencoded string signature must NOT match.
  const substituted = enc.encode(new TextDecoder("utf-8").decode(rawInvalid));
  assert.equal(verifyWebhookSignature(rawInvalid, sign(substituted), SECRET), false);
});
