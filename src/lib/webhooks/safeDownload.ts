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
    | "storage"
    | "busy";
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
    // Production can NEVER fetch over plain http — not even with the env
    // opt-in set. The flag exists for local development against plain-http
    // test servers, and it relaxes only the scheme, never the IP policy.
    if (!opts.allowHttp || process.env.NODE_ENV === "production") {
      return { ok: false, code: "url_policy", error: "media URL must use https" };
    }
    // Dev http is confined to port 80 or unprivileged ports — a dev server
    // on :3000 works, but privileged service ports (25, 6379, …) do not.
    const httpPort = url.port === "" ? 80 : Number(url.port);
    if (httpPort !== 80 && httpPort < 1024) {
      return { ok: false, code: "url_policy", error: "http port not allowed" };
    }
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

/** Sniffing may buffer up to this much before classification must decide. */
export const MAX_SNIFF_BYTES = 4096;

export type HeadClassification = DetectedType | null | "insufficient";

/**
 * Identify a file from its leading bytes.
 *
 * Tri-state on purpose: "insufficient" tells the STREAMING caller that a
 * structurally-declared region (an ftyp box, an EBML header) extends past
 * the bytes seen so far and classification must wait for more. With
 * `isFinal` — the stream has ended, or a plain buffer is being judged —
 * insufficiency IS rejection: a file that ends before its own declared
 * structure is truncated, not trusted.
 */
export function classifyMediaHead(head: Uint8Array, isFinal: boolean): HeadClassification {
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
  if (head.length >= 8 && ascii(4, 8) === "ftyp") {
    // ISO-BMFF covers far more than video: HEIC/HEIF/AVIF images and M4A
    // audio are all `ftyp` containers too, and an unstructured read waved
    // ftypheic through as video/mp4. The box is validated STRUCTURALLY:
    // a sane, 4-aligned declared size that must hold the mandatory 16-byte
    // header — and, critically, the DECLARED box must be fully present in
    // the classification bytes. A box claiming 24 bytes in a 16-byte file,
    // or 4096 bytes against a 64-byte window, was previously classified
    // from the fragment; both are now refused until the whole box is seen.
    if (head.length < 16) return isFinal ? null : "insufficient";
    const boxSize = (head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3];
    if (boxSize < 16 || boxSize > MAX_SNIFF_BYTES || boxSize % 4 !== 0) return null;
    if (head.length < boxSize) return isFinal ? null : "insufficient";
    // Major brand is EXACT — "qt  " (two trailing spaces) is QuickTime;
    // startsWith("qt") also matched invented brands like "qtab".
    const brand = ascii(8, 12);
    if (brand === "qt  ") return { kind: "video", contentType: "video/quicktime", extension: "mov" };
    const MP4_VIDEO_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "mp4v", "avc1", "dash", "M4V ", "M4VP"]);
    if (MP4_VIDEO_BRANDS.has(brand)) return { kind: "video", contentType: "video/mp4", extension: "mp4" };
    return null;
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const webm = classifyWebm(head);
    if (webm === "insufficient") return isFinal ? null : "insufficient";
    return webm ? { kind: "video", contentType: "video/webm", extension: "webm" } : null;
  }
  // Everything else — HTML, JSON, SVG/XML, PDF, archives, executables,
  // formats we don't render — is rejected by not being recognised. Short
  // unmatched heads may still grow into a signature mid-stream.
  if (head.length < SNIFF_BYTES && !isFinal) return "insufficient";
  return null;
}

/** Buffer-level shim retaining the old boolean/null contract for callers
 *  and tests judging a COMPLETE buffer. */
export function detectMediaType(head: Uint8Array): DetectedType | null {
  const c = classifyMediaHead(head, true);
  return c === "insufficient" ? null : c;
}

