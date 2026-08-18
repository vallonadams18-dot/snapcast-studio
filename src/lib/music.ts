// Server-only: real ffmpeg + fetch calls (node:child_process). Never import
// this from a "use client" component — the plain data (MUSIC_CATALOG,
// suggestTrackForEventType, getTrackById) lives in lib/musicCatalog.ts,
// which is safe for the browser bundle. Mixing this file's Node-only code
// into a client component's bundle is a hard Turbopack build error.
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFfmpegPath } from "@/lib/ffmpegPaths";
import { deliveryEncode } from "@/lib/encoding";
import { pickHighEnergyStart } from "@/lib/audioEnergy";

export { MUSIC_CATALOG, suggestTrackForEventType, getTrackById, type MusicTrack } from "@/lib/musicCatalog";

// Maps each catalog category to real Epidemic Sound search terms.
// Verified against the live API — Epidemic Sound's genre/mood values are a
// fixed taxonomy, not free text; an unrecognized id (e.g. "piano" instead
// of "solo-piano") silently returns zero results rather than erroring, so
// each of these was checked with a real search call, not guessed.
const EPIDEMIC_SEARCH: Record<string, { term: string; mood?: string; genre?: string }> = {
  "upbeat-pop": { term: "upbeat pop", mood: "euphoric" },
  "emotional-piano": { term: "emotional piano", mood: "sentimental", genre: "solo-piano" },
  "warm-acoustic": { term: "warm acoustic wedding", genre: "acoustic", mood: "peaceful" },
  "corporate-clean": { term: "clean corporate motivational", genre: "corporate" },
  "high-energy-edm": { term: "high energy edm", genre: "edm" },
  "feel-good-indie": { term: "feel good indie", genre: "indie-pop" },
};

const EPIDEMIC_API_BASE = "https://partner-content-api.epidemicsound.com/v0";

// Same guard as lib/ai.ts: a masked key (the "epidemic_live_••••" form sites
// show when hiding a secret) contains U+2022 bullets, which can't go in an
// HTTP header. Without this the request dies inside fetch with an opaque
// ByteString error and clips silently fall back to no music.
function getEpidemicApiKey(): string | null {
  const key = process.env.EPIDEMIC_SOUND_API_KEY;
  if (!key) return null;
  if (!/^[\x20-\x7E]+$/.test(key)) {
    console.error(
      "[music] EPIDEMIC_SOUND_API_KEY contains non-ASCII characters and cannot be used. " +
        "This usually means a masked version of the key was copied instead of the real one.",
    );
    return null;
  }
  return key;
}

interface EpidemicSearchResult {
  id: string;
  title: string;
  // Carried through so a montage can start the track at a loud section
  // rather than 0:00. Both come back on the same search response the picker
  // already uses — they were simply being discarded here.
  waveformUrl: string | null;
  lengthSeconds: number | null;
}

// What the browser needs to render a track row in the library picker.
export interface LibraryTrack {
  id: string;
  title: string;
  artist: string;
  bpm: number | null;
  lengthSeconds: number;
  moods: string[];
  genres: string[];
  waveformUrl: string | null;
  /** Epidemic's own flag. Most of the catalog is instrumental. */
  hasVocals: boolean;
  /** "NONE" | "PRESENCE" (backing/ad-libs) | "LEAD" (sung throughout). */
  vocalType: string | null;
  /** Release artwork. Makes the list scannable instead of a wall of text. */
  imageUrl: string | null;
  isExplicit: boolean;
}

/** A mood/genre facet with how many tracks carry it, straight from the API. */
export interface LibraryFacet {
  id: string;
  name: string;
  count: number;
}

export interface LibrarySearchResult {
  tracks: LibraryTrack[];
  moods: LibraryFacet[];
  genres: LibraryFacet[];
}

