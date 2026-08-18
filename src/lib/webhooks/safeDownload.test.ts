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
const WEBM = pad([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...enc.encode("webm")]); // structurally valid EBML header

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

// ==================================================================
// Codex review fixes — regression coverage
// ==================================================================
import { createServer } from "node:http";
import { realTransport, MAX_CONCURRENT_DOWNLOADS, MAX_WAITING_DOWNLOADS } from "./safeDownload.ts";

test("REAL SOCKET: Node 22 all:true lookup form works (the production breaker)", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.from(JPEG));
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  try {
    // Hostname (not IP literal) forces the lookup callback to run — on
    // Node 22 with { all: true }, which the old callback answered wrongly,
    // failing every hostname download with "Invalid IP address: undefined".
    const response = await realTransport({
      url: new URL(`http://localhost:${port}/media.jpg`),
      address: { address: "127.0.0.1", family: 4 },
    });
    assert.equal(response.statusCode, 200);
    const chunks: Uint8Array[] = [];
    for await (const c of response.body) chunks.push(c);
    assert.equal(Buffer.concat(chunks).length, JPEG.byteLength);
  } finally {
    server.close();
  }
});

test("REAL SOCKET: connect timer is disarmed after connect — slow bodies survive", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200);
    res.flushHeaders(); // writeHead alone buffers until first write
    // Body arrives well AFTER the connect timeout — before the fix, the
    // still-armed socket timer killed the stream at the connect timeout.
    setTimeout(() => res.end(Buffer.from(MP4)), 700);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await realTransport({
      url: new URL(`http://localhost:${port}/slow.mp4`),
      address: { address: "127.0.0.1", family: 4 },
      connectTimeoutMs: 250,
    });
    const chunks: Uint8Array[] = [];
    for await (const c of response.body) chunks.push(c);
    assert.equal(Buffer.concat(chunks).length, MP4.byteLength);
  } finally {
    server.close();
  }
});

test("total budget covers DNS — a stalling resolver cannot outlive the deadline", async () => {
  const stallingResolver: Resolver = () => new Promise(() => {});
  const neverTransport: Transport = async () => {
    throw new Error("must not be reached");
  };
  const r = await downloadWebhookMedia("https://slow-dns.example.com/x", {
    resolver: stallingResolver,
    transport: neverTransport,
    totalTimeoutMs: 120,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "timeout");
});

test("resolved addresses are deduplicated and capped at 4 attempts", async () => {
  const many: Resolver = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "93.184.216.34", family: 4 }, // duplicate
    { address: "93.184.216.35", family: 4 },
    { address: "93.184.216.36", family: 4 },
    { address: "93.184.216.37", family: 4 },
    { address: "93.184.216.38", family: 4 },
    { address: "93.184.216.39", family: 4 },
  ];
  const dialed: string[] = [];
  const alwaysFail: Transport = async ({ address }) => {
    dialed.push(address.address);
    throw new Error("ECONNREFUSED");
  };
  const r = await downloadWebhookMedia("https://multi.example.com/x", { resolver: many, transport: alwaysFail });
  assert.equal(r.ok, false);
  assert.equal(dialed.length, 4); // capped
  assert.equal(new Set(dialed).size, 4); // deduplicated
});

test("production NODE_ENV hard-blocks http even with allowHttp", () => {
  const prev = process.env.NODE_ENV;
  try {
    (process.env as Record<string, string>).NODE_ENV = "production";
    assert.equal(validateMediaUrl("http://cdn.example.com/a.jpg", { allowHttp: true }).ok, false);
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prev;
  }
});

