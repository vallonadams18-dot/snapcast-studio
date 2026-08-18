// SSRF-safe, streamed downloader for webhook-supplied media URLs.
//
// The webhook hands us a URL and we fetch it — which makes this route a
// server-side request forgery target: point it at 169.254.169.254 and read
// cloud metadata, at localhost:3000 and probe ourselves, at a 10.x address
// and map the private network. Every defence here exists to make the fetch
// mean "download a public media file" and nothing else.
//
// Scoped to the webhook path only. Manual uploads never touch this code.
import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import ipaddr from "ipaddr.js";

// ---------------------------------------------------------------- limits --
export const MAX_URL_LENGTH = 4096;
export const MAX_REDIRECTS = 3;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
export const DNS_TIMEOUT_MS = 3_000;
export const CONNECT_TIMEOUT_MS = 5_000;
export const HEADERS_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 15_000;
export const TOTAL_TIMEOUT_MS = 180_000;
/** Magic-byte sniffing needs this much of the head of the file. */
const SNIFF_BYTES = 64;

export type SafeDownloadFailure = {
  ok: false;
  /** Machine-readable, safe to log. Never contains the URL. */
  code:
    | "url_invalid"
    | "url_policy"
    | "dns"
    | "ip_blocked"
    | "connect"
    | "http_status"
    | "redirect_invalid"
    | "too_many_redirects"
    | "timeout"
    | "too_large"
    | "unsupported_type"
    | "storage";
  error: string;
};

export interface SafeDownloadSuccess {
  ok: true;
  /** Temp file holding the streamed bytes. Caller MUST clean up its dir. */
  filePath: string;
  /** Directory to rm -rf when done. */
  tmpDir: string;
  bytes: number;
  kind: "photo" | "video";
  contentType: string;
  extension: string;
  sha256: string;
  /** Origin hostname only — safe for logs. */
  hostname: string;
  redirects: number;
}

export type SafeDownloadResult = SafeDownloadSuccess | SafeDownloadFailure;

// ------------------------------------------------------------- URL policy --
export interface UrlPolicyOptions {
  /** Explicit dev/test escape hatch. NEVER defaults on. */
  allowHttp?: boolean;
}

/** Validate one URL against the webhook fetch policy. */
export function validateMediaUrl(raw: string, opts: UrlPolicyOptions = {}): { ok: true; url: URL } | SafeDownloadFailure {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, code: "url_invalid", error: "media URL missing" };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, code: "url_policy", error: "media URL too long" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "url_invalid", error: "media URL is not a valid URL" };
  }

  if (url.protocol === "http:") {
    if (!opts.allowHttp) return { ok: false, code: "url_policy", error: "media URL must use https" };
  } else if (url.protocol !== "https:") {
    return { ok: false, code: "url_policy", error: "media URL must use https" };
  }
  // Credentials in a URL are only ever an exfiltration or confusion trick.
  if (url.username || url.password) return { ok: false, code: "url_policy", error: "credentials in media URL are not allowed" };
  if (url.hash) return { ok: false, code: "url_policy", error: "fragments in media URL are not allowed" };
  // Query strings stay: signed CDN URLs live there.
  if (url.protocol === "https:" && url.port !== "" && url.port !== "443") {
    return { ok: false, code: "url_policy", error: "non-standard ports are not allowed" };
  }
  return { ok: true, url };
}

// -------------------------------------------------------------- IP policy --
/** True only for public/global unicast addresses. Everything else is blocked. */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  // ::ffff:10.0.0.1 is a private IPv4 wearing an IPv6 coat — unwrap first.
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  // "unicast" is ipaddr.js's name for ordinary global address space. This
  // single check excludes loopback, RFC1918 private, link-local, CGNAT
  // (100.64/10), unspecified, broadcast, multicast, documentation/TEST-NET,
  // benchmarking (198.18/15), 240/4 reserved, IPv6 unique-local, 6to4,
  // teredo, and the rest of the special-use registries.
  return parsed.range() === "unicast";
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Default resolver: A + AAAA, each bounded by DNS_TIMEOUT_MS. */
export const defaultResolver: Resolver = async (hostname) => {
  const [v4, v6] = await Promise.allSettled([
    withTimeout(dns.resolve4(hostname), DNS_TIMEOUT_MS, "DNS A lookup"),
    withTimeout(dns.resolve6(hostname), DNS_TIMEOUT_MS, "DNS AAAA lookup"),
  ]);
  const out: ResolvedAddress[] = [];
  if (v4.status === "fulfilled") for (const a of v4.value) out.push({ address: a, family: 4 });
  if (v6.status === "fulfilled") for (const a of v6.value) out.push({ address: a, family: 6 });
  return out;
};

