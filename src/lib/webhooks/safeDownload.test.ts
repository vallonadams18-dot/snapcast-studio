// WH-2 test matrix. Run with: npm run test:webhooks
//
// Network behaviour is exercised through the downloader's injectable
// resolver/transport seam, so redirects, rebinding, stalls and overflows are
// tested for real against the SAME consuming loop production uses — without
// sockets. The only paths that seam cannot reach (real TLS handshake, the
// real headers timer) are called out in the WH-2 report as such.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateMediaUrl,
  isPublicAddress,
  resolvePinnedAddresses,
  resolveRedirect,
  detectMediaType,
  downloadWebhookMedia,
  type Resolver,
  type Transport,
  type TransportResponse,
} from "./safeDownload.ts";

// ------------------------------------------------------------- helpers ----
const enc = new TextEncoder();
const pad = (head: number[], toLength = 80): Uint8Array => {
  const out = new Uint8Array(toLength);
  out.set(head.slice(0, toLength));
  return out;
};
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = pad([...enc.encode("GIF89a")]);
const WEBP = pad([...enc.encode("RIFF"), 0, 0, 0, 0, ...enc.encode("WEBP")]);
const MP4 = pad([0, 0, 0, 24, ...enc.encode("ftypisom")]);
const MOV = pad([0, 0, 0, 24, ...enc.encode("ftypqt  ")]);
const WEBM = pad([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, ...enc.encode("webmB")]);

function bodyOf(...parts: (Uint8Array | "STALL")[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) {
        if (p === "STALL") await new Promise<never>(() => {});
        else yield p;
      }
    },
  };
}

function respond(
  statusCode: number,
  headers: Record<string, string> = {},
  ...body: (Uint8Array | "STALL")[]
): TransportResponse {
  return { statusCode, headers, body: bodyOf(...body), destroy() {} };
}

const publicResolver: Resolver = async () => [{ address: "203.0.113.9" as never, family: 4 }];
// 203.0.113.x is TEST-NET and would be blocked — use a real public range.
const pub: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];

/** Count leftover downloader temp dirs, to prove cleanup. */
async function tempDirCount(): Promise<number> {
  const entries = await readdir(tmpdir());
  return entries.filter((e) => e.startsWith("snapcast-webhook-")).length;
}

// ------------------------------------------------------------ URL policy --
test("URL policy", () => {
  assert.equal(validateMediaUrl("http://cdn.example.com/a.jpg").ok, false); // http in production
  assert.equal(validateMediaUrl("http://cdn.example.com/a.jpg", { allowHttp: true }).ok, true);
  assert.equal(validateMediaUrl("https://cdn.example.com/a.jpg").ok, true);
  assert.equal(validateMediaUrl("https://user:pw@cdn.example.com/a.jpg").ok, false); // credentials
  assert.equal(validateMediaUrl("https://cdn.example.com/a.jpg#frag").ok, false); // fragment
  assert.equal(validateMediaUrl("https://cdn.example.com:8443/a.jpg").ok, false); // custom port
  assert.equal(validateMediaUrl("https://cdn.example.com:443/a.jpg").ok, true); // explicit 443
  assert.equal(validateMediaUrl(`https://c.example.com/${"a".repeat(4100)}`).ok, false); // length
  const signed = validateMediaUrl("https://cdn.example.com/a.jpg?X-Amz-Signature=abc&Expires=1");
  assert.equal(signed.ok, true);
  if (signed.ok) assert.equal(signed.url.search, "?X-Amz-Signature=abc&Expires=1"); // query preserved
});

// -------------------------------------------------------------- IP policy --
test("IP classification blocks every non-public range", () => {
  const blocked = [
    "127.0.0.1", "127.8.8.8",            // loopback
    "10.0.0.1", "172.16.0.1", "192.168.1.1", // RFC1918
    "169.254.169.254",                    // link-local / metadata
    "100.64.0.1",                         // CGNAT
    "0.0.0.0",                            // unspecified
    "224.0.0.1",                          // multicast
    "192.0.2.5", "198.51.100.1", "203.0.113.1", // documentation
    "198.18.0.1",                         // benchmarking
    "240.0.0.1", "255.255.255.255",       // reserved/broadcast
    "::1", "::",                          // v6 loopback/unspecified
    "fe80::1",                            // v6 link-local
    "fd00::1", "fc00::1",                 // v6 unique-local
    "::ffff:10.0.0.1", "::ffff:192.168.1.1", "::ffff:127.0.0.1", // v4-mapped private
    "ff02::1",                            // v6 multicast
  ];
  for (const a of blocked) assert.equal(isPublicAddress(a), false, `${a} must be blocked`);
  for (const a of ["8.8.8.8", "93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(a), true, `${a} must be allowed`);
  }
  assert.equal(isPublicAddress("not-an-ip"), false);
});

test("mixed public+private DNS answers reject the whole host", async () => {
  const mixed: Resolver = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ];
  const r = await resolvePinnedAddresses(new URL("https://x.example.com/"), mixed);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "ip_blocked");
});