test("dev http ports: 80 and unprivileged allowed, privileged service ports blocked", () => {
  assert.equal(validateMediaUrl("http://dev.example.com/a.jpg", { allowHttp: true }).ok, true); // 80
  assert.equal(validateMediaUrl("http://dev.example.com:3000/a.jpg", { allowHttp: true }).ok, true);
  assert.equal(validateMediaUrl("http://dev.example.com:6379/a.jpg", { allowHttp: true }).ok, true); // >=1024
  assert.equal(validateMediaUrl("http://dev.example.com:25/a.jpg", { allowHttp: true }).ok, false); // SMTP
  assert.equal(validateMediaUrl("http://dev.example.com:443/a.jpg", { allowHttp: true }).ok, false);
});

test("ISO-BMFF brand policy: HEIC/AVIF/M4A rejected, Matroska DocType rejected, truncated EBML rejected", () => {
  const ftyp = (brand: string) => pad([0, 0, 0, 24, ...enc.encode("ftyp"), ...enc.encode(brand)]);
  assert.equal(detectMediaType(ftyp("heic")), null);
  assert.equal(detectMediaType(ftyp("heix")), null);
  assert.equal(detectMediaType(ftyp("avif")), null);
  assert.equal(detectMediaType(ftyp("mif1")), null);
  assert.equal(detectMediaType(ftyp("M4A ")), null);
  // Matroska: DocType element present but value is "matroska"
  const mkv = pad([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, ...enc.encode("matroska")]);
  assert.equal(detectMediaType(mkv), null);
  // Truncated EBML with no DocType at all
  assert.equal(detectMediaType(pad([0x1a, 0x45, 0xdf, 0xa3])), null);
  // Proper webm DocType still accepted
  assert.deepEqual(detectMediaType(WEBM), { kind: "video", contentType: "video/webm", extension: "webm" });
});

test("concurrency: beyond active+queue capacity, downloads are refused as busy", async () => {
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((res) => (releaseGate = res));
  const gatedTransport: Transport = async () => {
    await gate;
    return respond(200, {}, JPEG);
  };
  const total = MAX_CONCURRENT_DOWNLOADS + MAX_WAITING_DOWNLOADS + 1;
  const runs = Array.from({ length: total }, () =>
    downloadWebhookMedia("https://gated.example.com/x", { resolver: pub, transport: gatedTransport }),
  );
  // The overflow request must be refused promptly while the rest wait.
  const first = await Promise.race([runs[total - 1], ...runs.slice(0, 3)]);
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.code, "busy");
  releaseGate();
  const settled = await Promise.all(runs);
  const busy = settled.filter((r) => !r.ok && r.code === "busy");
  assert.equal(busy.length, 1);
  for (const r of settled) if (r.ok) await rm(r.tmpDir, { recursive: true, force: true });
});

// ==================================================================
// Correction pass — TLS reality, listener hygiene, storage faults
// ==================================================================
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { writeFile as writeFileFs, mkdir as mkdirFs } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildS3PutInput } from "../storage.ts";

// Self-signed pair, SAN = DNS:webhook-fixture.test only. Grants no trust
// anywhere: the test passes it as an explicit `ca`, which replaces the trust
// store for that single connection while verification still runs in full.
const FIX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const FIXTURE_KEY = readFileSync(path.join(FIX_DIR, "fixture-key.pem"), "utf8");
const FIXTURE_CERT = readFileSync(path.join(FIX_DIR, "fixture-cert.pem"), "utf8");