/**
 * Resolve a URL's host to a PINNED set of validated public addresses.
 *
 * If ANY record is non-public the whole host is rejected: an attacker who
 * controls DNS can round-robin a public and a private record, and accepting
 * the mixed set means gambling on which one a later lookup would hand the
 * socket. The connection layer below only ever dials addresses from this
 * snapshot — it never re-resolves — which is the entire defence against
 * DNS rebinding (resolve public now, swap the record to 10.0.0.1 before
 * the connect).
 */
export async function resolvePinnedAddresses(
  url: URL,
  resolver: Resolver = defaultResolver,
): Promise<{ ok: true; addresses: ResolvedAddress[] } | SafeDownloadFailure> {
  // URL keeps IPv6 literals in brackets.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  const literal = net.isIP(hostname);
  if (literal) {
    if (!isPublicAddress(hostname)) return { ok: false, code: "ip_blocked", error: "address is not publicly routable" };
    return { ok: true, addresses: [{ address: hostname, family: literal as 4 | 6 }] };
  }

  let resolved: ResolvedAddress[];
  try {
    resolved = await resolver(hostname);
  } catch {
    return { ok: false, code: "dns", error: "DNS resolution failed" };
  }
  if (resolved.length === 0) return { ok: false, code: "dns", error: "hostname did not resolve" };
  for (const entry of resolved) {
    if (!isPublicAddress(entry.address)) {
      return { ok: false, code: "ip_blocked", error: "hostname resolves to a non-public address" };
    }
  }
  return { ok: true, addresses: resolved };
}

// -------------------------------------------------------------- redirects --
/**
 * Resolve and police a redirect target. Relative Locations resolve against
 * the current URL; the result re-enters the full URL policy. https may not
 * downgrade to http even when http was allowed for the first hop.
 */
export function resolveRedirect(
  current: URL,
  location: string | undefined,
  opts: UrlPolicyOptions,
): { ok: true; url: URL } | SafeDownloadFailure {
  if (!location) return { ok: false, code: "redirect_invalid", error: "redirect without a Location header" };
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    return { ok: false, code: "redirect_invalid", error: "redirect Location is malformed" };
  }
  if (current.protocol === "https:" && target.protocol === "http:") {
    return { ok: false, code: "redirect_invalid", error: "redirect downgrades https to http" };
  }
  const policy = validateMediaUrl(target.toString(), opts);
  if (!policy.ok) return { ok: false, code: "redirect_invalid", error: `redirect target rejected: ${policy.error}` };
  return policy;
}

// ------------------------------------------------------------ magic bytes --
interface DetectedType {
  kind: "photo" | "video";
  contentType: string;
  extension: string;
}

/** Identify a file from its leading bytes. Null = not an allowed media type. */
export function detectMediaType(head: Uint8Array): DetectedType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { kind: "photo", contentType: "image/jpeg", extension: "jpg" };
  }
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 4) === "PNG" && head[4] === 0x0d && head[5] === 0x0a) {
    return { kind: "photo", contentType: "image/png", extension: "png" };
  }
  if (head.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return { kind: "photo", contentType: "image/gif", extension: "gif" };
  }
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return { kind: "photo", contentType: "image/webp", extension: "webp" };
  }
  if (head.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand.startsWith("qt")) return { kind: "video", contentType: "video/quicktime", extension: "mov" };
    // isom / iso2 / mp41 / mp42 / avc1 / M4V and friends — the MP4 family.
    return { kind: "video", contentType: "video/mp4", extension: "mp4" };
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // EBML container. Only accept it when the DocType in the header says
    // webm, so arbitrary Matroska doesn't ride in.
    const headStr = ascii(0, Math.min(head.length, SNIFF_BYTES));
    if (headStr.includes("webm")) return { kind: "video", contentType: "video/webm", extension: "webm" };
  }
  // Everything else — HTML, JSON, SVG/XML, PDF, archives, executables,
  // formats we don't render — is rejected by not being recognised.
  return null;
}

// -------------------------------------------------------------- transport --
export interface TransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

export type Transport = (target: {
  url: URL;
  address: ResolvedAddress;
}) => Promise<TransportResponse>;

/**
 * Real transport: node:https with the lookup callback OVERRIDDEN to return
 * the pinned, already-validated address. The hostname still flows into the
 * Host header, into TLS SNI, and into certificate verification — only the
 * socket's destination is forced. After connect, the socket's actual remote
 * address is checked against the pin, so even a hijacked lookup path can't
 * silently land elsewhere.
 */