test("IP-literal hosts are classified directly", async () => {
  const priv = await resolvePinnedAddresses(new URL("https://192.168.1.10/a"), pub);
  assert.equal(priv.ok, false);
  const v6priv = await resolvePinnedAddresses(new URL("https://[fd00::1]/a"), pub);
  assert.equal(v6priv.ok, false);
  const ok = await resolvePinnedAddresses(new URL("https://93.184.216.34/a"), pub);
  assert.equal(ok.ok, true);
});

test("resolver failure and empty answers map to dns errors", async () => {
  const boom: Resolver = async () => {
    throw new Error("SERVFAIL");
  };
  const none: Resolver = async () => [];
  assert.equal((await resolvePinnedAddresses(new URL("https://a.example.com/"), boom)).ok, false);
  const empty = await resolvePinnedAddresses(new URL("https://a.example.com/"), none);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "dns");
});

// -------------------------------------------------------------- redirects --
test("redirect resolution: relative allowed, downgrade and malformed rejected", () => {
  const cur = new URL("https://cdn.example.com/dir/file");
  const rel = resolveRedirect(cur, "../other/loc.jpg", {});
  assert.equal(rel.ok, true);
  if (rel.ok) assert.equal(rel.url.pathname, "/other/loc.jpg");
  assert.equal(resolveRedirect(cur, "http://cdn.example.com/x", { allowHttp: true }).ok, false); // downgrade
  assert.equal(resolveRedirect(cur, undefined, {}).ok, false); // missing
  assert.equal(resolveRedirect(cur, "https://user:p@e.com/x", {}).ok, false); // creds via redirect
});

test("redirect chain: public->public followed, private target rejected, loop capped at 3", async () => {
  // public -> public -> 200
  let calls: string[] = [];
  const twoHop: Transport = async ({ url }) => {
    calls.push(url.hostname);
    if (url.hostname === "a.example.com") {
      return respond(302, { location: "https://b.example.com/media.jpg" });
    }
    return respond(200, {}, JPEG);
  };
  const ok = await downloadWebhookMedia("https://a.example.com/x", { resolver: pub, transport: twoHop });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.redirects, 1);
    assert.equal(ok.hostname, "b.example.com");
    await rm(ok.tmpDir, { recursive: true, force: true });
  }

  // public -> private DNS target
  const mixedResolver: Resolver = async (h) =>
    h === "evil.internal" ? [{ address: "10.0.0.9", family: 4 }] : [{ address: "93.184.216.34", family: 4 }];
  const toPrivate: Transport = async ({ url }) =>
    url.hostname === "a.example.com" ? respond(302, { location: "https://evil.internal/x" }) : respond(200, {}, JPEG);
  const priv = await downloadWebhookMedia("https://a.example.com/x", { resolver: mixedResolver, transport: toPrivate });
  assert.equal(priv.ok, false);
  if (!priv.ok) assert.equal(priv.code, "ip_blocked");

  // infinite loop -> too_many_redirects after 3
  calls = [];
  const loop: Transport = async () => respond(302, { location: "https://a.example.com/again" });
  const looped = await downloadWebhookMedia("https://a.example.com/x", { resolver: pub, transport: loop });
  assert.equal(looped.ok, false);
  if (!looped.ok) assert.equal(looped.code, "too_many_redirects");

  // malformed Location
  const badLoc: Transport = async () => respond(302, { location: "https://[broken" });
  const bad = await downloadWebhookMedia("https://a.example.com/x", { resolver: pub, transport: badLoc });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "redirect_invalid");
});