/**
 * EBML variable-length integer at `pos`.
 *
 * Distinguishes three failure shapes because they mean different things to
 * a streaming parser: "invalid" (no marker bit — corrupt, reject),
 * "truncated" (the vint's own bytes run past the buffer — wait or reject),
 * and the all-ones "unknown size" value, which is legal EBML but unusable
 * for bounding a header, so this parser treats it as invalid.
 */
function readVint(
  buf: Uint8Array,
  pos: number,
): { value: number; width: number } | "truncated" | "invalid" {
  if (pos >= buf.length) return "truncated";
  const first = buf[pos];
  if (first === 0) return "invalid"; // no marker bit
  let width = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    width += 1;
    mask >>= 1;
  }
  if (pos + width > buf.length) return "truncated";
  let value = first & (mask - 1);
  for (let i = 1; i < width; i++) value = value * 256 + buf[pos + i];
  // All value bits set = EBML "unknown size" — meaningless as a bound.
  if (value === Math.pow(2, 7 * width) - 1) return "invalid";
  return { value, width };
}

/**
 * Structural WebM check over an EBML header.
 *
 * Parsed, not scanned — and the COMPLETE declared header must be present
 * before anything is accepted. Previously an early DocType inside a header
 * that declared 127 bytes with only 64 available was accepted from the
 * fragment; now that case reports "insufficient" (reject when final) until
 * the declared bytes actually exist. Invalid vints, the all-ones unknown
 * size, elements overrunning the header, a Matroska DocType, and "webm"
 * floating in unstructured bytes all fail.
 */
function classifyWebm(head: Uint8Array): boolean | "insufficient" {
  const headerSize = readVint(head, 4);
  if (headerSize === "truncated") return "insufficient";
  if (headerSize === "invalid") return false;
  const headerStart = 4 + headerSize.width;
  const headerEnd = headerStart + headerSize.value;
  if (headerEnd > MAX_SNIFF_BYTES) return false; // absurd header for a real file
  // The whole declared header must be on hand before any element is judged.
  if (headerEnd > head.length) return "insufficient";

  let pos = headerStart;
  // Walk child elements: 2-byte element IDs in the EBML header space.
  while (pos + 2 <= headerEnd) {
    const id = (head[pos] << 8) | head[pos + 1];
    const size = readVint(head, pos + 2);
    if (size === "truncated" || size === "invalid") return false; // header bytes are all present — this is corruption
    const valueStart = pos + 2 + size.width;
    const valueEnd = valueStart + size.value;
    if (valueEnd > headerEnd) return false; // element overruns the header
    if (id === 0x4282) {
      const doctype = String.fromCharCode(...head.subarray(valueStart, valueEnd));
      return doctype === "webm";
    }
    pos = valueEnd;
  }
  return false; // no DocType inside the EBML header
}

/** Complete-buffer boolean wrapper, kept for tests and external callers. */
export function detectWebm(head: Uint8Array): boolean {
  return classifyWebm(head) === true;
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
  /** Overridable so real-socket fixtures can run in test time, not wall time. */
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  /** Cancellation from the operation-wide deadline. */
  signal?: AbortSignal;
  /**
   * TEST-ONLY: a fixture CA for the local TLS server. Providing a ca
   * REPLACES the trust store — certificate and hostname verification still
   * run in full, which is exactly what the TLS fixture proves. Production
   * callers never set this.
   */
  ca?: string;
}) => Promise<TransportResponse>;

/**
 * Real transport: node:https with the lookup callback OVERRIDDEN to return
 * the pinned, already-validated address. The hostname still flows into the
 * Host header, into TLS SNI, and into certificate verification — only the
 * socket's destination is forced. After connect, the socket's actual remote
 * address is checked against the pin, so even a hijacked lookup path can't
 * silently land elsewhere.
 */