const realTransport: Transport = ({ url, address }) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        // No cookies, no auth, no forwarded headers — ever.
        headers: { Accept: "image/*,video/*", "User-Agent": "Snapcast-Webhook/1.0" },
        lookup: ((_host: string, _opts: unknown, cb: (err: Error | null, addr: string, fam: number) => void) => {
          cb(null, address.address, address.family);
        }) as never,
        timeout: CONNECT_TIMEOUT_MS,
      },
      (res) => {
        clearTimeout(headersTimer);
        const remote = res.socket?.remoteAddress ?? "";
        // Belt and braces: the socket must have landed on the pinned address
        // (allowing for IPv4-mapped notation), and that address must still
        // classify as public.
        const normalizedRemote = remote.startsWith("::ffff:") ? remote.slice(7) : remote;
        const normalizedPin = address.address.startsWith("::ffff:") ? address.address.slice(7) : address.address;
        if (normalizedRemote !== normalizedPin || !isPublicAddress(remote)) {
          res.destroy();
          reject(new Error("socket connected to an unexpected address"));
          return;
        }
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: res as AsyncIterable<Uint8Array>,
          destroy: () => res.destroy(),
        });
      },
    );

    const headersTimer = setTimeout(() => {
      req.destroy(new Error("response headers timed out"));
    }, HEADERS_TIMEOUT_MS);

    req.on("timeout", () => req.destroy(new Error("connect timed out")));
    req.on("error", (err) => {
      clearTimeout(headersTimer);
      reject(err);
    });
    req.end();
  });