test("REAL TLS: SNI, Host, cert hostname verification and pinning all hold", async () => {
  let seenSni: string | undefined;
  let seenHost: string | undefined;
  const server = createHttpsServer(
    {
      key: FIXTURE_KEY,
      cert: FIXTURE_CERT,
      SNICallback: (servername, cb) => {
        seenSni = servername;
        cb(null, undefined);
      },
    },
    (req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200);
      res.end(Buffer.from(PNG));
    },
  );
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  try {
    // The hostname exists only here — the pinned lookup, not DNS, carries the
    // connection to 127.0.0.1, while the hostname must still flow into SNI,
    // the Host header, and certificate verification.
    const response = await realTransport({
      url: new URL(`https://webhook-fixture.test:${port}/a.png`),
      address: { address: "127.0.0.1", family: 4 },
      ca: FIXTURE_CERT,
    });
    assert.equal(response.statusCode, 200);
    const chunks: Uint8Array[] = [];
    for await (const c of response.body) chunks.push(c);
    assert.equal(Buffer.concat(chunks).length, PNG.byteLength);
    assert.equal(seenSni, "webhook-fixture.test");
    assert.equal(seenHost, `webhook-fixture.test:${port}`);

    // Same server, same CA, WRONG hostname: cert hostname verification must
    // fail — proving it genuinely runs and is not bypassed by the pin.
    await assert.rejects(
      realTransport({
        url: new URL(`https://wrong-name.test:${port}/a.png`),
        address: { address: "127.0.0.1", family: 4 },
        ca: FIXTURE_CERT,
      }),
      (err: Error & { code?: string }) => err.code === "ERR_TLS_CERT_ALTNAME_INVALID" || /altname/i.test(err.message),
    );
  } finally {
    server.close();
  }
});

test("REAL SOCKET: connect timeout fires against an unroutable address", async () => {
  const started = Date.now();
  await assert.rejects(
    realTransport({
      url: new URL("https://unreachable.example.com/x"),
      // RFC1918 blackhole — SYN goes unanswered. realTransport does no
      // policy of its own; policy runs upstream of it.
      address: { address: "10.255.255.1", family: 4 },
      connectTimeoutMs: 400,
    }),
    /timed out/,
  );
  assert.ok(Date.now() - started < 3000, "must fail via the connect timer, not TCP defaults");
});

test("REAL SOCKET: short body stall survives; stall beyond the idle limit fails", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200);
    res.flushHeaders();
    if (req.url === "/short-stall") setTimeout(() => res.end(Buffer.from(JPEG)), 300);
    // "/forever": headers only — the body never comes.
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  const consume = async (urlPath: string, idleMs: number) => {
    const response = await realTransport({
      url: new URL(`http://localhost:${port}${urlPath}`),
      address: { address: "127.0.0.1", family: 4 },
    });
    const it = response.body[Symbol.asyncIterator]();
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const step = await Promise.race([
          it.next(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("idle timed out")), idleMs)),
        ]);
        if (step.done) break;
        chunks.push(step.value);
      }
    } finally {
      response.destroy();
    }
    return Buffer.concat(chunks);
  };
  try {
    const short = await consume("/short-stall", 1500);
    assert.equal(short.length, JPEG.byteLength); // 300ms stall < idle: survives
    await assert.rejects(consume("/forever", 400), /idle timed out/); // real stall dies
  } finally {
    server.close();
  }
});

test("backpressure: a large chunked download raises no MaxListenersExceededWarning", async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(w.name);
  process.on("warning", onWarning);
  try {
    // 300 chunks of 64 KiB — hundreds of write/backpressure cycles.
    const chunk = new Uint8Array(64 * 1024).fill(3);
    const parts: Uint8Array[] = [MP4, ...Array.from({ length: 300 }, () => chunk)];
    const t: Transport = async () => respond(200, {}, ...parts);
    const r = await downloadWebhookMedia("https://big.example.com/x", { resolver: pub, transport: t });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.bytes, MP4.byteLength + 300 * chunk.byteLength);
      await rm(r.tmpDir, { recursive: true, force: true });
    }
    // Give any queued warning a tick to surface before asserting.
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(warnings.filter((w) => w === "MaxListenersExceededWarning").length, 0);
  } finally {
    process.off("warning", onWarning);
  }
});

test("random bytes containing the word webm are rejected", () => {
  const sneaky = pad([0x00, 0x11, 0x22, ...enc.encode("look a webm string")]);
  assert.equal(detectMediaType(sneaky), null);
  // Even EBML magic + the word, WITHOUT a DocType element, is rejected.
  const sneakyEbml = pad([0x1a, 0x45, 0xdf, 0xa3, ...enc.encode("____webm____")]);
  assert.equal(detectMediaType(sneakyEbml), null);
});

