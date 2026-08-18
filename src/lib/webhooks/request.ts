// Bounded, verified intake for the public webhook endpoint.
//
// The webhook is the one route an unauthenticated stranger can legitimately
// POST to — booth software pushes a small JSON pointer at it. Before this
// module, the route called request.text() unconditionally, which buffers
// however many bytes the sender cares to stream at whatever pace they like.
// A webhook payload is a URL and two hints; it has no business being larger
// than 64 KiB, and anything bigger is either a mistake or an attack.
//
// Manual uploads are NOT affected by any of this: they go through
// /api/events/[eventId]/media as authenticated multipart form data with
// their own 150MB application cap (and nginx's global 200M) — real event
// video is large by nature. The 64 KiB bound here is strictly for the
// unauthenticated JSON control message.
import { createHmac, timingSafeEqual } from "node:crypto";

/** 64 KiB — orders of magnitude above any legitimate webhook payload. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export type BoundedBody =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 400 | 413 | 415; error: string };

/**
 * Read a request body as raw bytes, refusing to buffer past `maxBytes`.
 *
 * Order of defences:
 *  1. Content-Encoding other than identity is refused outright — a small
 *     compressed body can decompress to something enormous, so the only
 *     safe compressed limit is "none".
 *  2. Content-Type must be JSON (application/json or application/*+json).
 *  3. A Content-Length declaring more than the cap is rejected 413 before
 *     the body is touched at all.
 *  4. The stream is then read chunk by chunk and ACTUAL bytes are counted —
 *     a Content-Length that lies, or no Content-Length at all (chunked
 *     transfer), hits the same 413 the moment the count crosses the cap,
 *     and the reader is cancelled rather than drained.
 *
 * No decoding happens here. The caller gets the exact bytes received, which
 * is what HMAC verification must run against — decoding first would let
 * invalid UTF-8 be silently replaced before the signature check, making
 * "signed" and "what was actually sent" two different byte sequences.
 */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes = MAX_WEBHOOK_BODY_BYTES,
): Promise<BoundedBody> {
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") {
    return { ok: false, status: 415, error: "compressed webhook bodies are not supported" };
  }

  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const isJson =
    mediaType === "application/json" || (mediaType.startsWith("application/") && mediaType.endsWith("+json"));
  if (!isJson) {
    return { ok: false, status: 415, error: "webhook body must be application/json" };
  }

  const declared = request.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    // A parseable declaration over the cap is rejected without reading a
    // byte. A missing or nonsensical declaration is NOT trusted as "small" —
    // it just falls through to the counted read below.
    if (Number.isFinite(n) && n > maxBytes) {
      return { ok: false, status: 413, error: `webhook body exceeds ${maxBytes} bytes` };
    }
  }

  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling — never drain the rest of an oversized stream.
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: `webhook body exceeds ${maxBytes} bytes` };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel — nothing to do.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * Strict UTF-8 decode of a completed buffer. Null on invalid sequences —
 * never a replacement character, never a throw. Runs AFTER HMAC, so a body
 * that authenticates but isn't valid UTF-8 fails as a 400, not a mangled
 * parse of substituted characters.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const HEX_64 = /^[0-9a-f]{64}$/i;

/**
 * Verify the webhook HMAC against the EXACT raw bytes received.
 *
 * Accepts the existing bare 64-hex format and the common `sha256=<hex>`
 * prefix form. Everything else — wrong length, non-hex characters, empty —
 * returns false without ever reaching timingSafeEqual, so a malformed
 * header can neither throw nor leak timing. Digest BYTES are compared, not
 * hex strings.
 */
export function verifyWebhookSignature(
  rawBytes: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  let hex = signatureHeader.trim();
  if (hex.toLowerCase().startsWith("sha256=")) hex = hex.slice("sha256=".length).trim();
  if (!HEX_64.test(hex)) return false;

  const provided = Buffer.from(hex, "hex");
  const expected = createHmac("sha256", secret).update(rawBytes).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