// -------------------------------------------------------------- downloader --
export interface SafeDownloadOptions extends UrlPolicyOptions {
  resolver?: Resolver;
  transport?: Transport;
  maxImageBytes?: number;
  maxVideoBytes?: number;
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Download webhook media with the full policy applied at every hop, into a
 * temp file, with actual bytes counted and the type read from magic bytes.
 * On success the caller owns cleanup of `tmpDir`; on failure everything is
 * already cleaned up.
 */
export async function downloadWebhookMedia(rawUrl: string, opts: SafeDownloadOptions = {}): Promise<SafeDownloadResult> {
  const resolver = opts.resolver ?? defaultResolver;
  const transport = opts.transport ?? realTransport;
  const maxImage = opts.maxImageBytes ?? MAX_IMAGE_BYTES;
  const maxVideo = opts.maxVideoBytes ?? MAX_VIDEO_BYTES;
  const idleMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const deadline = Date.now() + (opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);

  const first = validateMediaUrl(rawUrl, opts);
  if (!first.ok) return first;

  let current = first.url;
  let redirects = 0;

  for (;;) {
    const pinned = await resolvePinnedAddresses(current, resolver);
    if (!pinned.ok) return pinned;

    // Try validated addresses in order; a connect failure on one may fall
    // through to the next FROM THE SAME SNAPSHOT — never a fresh lookup.
    let response: TransportResponse | null = null;
    let lastError: unknown = null;
    for (const address of pinned.addresses) {
      try {
        response = await transport({ url: current, address });
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!response) {
      // Static messages only: raw Node network errors embed addresses and
      // occasionally request paths, which must never reach logs or callers.
      const timedOut = lastError instanceof Error && lastError.message.includes("timed out");
      return timedOut
        ? { ok: false, code: "timeout", error: "connection timed out" }
        : { ok: false, code: "connect", error: "could not connect to the media host" };
    }

    if (REDIRECT_CODES.has(response.statusCode)) {
      response.destroy();
      redirects += 1;
      if (redirects > MAX_REDIRECTS) return { ok: false, code: "too_many_redirects", error: "too many redirects" };
      const loc = response.headers.location;
      const next = resolveRedirect(current, Array.isArray(loc) ? loc[0] : loc, opts);
      if (!next.ok) return next;
      current = next.url;
      continue;
    }

    if (response.statusCode !== 200) {
      response.destroy();
      return { ok: false, code: "http_status", error: `remote responded ${response.statusCode}` };
    }

    // Early Content-Length screen against the LARGEST cap — advisory only;
    // the streamed byte count below is what actually enforces the limit.
    const declaredRaw = response.headers["content-length"];
    const declared = Number(Array.isArray(declaredRaw) ? declaredRaw[0] : declaredRaw);
    if (Number.isFinite(declared) && declared > maxVideo) {
      response.destroy();
      return { ok: false, code: "too_large", error: "declared size exceeds the limit" };
    }

    return streamToTempFile(response, current, redirects, { maxImage, maxVideo, idleMs, deadline, declared });
  }
}

async function streamToTempFile(
  response: TransportResponse,
  url: URL,
  redirects: number,
  limits: { maxImage: number; maxVideo: number; idleMs: number; deadline: number; declared: number },
): Promise<SafeDownloadResult> {
  // Local name is ours alone — never derived from the remote URL.
  const dir = await mkdtemp(path.join(tmpdir(), "snapcast-webhook-"));
  const filePath = path.join(dir, "media.bin");
  const file = createWriteStream(filePath, { mode: 0o600 });
  // A write stream with no error listener turns ANY late write failure —
  // a deadline destroying it with a write in flight, disk filling mid-stream
  // — into an uncaught exception that takes the whole process down. Caught
  // here and surfaced through the normal failure path instead.
  let fileError: Error | null = null;
  file.on("error", (err) => {
    fileError = err;
  });
  const hash = createHash("sha256");

  let total = 0;
  let detected: DetectedType | null = null;
  let sniff: Uint8Array = new Uint8Array(0);

  const fail = async (code: SafeDownloadFailure["code"], error: string): Promise<SafeDownloadFailure> => {
    response.destroy();
    // Wait for the handle to actually close before deleting: on Windows an
    // rm against an open file fails silently and would leak the temp dir.
    await new Promise<void>((res) => {
      file.once("close", () => res());
      file.destroy();
    });
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, code, error };
  };

  try {
    const iterator = response.body[Symbol.asyncIterator]();
    for (;;) {
      if (Date.now() > limits.deadline) return await fail("timeout", "download exceeded the total time limit");

      let step: IteratorResult<Uint8Array>;
      try {
        step = await withTimeout(iterator.next(), limits.idleMs, "download stalled;");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "read failed";
        return await fail(msg.includes("timed out") ? "timeout" : "connect", msg);
      }
      if (step.done) break;
      const chunk = step.value;
      if (!chunk || chunk.byteLength === 0) continue;

      total += chunk.byteLength;

      // Sniff the head once, as soon as enough bytes exist. Rejecting HTML
      // or an unknown format costs at most SNIFF_BYTES of download.
      if (!detected) {
        const merged = new Uint8Array(Math.min(SNIFF_BYTES, sniff.length + chunk.byteLength));
        merged.set(sniff.subarray(0, Math.min(sniff.length, merged.length)));
        if (sniff.length < merged.length) {
          merged.set(chunk.subarray(0, merged.length - sniff.length), sniff.length);
        }
        sniff = merged;
        if (sniff.length >= SNIFF_BYTES) {
          detected = detectMediaType(sniff);
          if (!detected) return await fail("unsupported_type", "file is not a supported image or video format");
          const cap = detected.kind === "photo" ? limits.maxImage : limits.maxVideo;
          if (Number.isFinite(limits.declared) && limits.declared > cap) {
            return await fail("too_large", "declared size exceeds the limit for this media type");
          }
        }
      }

      const cap = detected ? (detected.kind === "photo" ? limits.maxImage : limits.maxVideo) : limits.maxVideo;
      if (total > cap) return await fail("too_large", "media exceeds the size limit");

      hash.update(chunk);
      if (fileError) return await fail("storage", "temp file write failed");
      const canWriteMore = file.write(Buffer.from(chunk));
      if (!canWriteMore) {
        await new Promise<void>((res) => {
          const done = () => res();
          file.once("drain", done);
          // A stream that errors mid-backpressure never emits drain.
          file.once("error", done);
          file.once("close", done);
        });
      }
      if (fileError) return await fail("storage", "temp file write failed");
    }

    // Streams shorter than the sniff window still get one classification try.
    if (!detected) {
      detected = detectMediaType(sniff);
      if (!detected) return await fail("unsupported_type", "file is not a supported image or video format");
    }
    if (total === 0) return await fail("unsupported_type", "remote file was empty");

    await new Promise<void>((res, rej) => file.end((err: unknown) => (err ? rej(err) : res())));

    return {
      ok: true,
      filePath,
      tmpDir: dir,
      bytes: total,
      kind: detected.kind,
      contentType: detected.contentType,
      extension: detected.extension,
      sha256: hash.digest("hex"),
      hostname: url.hostname,
      redirects,
    };
  } catch (err) {
    return await fail("storage", err instanceof Error ? err.message : "failed to store the download");
  }
}