interface RawTrack {
  id: string;
  title: string;
  mainArtists?: string[];
  bpm?: number;
  length?: number;
  moods?: { name: string }[];
  genres?: { name: string }[];
  waveformUrl?: string;
  hasVocals?: boolean;
  vocalType?: string;
  isExplicit?: boolean;
  images?: { XS?: string; S?: string; default?: string };
}

function toLibraryTrack(t: RawTrack): LibraryTrack {
  return {
    id: t.id,
    title: t.title,
    artist: t.mainArtists?.join(", ") ?? "Unknown artist",
    bpm: t.bpm ?? null,
    lengthSeconds: t.length ?? 0,
    moods: (t.moods ?? []).map((m) => m.name),
    genres: (t.genres ?? []).map((g) => g.name),
    waveformUrl: t.waveformUrl ?? null,
    hasVocals: Boolean(t.hasVocals),
    vocalType: t.vocalType ?? null,
    imageUrl: t.images?.S ?? t.images?.default ?? t.images?.XS ?? null,
    isExplicit: Boolean(t.isExplicit),
  };
}

export interface LibrarySearchOptions {
  mood?: string | null;
  genre?: string | null;
  /** "vocals" narrows to sung tracks, "instrumental" excludes them. */
  vocals?: "any" | "vocals" | "instrumental";
  limit?: number;
}

/**
 * Free-text search across the licensed catalog, for the browse-and-pick UI.
 *
 * THROWS on API failure rather than returning []. Swallowing the error made a
 * dead API key and a genuinely empty result set look identical in the UI —
 * "No tracks found. Try another search." — which is the worst possible thing
 * to tell someone whose search was actually fine.
 *
 * Only parameters verified against the live API are sent. Checked directly:
 *   mood=, genre=       work, and work with no term at all (so, browse)
 *   vocalType=LEAD      works — 20/20 sung vs 8/20 unfiltered
 *   hasVocals=true      SILENTLY IGNORED, returns the unfiltered set
 *   bpmMin/bpmMax       SILENTLY IGNORED
 *   page=2              SILENTLY IGNORED, returns page 1 again
 * BPM and the instrumental-only case are therefore filtered here, not there.
 */