export const realTransport: Transport = ({ url, address, connectTimeoutMs = CONNECT_TIMEOUT_MS, headersTimeoutMs = HEADERS_TIMEOUT_MS, ca, signal }) =>
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
        ...(ca ? { ca } : {}),
        ...(signal ? { signal } : {}),
        // NO CONNECTION POOLING. The keep-alive agent reuses an existing
        // socket for a matching host:port, and a reused socket never runs
        // our lookup — so a request pinned to a NEW address rode an OLD
        // server's socket, delivering the signed path and query before any
        // address validation could run. Independently reproduced. agent
        // false forces a fresh socket, so the pinned lookup executes on
        // EVERY request and no request bytes exist before the destination
        // is the validated one.
        agent: false,
        // Node's agent calls lookup in TWO forms, and on Node 22 the default
        // is `{ all: true }`, which expects an ARRAY of address objects.
        // Answering with the single-address form there yields
        // "Invalid IP address: undefined" and every hostname download fails
        // before connecting — found by an independent real-socket probe, not
        // by the injected-transport tests. Both forms are now answered.
        lookup: ((_host: string, options: { all?: boolean }, cb: (err: Error | null, ...rest: never[]) => void) => {
          if (options && options.all) {
            (cb as (e: Error | null, a: { address: string; family: number }[]) => void)(null, [
              { address: address.address, family: address.family },
            ]);
          } else {
            (cb as (e: Error | null, a: string, f: number) => void)(null, address.address, address.family);
          }
        }) as never,
      },
      (res) => {
        clearTimeout(headersTimer);
        const remote = res.socket?.remoteAddress ?? "";
        // Belt and braces: the socket must have landed on the pinned address
        // (allowing for IPv4-mapped notation).
        const normalizedRemote = remote.startsWith("::ffff:") ? remote.slice(7) : remote;
        const normalizedPin = address.address.startsWith("::ffff:") ? address.address.slice(7) : address.address;
        // Equality to the pin is the invariant — the pin was validated
        // upstream, so matching it transfers that validation to the socket.
        if (normalizedRemote !== normalizedPin) {
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

    // Two SEPARATE timers with distinct jobs. The connect timer runs only
    // until the transport layer is actually up — "connect" for http,
    // "secureConnect" for https so the TLS handshake is included — and is
    // cleared the moment that fires. The headers timer starts at request
    // time and runs until the response arrives. Node's own `timeout` option
    // is not used at all: it is a socket INACTIVITY timer that survives into
    // the body phase, which is how a 5s "connect" timeout was killing 15s
    // body stalls.
    let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      req.destroy(new Error("connect timed out"));
    }, connectTimeoutMs);

    req.on("socket", (socket) => {
      const connectedEvent = isHttps ? "secureConnect" : "connect";
      socket.once(connectedEvent, () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      });
    });

    const headersTimer = setTimeout(() => {
      req.destroy(new Error("response headers timed out"));
    }, headersTimeoutMs);

    req.on("error", (err) => {
      if (connectTimer) clearTimeout(connectTimer);
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
  // The total budget covers EVERYTHING — DNS, every connect attempt, headers,
  // every redirect hop, and the body. Before this it only policed the body
  // loop, so hostile DNS plus slow connects across redirect hops could hold
  // a request open well past the advertised limit.
  const timeLeft = () => deadline - Date.now();

  const first = validateMediaUrl(rawUrl, opts);
  if (!first.ok) return first;

  // ONE absolute, cancellable deadline for the whole operation — including
  // the time spent waiting in the queue below. When it fires, the signal
  // DESTROYS in-flight work (the real transport passes it to Node's request)
  // rather than merely rejecting a wrapper promise around it.
  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), Math.max(1, timeLeft()));

  try {
    // Process-wide concurrency brake: the account quota allows a burst of
    // 120 authenticated requests a minute, and each one used to walk
    // straight into a potentially-150MB download. Queue waits are abortable:
    // a request whose deadline expires while queued is removed atomically
    // and can never later acquire a permit.
    const slot = await acquireDownloadSlot(ac.signal);
    if (slot === "busy") return { ok: false, code: "busy", error: "too many downloads in progress — retry shortly" };
    if (slot === "aborted") return { ok: false, code: "timeout", error: "download exceeded the total time limit" };

    try {
      return await runDownload(first.url, {
        resolver,
        transport,
        maxImage,
        maxVideo,
        idleMs,
        deadline,
        timeLeft,
        opts,
        signal: ac.signal,
      });
    } finally {
      releaseDownloadSlot();
    }
  } finally {
    clearTimeout(abortTimer);
  }
}

