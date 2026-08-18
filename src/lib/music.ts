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
  };
}

// Free-text search across the licensed catalog, for the browse-and-pick UI.
export async function searchLibrary(term: string, limit = 24): Promise<LibraryTrack[]> {
  const apiKey = getEpidemicApiKey();
  if (!apiKey) return [];

  const params = new URLSearchParams({ term: term || "event", limit: String(Math.min(limit, 60)) });
  const response = await fetch(`${EPIDEMIC_API_BASE}/tracks/search?${params}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    console.error("[music] library search failed", response.status);
    return [];
  }
  const data = (await response.json()) as { tracks: RawTrack[] };
  return (data.tracks ?? []).map(toLibraryTrack);
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

async function runEpidemicSearch(apiKey: string, params: URLSearchParams): Promise<EpidemicSearchResult | null> {
  const response = await fetch(`${EPIDEMIC_API_BASE}/tracks/search?${params}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    console.error("[music] Epidemic Sound search failed", response.status, await response.text().catch(() => ""));
    return null;
  }
  const data = (await response.json()) as { tracks: RawTrack[] };
  const track = data.tracks[0];
  if (!track) return null;
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

  const filtered = new URLSearchParams({ term: query.term, limit: "5" });
  if (query.mood) filtered.append("mood", query.mood);
  if (query.genre) filtered.append("genre", query.genre);

  const result = await runEpidemicSearch(apiKey, filtered);
  if (result) return result;

  // An unrecognized mood/genre id silently returns zero results rather than
  // erroring — retry on the search term alone so one bad filter combo never
  // fully blocks music for that category.
  if (query.mood || query.genre) {
    console.error("[music] Filtered search empty for", catalogId, "— retrying on term alone");
    return runEpidemicSearch(apiKey, new URLSearchParams({ term: query.term, limit: "5" }));
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