export async function searchLibrary(term: string, options: LibrarySearchOptions = {}): Promise<LibrarySearchResult> {
  const apiKey = getEpidemicApiKey();
  if (!apiKey) {
    throw new Error("No music library is connected. Add an Epidemic Sound API key to enable search.");
  }

  const wantsVocals = options.vocals === "vocals";
  // Ask for extra when we intend to filter locally, so narrowing doesn't
  // empty the list.
  const requested = Math.min(60, options.limit ?? 30);
  const params = new URLSearchParams({ limit: String(requested) });

  // A term is optional when browsing by facet — "all the house tracks" is a
  // legitimate query, and forcing a filler term would skew it.
  if (term) params.set("term", term);
  else if (!options.mood && !options.genre) params.set("term", "event");

  if (options.mood) params.set("mood", options.mood);
  if (options.genre) params.set("genre", options.genre);
  // LEAD is the only value that reliably narrows, and it is what someone
  // asking for "songs with singing" actually means.
  if (wantsVocals) params.set("vocalType", "LEAD");

  const response = await fetch(`${EPIDEMIC_API_BASE}/tracks/search?${params}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("[music] library search failed", response.status, detail.slice(0, 200));
    throw new Error(
      response.status === 401 || response.status === 403
        ? "The music library rejected our credentials. The API key may have expired."
        : `The music library is unavailable right now (error ${response.status}).`,
    );
  }

  const data = (await response.json()) as {
    tracks?: RawTrack[];
    aggregations?: { moods?: LibraryFacet[]; genres?: LibraryFacet[] };
  };

  let tracks = (data.tracks ?? []).map(toLibraryTrack);
  if (options.vocals === "instrumental") tracks = tracks.filter((t) => !t.hasVocals);

  return {
    tracks,
    moods: (data.aggregations?.moods ?? []).slice(0, 14),
    genres: (data.aggregations?.genres ?? []).slice(0, 14),
  };
}

// Resolves a track's licensed MP3 URL. Used by the preview proxy so the API
// key never reaches the browser.
export async function getTrackAudioUrl(trackId: string): Promise<string | null> {
  const apiKey = getEpidemicApiKey();
  if (!apiKey) return null;
  const response = await fetch(`${EPIDEMIC_API_BASE}/tracks/${trackId}/download?quality=normal`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    console.error("[music] preview link failed", trackId, response.status);
    return null;
  }
  const { url } = (await response.json()) as { url: string };
  return url;
}

/** Categories where a sung track beats an instrumental one. */
const PREFERS_VOCALS = new Set(["upbeat-pop", "high-energy-edm", "feel-good-indie"]);

async function runEpidemicSearch(
  apiKey: string,
  params: URLSearchParams,
  catalogId?: string,
): Promise<EpidemicSearchResult | null> {
  const response = await fetch(`${EPIDEMIC_API_BASE}/tracks/search?${params}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    console.error("[music] Epidemic Sound search failed", response.status, await response.text().catch(() => ""));
    return null;
  }
  const data = (await response.json()) as { tracks: RawTrack[] };
  const tracks = data.tracks ?? [];
  if (tracks.length === 0) return null;

  // Do NOT just take tracks[0].
  //
  // That was why every auto-generated video for a given event type came back
  // with the same piece of music: a fixed search term produces a stable
  // ranking, and always taking the top hit makes the choice deterministic.
  // A photo booth posting three recaps a week noticed immediately.
  //
  // Instead pick from the strongest handful. Sung tracks are promoted for the
  // energetic categories — the catalog skews heavily instrumental (typically
  // 8 of 20 results have vocals at all), so without this the upbeat styles
  // sound like background music.
  const pool = tracks.slice(0, 12);
  const preferred = catalogId && PREFERS_VOCALS.has(catalogId) ? pool.filter((t) => t.hasVocals) : [];
  // Only honour the preference if it leaves a real choice; otherwise a thin
  // result set would collapse back to one deterministic track.
  const candidates = preferred.length >= 3 ? preferred : pool;
  const track = candidates[Math.floor(Math.random() * candidates.length)];

  return {
    id: track.id,
    title: track.title,
    waveformUrl: track.waveformUrl ?? null,
    lengthSeconds: track.length ?? null,
  };
}

async function searchEpidemicTrack(catalogId: string): Promise<EpidemicSearchResult | null> {
  const apiKey = getEpidemicApiKey();
  const query = EPIDEMIC_SEARCH[catalogId];
  if (!apiKey || !query) return null;

  const filtered = new URLSearchParams({ term: query.term, limit: "20" });
  if (query.mood) filtered.append("mood", query.mood);
  if (query.genre) filtered.append("genre", query.genre);

  const result = await runEpidemicSearch(apiKey, filtered, catalogId);
  if (result) return result;

  // An unrecognized mood/genre id silently returns zero results rather than
  // erroring — retry on the search term alone so one bad filter combo never
  // fully blocks music for that category.
  if (query.mood || query.genre) {
    console.error("[music] Filtered search empty for", catalogId, "— retrying on term alone");
    return runEpidemicSearch(apiKey, new URLSearchParams({ term: query.term, limit: "20" }), catalogId);
  }
  return null;
}