// ---------------------------------------------------------- DNS rebinding --
test("rebinding: connection dials the pinned snapshot; hop re-validation catches the swap", async () => {
  let resolutions = 0;
  const flipFlop: Resolver = async () => {
    resolutions += 1;
    // First resolution public, every later one private — the classic rebind.
    return resolutions === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }];
  };
  const dialed: string[] = [];
  const transport: Transport = async ({ url, address }) => {
    dialed.push(address.address);
    // Redirect once to the SAME host, forcing a second resolution.
    return url.pathname === "/start"
      ? respond(302, { location: "https://cdn.example.com/next" })
      : respond(200, {}, JPEG);
  };
  const result = await downloadWebhookMedia("https://cdn.example.com/start", { resolver: flipFlop, transport });
  // The first connection used the validated public pin…
  assert.deepEqual(dialed, ["93.184.216.34"]);
  // …and the swapped record on the second hop was rejected, not connected to.
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ip_blocked");
});

test("connect fallback stays inside one validated snapshot — no re-resolution", async () => {
  let resolutions = 0;
  const multi: Resolver = async () => {
    resolutions += 1;
    return [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ];
  };
  const dialed: string[] = [];
  const flakyFirst: Transport = async ({ address }) => {
    dialed.push(address.address);
    if (address.address.endsWith(".34")) throw new Error("ECONNREFUSED");
    return respond(200, {}, PNG);
  };
  const result = await downloadWebhookMedia("https://cdn.example.com/x", { resolver: multi, transport: flakyFirst });
  assert.equal(result.ok, true);
  assert.deepEqual(dialed, ["93.184.216.34", "93.184.216.35"]);
  assert.equal(resolutions, 1);
  if (result.ok) await rm(result.tmpDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ sizes --
test("declared Content-Length over the cap rejects before streaming", async () => {
  const t: Transport = async () => respond(200, { "content-length": String(200 * 1024 * 1024) }, JPEG);
  const r = await downloadWebhookMedia("https://c.example.com/x", { resolver: pub, transport: t });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "too_large");
});

test("lying small Content-Length still hits the actual-byte cap", async () => {
  const chunk = new Uint8Array(64 * 1024).fill(7);
  const t: Transport = async () =>
    respond(200, { "content-length": "100" }, MP4, chunk, chunk, chunk, chunk);
  const before = await tempDirCount();
  const r = await downloadWebhookMedia("https://c.example.com/x", {
    resolver: pub,
    transport: t,
    maxVideoBytes: 128 * 1024,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "too_large");
  assert.equal(await tempDirCount(), before); // temp cleaned on overflow
});

test("image cap applies once the type is known", async () => {
  const chunk = new Uint8Array(32 * 1024).fill(1);
  const t: Transport = async () => respond(200, {}, JPEG, chunk, chunk, chunk);
  const r = await downloadWebhookMedia("https://c.example.com/x", {
    resolver: pub,
    transport: t,
    maxImageBytes: 48 * 1024,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "too_large");
});

// --------------------------------------------------------------- timeouts --
test("stalled body hits the idle timeout and cleans up", async () => {
  const t: Transport = async () => respond(200, {}, JPEG, "STALL");
  const before = await tempDirCount();
  const r = await downloadWebhookMedia("https://c.example.com/x", {
    resolver: pub,
    transport: t,
    idleTimeoutMs: 80,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "timeout");
  assert.equal(await tempDirCount(), before);
});

test("total download deadline is enforced", async () => {
  const slowChunks: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      // Valid MP4 head first so type detection passes and the loop keeps
      // consuming — the deadline is what must stop it, nothing else.
      yield MP4;
      for (;;) {
        await new Promise((res) => setTimeout(res, 30));
        yield new Uint8Array(1024).fill(2);
      }
    },
  };
  const t: Transport = async () => ({ statusCode: 200, headers: {}, body: slowChunks, destroy() {} });
  const r = await downloadWebhookMedia("https://c.example.com/x", {
    resolver: pub,
    transport: t,
    totalTimeoutMs: 120,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "timeout");
});

test("headers timeout from the transport maps to a timeout failure", async () => {
  const t: Transport = async () => {
    throw new Error("response headers timed out");
  };
  const r = await downloadWebhookMedia("https://c.example.com/x", { resolver: pub, transport: t });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "timeout");
});

// ------------------------------------------------------------ magic bytes --
test("magic-byte detection accepts each supported format with correct metadata", () => {
  assert.deepEqual(detectMediaType(JPEG), { kind: "photo", contentType: "image/jpeg", extension: "jpg" });
  assert.deepEqual(detectMediaType(PNG), { kind: "photo", contentType: "image/png", extension: "png" });
  assert.deepEqual(detectMediaType(GIF), { kind: "photo", contentType: "image/gif", extension: "gif" });
  assert.deepEqual(detectMediaType(WEBP), { kind: "photo", contentType: "image/webp", extension: "webp" });
  assert.deepEqual(detectMediaType(MP4), { kind: "video", contentType: "video/mp4", extension: "mp4" });
  assert.deepEqual(detectMediaType(MOV), { kind: "video", contentType: "video/quicktime", extension: "mov" });
  assert.deepEqual(detectMediaType(WEBM), { kind: "video", contentType: "video/webm", extension: "webm" });
});

test("disguised and unknown formats are rejected regardless of headers", async () => {
  for (const nasty of [
    enc.encode("<html><body>owned</body></html>".padEnd(80, " ")),
    enc.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.padEnd(80, " ")),
    enc.encode('{"not":"media"}'.padEnd(80, " ")),
    enc.encode("%PDF-1.4".padEnd(80, " ")),
    pad([0x50, 0x4b, 0x03, 0x04]), // zip
    pad([0x4d, 0x5a]), // exe
    pad([0x1a, 0x45, 0xdf, 0xa3]), // EBML without webm doctype (plain mkv)
  ]) {
    const t: Transport = async () => respond(200, { "content-type": "image/jpeg" }, nasty);
    const r = await downloadWebhookMedia("https://c.example.com/x", { resolver: pub, transport: t });
    assert.equal(r.ok, false, "disguised payload must be rejected");
    if (!r.ok) assert.equal(r.code, "unsupported_type");
  }
});

test("octet-stream Content-Type with real magic bytes is accepted; empty body is not", async () => {
  const t: Transport = async () => respond(200, { "content-type": "application/octet-stream" }, WEBP);
  const r = await downloadWebhookMedia("https://c.example.com/x", { resolver: pub, transport: t });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.contentType, "image/webp");
    await rm(r.tmpDir, { recursive: true, force: true });
  }
  const empty: Transport = async () => respond(200, {});
  const e = await downloadWebhookMedia("https://c.example.com/x", { resolver: pub, transport: empty });
  assert.equal(e.ok, false);
});