test("HEIF family brands and malformed ftyp are rejected", () => {
  const ftyp = (brand: string) => pad([0, 0, 0, 24, ...enc.encode("ftyp"), ...enc.encode(brand)]);
  assert.equal(detectMediaType(ftyp("msf1")), null);
  assert.equal(detectMediaType(ftyp("hevc")), null);
  assert.equal(detectMediaType(ftyp("qqqq")), null);
});

test("local staging: copy failure and rename failure both leave no .tmp debris", async () => {
  const prevCwd = process.cwd();
  const sandbox = await mkdtemp(path.join(tmpdir(), "snapcast-stagefault-"));
  try {
    process.chdir(sandbox);
    const { getStorageAdapter } = await import("../storage.ts");
    const adapter = getStorageAdapter();

    // Copy failure: source file does not exist.
    await assert.rejects(adapter.saveFromFile("evt/copyfail.jpg", path.join(sandbox, "missing.bin"), "image/jpeg", 1));

    // Rename failure: the destination already exists as a DIRECTORY.
    const src = path.join(sandbox, "real.bin");
    await writeFileFs(src, Buffer.from("bytes"));
    await mkdirFs(path.join(sandbox, "public", "uploads", "evt", "renamefail.jpg"), { recursive: true });
    await assert.rejects(adapter.saveFromFile("evt/renamefail.jpg", src, "image/jpeg", 5));

    const leftovers = (await readdir(path.join(sandbox, "public", "uploads", "evt"))).filter((f) =>
      f.includes(".tmp-"),
    );
    assert.equal(leftovers.length, 0);
  } finally {
    process.chdir(prevCwd);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("S3 streamed input: ReadStream body, counted ContentLength, detected ContentType", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "snapcast-s3input-"));
  try {
    const src = path.join(sandbox, "media.mp4");
    await writeFileFs(src, Buffer.alloc(1234, 7));
    const input = await buildS3PutInput("bucket", "evt/webhook.mp4", src, "video/mp4", 1234);
    const { ReadStream } = await import("node:fs");
    assert.ok(input.Body instanceof ReadStream, "body must stream from disk, never a Buffer");
    assert.equal(String((input.Body as InstanceType<typeof ReadStream>).path), src);
    assert.equal(input.ContentLength, 1234);
    assert.equal(input.ContentType, "video/mp4");
    (input.Body as InstanceType<typeof ReadStream>).destroy();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

// ==================================================================
// Final correction pass — Codex re-audit regressions
// ==================================================================
import { detectWebm, downloadQueueDepth } from "./safeDownload.ts";

test("POOLING BYPASS: same host:port, new pin — request 2 reaches ONLY the new server", async () => {
  // Two servers on the SAME port, different loopback addresses, so a
  // keep-alive agent keyed on host:port would happily reuse server A's
  // socket for a request pinned to B — which is exactly the reproduced
  // bypass: the signed path reached the OLD server before validation.
  const seenA: string[] = [];
  const seenB: string[] = [];
  const serverA = createServer((req, res) => {
    seenA.push(req.url ?? "");
    res.writeHead(200);
    res.end(Buffer.from(JPEG));
  });
  await new Promise<void>((res) => serverA.listen(0, "127.0.0.1", res));
  const port = (serverA.address() as { port: number }).port;
  const serverB = createServer((req, res) => {
    seenB.push(req.url ?? "");
    res.writeHead(200);
    res.end(Buffer.from(JPEG));
  });
  await new Promise<void>((res, rej) => {
    serverB.once("error", rej);
    serverB.listen(port, "127.0.0.2", res);
  });
  try {
    const url = new URL(`http://pool-fixture.test:${port}/first?sig=ONE`);
    const r1 = await realTransport({ url, address: { address: "127.0.0.1", family: 4 } });
    for await (const _ of r1.body) void _;
    const url2 = new URL(`http://pool-fixture.test:${port}/second?sig=TWO`);
    const r2 = await realTransport({ url: url2, address: { address: "127.0.0.2", family: 4 } });
    for await (const _ of r2.body) void _;

    assert.deepEqual(seenA, ["/first?sig=ONE"]); // A never saw request 2
    assert.deepEqual(seenB, ["/second?sig=TWO"]); // B, and only B, got it
  } finally {
    serverA.close();
    serverB.close();
  }
});

test("ABSOLUTE DEADLINE: a tiny total budget beats a huge idle timeout", async () => {
  let destroyed = false;
  const stalling: Transport = async () => ({
    statusCode: 200,
    headers: {},
    body: bodyOf(MP4, "STALL"),
    destroy: () => {
      destroyed = true;
    },
  });
  const started = Date.now();
  const r = await downloadWebhookMedia("https://stall.example.com/x", {
    resolver: pub,
    transport: stalling,
    totalTimeoutMs: 150,
    idleTimeoutMs: 60_000, // must NOT carry the wait past the total budget
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "timeout");
  assert.ok(Date.now() - started < 5_000, "total deadline must cut the oversized idle wait");
  assert.equal(destroyed, true, "timed-out transport must be destroyed, not abandoned");
});

test("TIMER SEPARATION: headers slower than the connect timeout still succeed", async () => {
  const server = createServer((req, res) => {
    // Connection accepted instantly; headers deliberately later than the
    // connect timeout but inside the header timeout.
    setTimeout(() => {
      res.writeHead(200);
      res.end(Buffer.from(JPEG));
    }, 500);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await realTransport({
      url: new URL(`http://localhost:${port}/slow-headers`),
      address: { address: "127.0.0.1", family: 4 },
      connectTimeoutMs: 150, // would kill it if still armed post-connect
      headersTimeoutMs: 3_000,
    });
    assert.equal(response.statusCode, 200);
    for await (const _ of response.body) void _;
  } finally {
    server.close();
  }
});

test("TIMER SEPARATION: a genuine header timeout still fires", async () => {
  const server = createServer(() => {
    // Accept, then never send headers.
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      realTransport({
        url: new URL(`http://localhost:${port}/never`),
        address: { address: "127.0.0.1", family: 4 },
        connectTimeoutMs: 2_000,
        headersTimeoutMs: 250,
      }),
      /headers timed out/,
    );
  } finally {
    server.close();
  }
});

test("ABORTABLE QUEUE: a queued waiter whose deadline expires cannot be resurrected", async () => {
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((res) => (releaseGate = res));
  const gated: Transport = async () => {
    await gate;
    return respond(200, {}, JPEG);
  };
  // Fill both active slots with long-budget downloads.
  const active = Array.from({ length: MAX_CONCURRENT_DOWNLOADS }, () =>
    downloadWebhookMedia("https://gated.example.com/x", { resolver: pub, transport: gated }),
  );
  await new Promise((res) => setTimeout(res, 30)); // let them occupy the slots

  // Queue one more with a deadline far shorter than the gate.
  const doomed = await downloadWebhookMedia("https://gated.example.com/doomed", {
    resolver: pub,
    transport: gated,
    totalTimeoutMs: 100,
  });
  assert.equal(doomed.ok, false);
  if (!doomed.ok) assert.equal(doomed.code, "timeout"); // timed out IN the queue
  assert.equal(downloadQueueDepth(), 0, "aborted waiter must leave the queue atomically");

  // Releasing the actives must not resurrect the doomed waiter.
  releaseGate();
  const settled = await Promise.all(active);
  for (const r of settled) {
    assert.equal(r.ok, true);
    if (r.ok) await rm(r.tmpDir, { recursive: true, force: true });
  }
  assert.equal(downloadQueueDepth(), 0);
});

test("STRICT FTYP: malformed boxes and invented brands are rejected; exact brands hold", () => {
  const ftypWithSize = (size: number, brand: string) =>
    pad([(size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, ...enc.encode("ftyp"), ...enc.encode(brand)]);
  assert.equal(detectMediaType(ftypWithSize(0, "isom")), null); // zero-size box
  assert.equal(detectMediaType(ftypWithSize(8, "isom")), null); // too small to hold a brand
  assert.equal(detectMediaType(ftypWithSize(22, "isom")), null); // not 4-aligned
  assert.equal(detectMediaType(ftypWithSize(65536, "isom")), null); // absurd size
  assert.equal(detectMediaType(ftypWithSize(24, "qtab")), null); // invented qt* brand
  assert.equal(detectMediaType(ftypWithSize(24, "qt  "))?.extension, "mov"); // exact QuickTime
  assert.equal(detectMediaType(ftypWithSize(24, "isom"))?.extension, "mp4");
  // Truncated: real bytes end before the mandatory 16-byte header.
  const truncated = new Uint8Array(12);
  truncated.set([0, 0, 0, 24, ...enc.encode("ftypisom")].slice(0, 12));
  assert.equal(detectMediaType(truncated), null);
});

test("EBML STRUCTURE: real parser accepts valid webm and rejects every malformation", () => {
  const magic = [0x1a, 0x45, 0xdf, 0xa3];
  // Valid: header size 7 containing exactly DocType(0x4282, size 4, "webm").
  assert.equal(detectWebm(pad([...magic, 0x87, 0x42, 0x82, 0x84, ...enc.encode("webm")])), true);
  // Matroska DocType inside a valid header.
  assert.equal(detectWebm(pad([...magic, 0x8b, 0x42, 0x82, 0x88, ...enc.encode("matroska")])), false);
  // Invalid vint (0x00 first byte has no marker bit).
  assert.equal(detectWebm(pad([...magic, 0x00, 0x42, 0x82, 0x84, ...enc.encode("webm")])), false);
  // DocType OUTSIDE the declared header bounds (header size 2, DocType after).
  assert.equal(detectWebm(pad([...magic, 0x82, 0x00, 0x00, 0x42, 0x82, 0x84, ...enc.encode("webm")])), false);
  // DocType element overruns the header (size 7 header, DocType claims 20 bytes).
  assert.equal(detectWebm(pad([...magic, 0x87, 0x42, 0x82, 0x94, ...enc.encode("webm")])), false);
  // Truncated: header declares more than the sniff window holds.
  const big = new Uint8Array([...magic, 0xff]); // vint 0xff = size 127, buffer ends
  assert.equal(detectWebm(big), false);
  // No DocType in the header at all.
  assert.equal(detectWebm(pad([...magic, 0x84, 0x42, 0x86, 0x81, 0x01])), false);
  // Random "webm" bytes with no EBML structure.
  assert.equal(detectWebm(pad([...magic, ...enc.encode("____webm____")])), false);
});

test("CONTAINMENT: storage keys cannot escape public/uploads", async () => {
  const prevCwd = process.cwd();
  const sandbox = await mkdtemp(path.join(tmpdir(), "snapcast-contain-"));
  try {
    process.chdir(sandbox);
    const { getStorageAdapter } = await import("../storage.ts");
    const adapter = getStorageAdapter();
    await assert.rejects(adapter.save("../../escape.txt", Buffer.from("x"), "text/plain"), /outside the uploads/);
    const src = path.join(sandbox, "ok.bin");
    await writeFileFs(src, Buffer.from("y"));
    await assert.rejects(adapter.saveFromFile("../secrets/x.jpg", src, "image/jpeg", 1), /outside the uploads/);
    // Legitimate nested keys still work.
    const saved = await adapter.save("evt9/fine.txt", Buffer.from("z"), "text/plain");
    assert.equal(saved.url, "/uploads/evt9/fine.txt");
  } finally {
    process.chdir(prevCwd);
    await rm(sandbox, { recursive: true, force: true });
  }
});