async function downloadEpidemicTrack(trackId: string): Promise<Buffer> {
  const apiKey = getEpidemicApiKey();
  if (!apiKey) throw new Error("No Epidemic Sound API key configured");

  const linkResponse = await fetch(`${EPIDEMIC_API_BASE}/tracks/${trackId}/download?quality=normal`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!linkResponse.ok) {
    throw new Error(`Epidemic Sound download link request failed: ${linkResponse.status}`);
  }
  const { url } = (await linkResponse.json()) as { url: string; expires: string };

  const audioResponse = await fetch(url);
  if (!audioResponse.ok) throw new Error(`Failed to fetch licensed audio file: ${audioResponse.status}`);
  return Buffer.from(await audioResponse.arrayBuffer());
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`))));
  });
}

// Searches Epidemic Sound for a track matching the catalog category,
// downloads the licensed file, and replaces the clip's audio track with it
// (trimmed to the clip's length, faded out at the end). Returns the mixed
// video's bytes, or null if there's no API key / no match — callers should
// fall back to leaving the clip's original audio untouched in that case.
export async function mixTrackIntoClip(
  clipVideoBuffer: Buffer,
  catalogId: string,
  clipDurationSeconds: number,
  // When set, use this exact Epidemic track instead of searching the broad
  // catalog category — this is the client's own pick from the library.
  explicitTrackId?: string | null,
  // Where in the track to start, in seconds. Lets the client choose the
  // drop/chorus rather than always getting the intro.
  startSeconds?: number | null,
  // NonSharedBuffer (what fs.readFile returns) rather than plain Buffer, so
  // callers can reassign the result onto a readFile-derived variable.
): Promise<Buffer<ArrayBuffer> | null> {
  const apiKey = getEpidemicApiKey();
  if (!apiKey) return null;

  let trackId = explicitTrackId ?? null;
  let waveformUrl: string | null = null;
  let trackLengthSeconds: number | null = null;

  if (!trackId) {
    const found = await searchEpidemicTrack(catalogId);
    if (!found) {
      console.error("[music] No Epidemic Sound match for catalog category", catalogId);
      return null;
    }
    trackId = found.id;
    waveformUrl = found.waveformUrl;
    trackLengthSeconds = found.lengthSeconds;
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-music-"));
  try {
    const audioBuffer = await downloadEpidemicTrack(trackId);
    const audioPath = path.join(tmpDir, "track.mp3");
    await writeFile(audioPath, audioBuffer);

    const videoPath = path.join(tmpDir, "input.mp4");
    await writeFile(videoPath, clipVideoBuffer);
    const outputPath = path.join(tmpDir, "output.mp4");

    // Where in the track to begin.
    //
    // A caller-supplied value is ALWAYS honoured — that is the client having
    // dragged the handle on the waveform, and second-guessing an explicit
    // choice would be worse than any default. Only when nothing was chosen
    // do we go looking for a loud section: starting every auto-generated
    // video at 0:00 meant opening on the track's intro, which is the
    // sparsest, quietest part of almost any produced piece of music.
    let start: number;
    if (typeof startSeconds === "number") {
      start = Math.max(0, startSeconds);
    } else {
      const pick = await pickHighEnergyStart({
        waveformUrl,
        audioPath,
        trackLengthSeconds,
        windowSeconds: clipDurationSeconds,
      });
      start = pick.startSeconds;
      console.log(`[music] auto start ${start.toFixed(1)}s for track ${trackId} (via ${pick.source})`);
    }

    // atrim works in absolute track time, so the window is start → start+len.
    // asetpts rebases the trimmed audio to zero; without it the audio keeps
    // its original timestamps and stays silent until that point in the track
    // would have arrived.
    const end = start + clipDurationSeconds;
    const fadeStart = Math.max(0, clipDurationSeconds - 1);
    await runFfmpeg([
      "-i", videoPath,
      "-i", audioPath,
      "-filter_complex",
      `[1:a]atrim=${start}:${end},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.4,afade=t=out:st=${fadeStart}:d=1[aout]`,
      "-map", "0:v",
      "-map", "[aout]",
      // Re-encode (not -c:v copy) and hard-cap with -t: some source videos
      // (e.g. photo montages, which pass through a concat-demuxer step)
      // carry timestamps that make -shortest alone unreliable — it once let
      // a 7.5s video come out 2 minutes long once mixed with a longer track.
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      ...deliveryEncode(),
      "-c:a", "aac",
      "-t", String(clipDurationSeconds),
      "-y", outputPath,
    ]);

    return await readFile(outputPath);
  } catch (err) {
    console.error("[music] Failed to mix licensed track into clip", err);
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
