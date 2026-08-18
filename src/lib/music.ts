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

  // Vocals is the DEFAULT, not an opt-in. Event recaps are social videos and
  // people expect songs, not underscore. The catalog skews the other way —
  // roughly 8 of 20 unfiltered results have any vocals, and for "wedding" or
  // "luxury" it is closer to 1 or 2 — so leaving this at "any" meant a wall
  // of instrumentals no matter what was searched for.
  const mode: NonNullable<LibrarySearchOptions["vocals"]> = options.vocals ?? "vocals";
  const wantsVocals = mode === "vocals";
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

  if (mode === "instrumental") {
    tracks = tracks.filter((t) => !t.hasVocals);
  } else if (wantsVocals) {
    // Below this, a "Vocals" search looks broken rather than selective.
    const MIN_VOCAL_RESULTS = 8;
    if (tracks.length < MIN_VOCAL_RESULTS) {
      // Top up rather than hiding everything. Some searches genuinely have
      // few sung tracks ("luxury" returns 1 of 20), and an almost-empty list
      // is worse than a labelled mix — every row carries a VOCALS or
      // INSTRUMENTAL badge, so the fallback is never passed off as a match.
      const topUpParams = new URLSearchParams(params);
      topUpParams.delete("vocalType");
      const extra = await fetch(`${EPIDEMIC_API_BASE}/tracks/search?${topUpParams}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      })
        .then((r) => (r.ok ? r.json() : { tracks: [] }))
        .then((d: { tracks?: RawTrack[] }) => (d.tracks ?? []).map(toLibraryTrack))
        .catch(() => [] as LibraryTrack[]);

      const seen = new Set(tracks.map((t) => t.id));
      tracks = [...tracks, ...extra.filter((t) => !seen.has(t.id))];
    }
    // Sung first, and a lead vocal ahead of backing, so the top of the list
    // is always what was actually asked for.
    tracks.sort((a, b) => vocalRank(b) - vocalRank(a));
  }

  return {
    tracks,
    moods: (data.aggregations?.moods ?? []).slice(0, 14),
    genres: (data.aggregations?.genres ?? []).slice(0, 14),
  };
}

/** LEAD beats backing beats instrumental. */
function vocalRank(t: LibraryTrack): number {
  if (t.vocalType === "LEAD") return 3;
  if (t.hasVocals) return 2;
  return 0;
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

async function runEpidemicSearch(
  apiKey: string,
  params: URLSearchParams,
  /** When true, report no match rather than settling for instrumentals. */
  requireVocals = false,
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
  // Vocals are preferred for EVERY category, not just the energetic ones.
  // A wedding or corporate recap is still a social video, and a sung track
  // is what makes it feel like content rather than a slideshow.
  //
  // Stepped rather than absolute: a lead vocal is best, backing vocals next,
  // and only if neither leaves a real choice does it fall back to the whole
  // pool — a thin result set must not collapse back to one fixed track.
  const pool = tracks.slice(0, 12);
  const lead = pool.filter((t) => t.vocalType === "LEAD");
  const anyVocals = pool.filter((t) => t.hasVocals);
  // Let the caller try a broader query rather than accept an instrumental.
  if (requireVocals && anyVocals.length === 0) return null;
  const candidates = lead.length >= 2 ? lead : anyVocals.length >= 2 ? anyVocals : anyVocals.length > 0 ? anyVocals : pool;
  const track = candidates[Math.floor(Math.random() * candidates.length)];
  console.log(
    `[music] auto picked "${track.title}" hasVocals=${Boolean(track.hasVocals)} vocalType=${track.vocalType ?? "NONE"}`,
  );

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

  // Vocals-first cascade. Each step relaxes one constraint, and only the
  // last one accepts an instrumental.
  //
  // The narrow genre filters are what starve some categories of vocals:
  // genre=corporate with "clean corporate motivational" is almost entirely
  // underscore, so step 1 finds nothing sung and step 2 drops the genre
  // while KEEPING the vocal requirement. The previous retry dropped both at
  // once, which is why corporate recaps still came back instrumental.
  const withFacets = new URLSearchParams({ term: query.term, limit: "20", vocalType: "LEAD" });
  if (query.mood) withFacets.append("mood", query.mood);
  if (query.genre) withFacets.append("genre", query.genre);

  const attempts: { params: URLSearchParams; requireVocals: boolean; label: string }[] = [
    { params: withFacets, requireVocals: true, label: "term+facets+LEAD" },
    {
      params: new URLSearchParams({ term: query.term, limit: "20", vocalType: "LEAD" }),
      requireVocals: true,
      label: "term+LEAD",
    },
    // Last resort: whatever the category normally returns. Better an
    // instrumental than silence.
    { params: withFacets, requireVocals: false, label: "term+facets (instrumental ok)" },
  ];

  for (const attempt of attempts) {
    const result = await runEpidemicSearch(apiKey, attempt.params, attempt.requireVocals);
    if (result) return result;
    console.error(`[music] no match for ${catalogId} via ${attempt.label}`);
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