// Two active downloads, a short bounded queue, everything else refused.
export const MAX_CONCURRENT_DOWNLOADS = 2;
export const MAX_WAITING_DOWNLOADS = 8;
let activeDownloads = 0;
interface SlotWaiter {
  grant: () => void;
  abort: () => void;
}
const waiters: SlotWaiter[] = [];

/** Test-only visibility: how many requests are queued right now. */
export function downloadQueueDepth(): number {
  return waiters.length;
}

async function acquireDownloadSlot(signal: AbortSignal): Promise<"granted" | "busy" | "aborted"> {
  if (signal.aborted) return "aborted";
  if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    activeDownloads += 1;
    return "granted";
  }
  if (waiters.length >= MAX_WAITING_DOWNLOADS) return "busy";

  return new Promise<"granted" | "aborted">((resolve) => {
    const waiter: SlotWaiter = {
      grant: () => {
        signal.removeEventListener("abort", onAbort);
        activeDownloads += 1;
        resolve("granted");
      },
      abort: () => resolve("aborted"),
    };
    const onAbort = () => {
      // Atomic removal: an aborted waiter leaves the queue immediately and
      // a later release can never resurrect it.
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      waiter.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.push(waiter);
  });
}

function releaseDownloadSlot(): void {
  activeDownloads -= 1;
  const next = waiters.shift();
  if (next) next.grant();
}