// -------------------------------------------------- success + integrity ----
test("successful download streams to temp with correct bytes and sha256", async () => {
  const tail = new Uint8Array(5000).fill(9);
  const t: Transport = async () => respond(200, {}, MP4, tail);
  const r = await downloadWebhookMedia("https://cdn.example.com/x?sig=SECRET", { resolver: pub, transport: t });
  assert.equal(r.ok, true);
  if (r.ok) {
    const onDisk = await readFile(r.filePath);
    assert.equal(onDisk.byteLength, MP4.byteLength + tail.byteLength);
    const expected = createHash("sha256").update(MP4).update(tail).digest("hex");
    assert.equal(r.sha256, expected);
    assert.equal(r.kind, "video");
    assert.equal(r.hostname, "cdn.example.com"); // host only — no query, no path
    await rm(r.tmpDir, { recursive: true, force: true });
    const gone = await readFile(r.filePath).then(() => false).catch(() => true);
    assert.equal(gone, true);
  }
});

// ------------------------------------------------------- streamed storage --
test("local adapter saveFromFile copies then atomically renames into place", async () => {
  const prevCwd = process.cwd();
  const sandbox = await mkdtemp(path.join(tmpdir(), "snapcast-storetest-"));
  try {
    process.chdir(sandbox);
    const { getStorageAdapter } = await import("../storage.ts");
    const src = path.join(sandbox, "src.bin");
    const payload = Buffer.from("streamed-not-buffered");
    await (await import("node:fs/promises")).writeFile(src, payload);
    const saved = await getStorageAdapter().saveFromFile("evt1/webhook.jpg", src, "image/jpeg", payload.length);
    assert.equal(saved.url, "/uploads/evt1/webhook.jpg");
    const roundTrip = await readFile(path.join(sandbox, "public", "uploads", "evt1", "webhook.jpg"));
    assert.deepEqual(roundTrip, payload);
    const leftovers = (await readdir(path.join(sandbox, "public", "uploads", "evt1"))).filter((f) =>
      f.includes(".tmp-"),
    );
    assert.equal(leftovers.length, 0); // no staging debris
  } finally {
    process.chdir(prevCwd);
    await rm(sandbox, { recursive: true, force: true });
  }
});