async function runDownload(
  startUrl: URL,
  ctx: {
    resolver: Resolver;
    transport: Transport;
    maxImage: number;
    maxVideo: number;
    idleMs: number;
    deadline: number;
    timeLeft: () => number;
    opts: SafeDownloadOptions;
    signal: AbortSignal;
  },
): Promise<SafeDownloadResult> {
  const { resolver, transport, maxImage, maxVideo, idleMs, deadline, timeLeft, opts, signal } = ctx;
  let current = startUrl;
  let redirects = 0;

  for (;;) {
    if (timeLeft() <= 0) return { ok: false, code: "timeout", error: "download exceeded the total time limit" };

    let pinned: Awaited<ReturnType<typeof resolvePinnedAddresses>>;
    try {
      pinned = await withTimeout(
        resolvePinnedAddresses(current, resolver),
        Math.min(DNS_TIMEOUT_MS, Math.max(1, timeLeft())),
        "DNS resolution",
      );
    } catch {
      // Honest limitation: dns.promises offers no cancellation, so an expired
      // lookup keeps running in the background — but its result is discarded
      // here and can never influence this operation: no pinned set is built
      // and the download fails now.
      return { ok: false, code: "timeout", error: "DNS resolution timed out" };
    }
    if (!pinned.ok) return pinned;

    // Try validated addresses in order; a connect failure on one may fall
    // through to the next FROM THE SAME SNAPSHOT — never a fresh lookup.
    // Deduplicated and capped: a hostile zone can return hundreds of
    // records, and each is otherwise a fresh 5-second connect attempt.
    const candidates: ResolvedAddress[] = [];
    const seen = new Set<string>();
    for (const a of pinned.addresses) {
      if (!seen.has(a.address)) {
        seen.add(a.address);
        candidates.push(a);
      }
      if (candidates.length >= 4) break;
    }

    let response: TransportResponse | null = null;
    let lastError: unknown = null;
    for (const address of candidates) {
      if (timeLeft() <= 0) return { ok: false, code: "timeout", error: "download exceeded the total time limit" };
      try {
        response = await withTimeout(
          transport({ url: current, address, signal }),
          Math.min(CONNECT_TIMEOUT_MS + HEADERS_TIMEOUT_MS, Math.max(1, timeLeft())),
          "connection attempt",
        );
        break;
      } catch (err) {
        lastError = err;
        // LOW finding: when the ABSOLUTE deadline fired mid-connect/TLS/
        // headers, the AbortError used to be classified as "connect". The
        // operation ran out of time — say so, with a sanitized message.
        if (signal.aborted) {
          return { ok: false, code: "timeout", error: "download exceeded the total time limit" };
        }
      }
    }
    if (!response) {
      // Static messages only: raw Node network errors embed addresses and
      // occasionally request paths, which must never reach logs or callers.
      //
      // Classification order matters: when the absolute deadline's signal
      // has fired, the transport surfaces an AbortError whose message says
      // nothing about time — reporting that as "connect" blamed the remote
      // host for our own expired budget. The signal's state (and the
      // AbortError name, for aborts that raced the flag) decides first.
      const aborted =
        signal.aborted || (lastError instanceof Error && lastError.name === "AbortError");
      const timedOut = aborted || (lastError instanceof Error && lastError.message.includes("timed out"));
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
  // Setup failures (tmpdir full, permissions) get a static message too —
  // a raw ENOENT/EACCES carries local filesystem paths.
  let dir: string;
  let file: ReturnType<typeof createWriteStream>;
  try {
    // Local name is ours alone — never derived from the remote URL.
    dir = await mkdtemp(path.join(tmpdir(), "snapcast-webhook-"));
    const filePath0 = path.join(dir, "media.bin");
    file = createWriteStream(filePath0, { mode: 0o600 });
  } catch {
    response.destroy();
    return { ok: false, code: "storage", error: "could not prepare temporary storage" };
  }
  const filePath = path.join(dir, "media.bin");
  // A write stream with no error listener turns ANY late write failure —
  // a deadline destroying it with a write in flight, disk filling mid-stream
  // — into an uncaught exception that takes the whole process down. Caught
  // here and surfaced through the normal failure path instead.
  let fileError: Error | null = null;
  file.on("error", (err) => {
    fileError = err;
  });
  // Deterministic close tracking, armed BEFORE anything can destroy the
  // stream. fs write streams emit exactly one "close" from every terminal
  // path — end(), destroy(), or error (autoClose) — so this promise settles
  // for open, errored, destroyed, and already-closed states alike, with no
  // timer race and no orphan listeners.
  const fileClosed = new Promise<void>((res) => file.once("close", () => res()));
  const hash = createHash("sha256");

  let total = 0;
  let detected: DetectedType | null = null;
  let sniff: Uint8Array = new Uint8Array(0);

  const fail = async (code: SafeDownloadFailure["code"], error: string): Promise<SafeDownloadFailure> => {
    response.destroy();
    // Never rm while the handle may still be open: on Windows that fails
    // silently and leaks the temp dir. destroy() is idempotent, and the
    // close promise above resolves for every terminal state — including if
    // the stream closed long before this ran.
    file.destroy();
    await fileClosed;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, code, error };
  };

  try {
    const iterator = response.body[Symbol.asyncIterator]();
    for (;;) {
      if (Date.now() > limits.deadline) return await fail("timeout", "download exceeded the total time limit");

      let step: IteratorResult<Uint8Array>;
      try {
        // Each body wait is bounded by BOTH clocks: the idle allowance and
        // whatever remains of the absolute deadline. A 15s idle limit can
        // never carry a request past a 100ms total budget.
        const wait = Math.max(1, Math.min(limits.idleMs, limits.deadline - Date.now()));
        step = await withTimeout(iterator.next(), wait, "download stalled;");
      } catch (err) {
        // Static text only: stream errors can embed local paths or peer
        // addresses, which belong in neither logs nor responses.
        const timedOut = err instanceof Error && err.message.includes("timed out");
        return await fail(timedOut ? "timeout" : "connect", timedOut ? "download stalled" : "download connection failed");
      }
      if (step.done) break;
      const chunk = step.value;
      if (!chunk || chunk.byteLength === 0) continue;

      total += chunk.byteLength;

      // Classify from the head as soon as the structure allows. Tri-state:
      // a declared ftyp box or EBML header larger than the bytes seen so
      // far reports "insufficient" and buffering continues — up to
      // MAX_SNIFF_BYTES, past which nothing legitimate is still undecided.
      // Rejecting HTML or an unknown format still costs only a few bytes.
      if (!detected) {
        const merged = new Uint8Array(Math.min(MAX_SNIFF_BYTES, sniff.length + chunk.byteLength));
        merged.set(sniff.subarray(0, Math.min(sniff.length, merged.length)));
        if (sniff.length < merged.length) {
          merged.set(chunk.subarray(0, merged.length - sniff.length), sniff.length);
        }
        sniff = merged;
        const classified = classifyMediaHead(sniff, false);
        if (classified === null) {
          return await fail("unsupported_type", "file is not a supported image or video format");
        }
        if (classified === "insufficient") {
          if (sniff.length >= MAX_SNIFF_BYTES) {
            return await fail("unsupported_type", "file is not a supported image or video format");
          }
        } else {
          detected = classified;
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
        // ONE settle function owns every exit — drain, error, close, and the
        // idle/deadline guard alike. Whichever fires first removes ALL of
        // its rivals and clears the timer, so no listeners accumulate and no
        // path can quietly keep writing after a timeout: a guard-timer win
        // fails the download right here instead of allowing another write.
        const reason = await new Promise<"settled" | "timeout">((res) => {
          const onEvent = () => settle("settled");
          const settle = (r: "settled" | "timeout") => {
            clearTimeout(guard);
            file.off("drain", onEvent);
            file.off("error", onEvent);
            file.off("close", onEvent);
            res(r);
          };
          const guard = setTimeout(
            () => settle("timeout"),
            Math.max(1, Math.min(limits.idleMs, limits.deadline - Date.now())),
          );
          file.once("drain", onEvent);
          // A stream that errors mid-backpressure never emits drain.
          file.once("error", onEvent);
          file.once("close", onEvent);
        });
        if (reason === "timeout") return await fail("timeout", "download exceeded the total time limit");
      }
      if (fileError) return await fail("storage", "temp file write failed");
    }

    // The stream has ENDED: a final classification where insufficiency is
    // rejection — a file that ends before its own declared structure is
    // truncated, exactly the case that was previously waved through.
    if (!detected) {
      detected = detectMediaType(sniff);
      if (!detected) return await fail("unsupported_type", "file is not a supported image or video format");
    }
    if (total === 0) return await fail("unsupported_type", "remote file was empty");

    // Success must await the CONFIRMED close, not merely "finish": the
    // storage adapter copies this file next, and an unflushed handle is a
    // race on Windows in particular. Finalization draws on the SAME absolute
    // deadline as everything else — a flush that outlives the budget is
    // destroyed and reported as a controlled timeout, never awaited forever.
    const finalized = await Promise.race([
      new Promise<"closed">((res, rej) =>
        file.end((err: unknown) => (err ? rej(err) : fileClosed.then(() => res("closed")))),
      ),
      new Promise<"timeout">((res) =>
        setTimeout(() => res("timeout"), Math.max(1, limits.deadline - Date.now())),
      ),
    ]);
    if (finalized === "timeout") return await fail("timeout", "download exceeded the total time limit");
    if (fileError) return await fail("storage", "temp file write failed");

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
  } catch {
    return await fail("storage", "failed to store the download");
  }
}
