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

function getEpidemicApiKey(): string | null {
  return process.env.EPIDEMIC_SOUND_API_KEY || null;
}

interface EpidemicSearchResult {
  id: string;
  title: string;
}

async function runEpidemicSearch(apiKey: string, params: URLSearchParams): Promise<EpidemicSearchResult | null> {
  const response = await fetch(`${EPIDEMIC_API_BASE}/tracks/search?${params}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    console.error("[music] Epidemic Sound search failed", response.status, await response.text().catch(() => ""));
    return null;
  }
  const data = (await response.json()) as { tracks: { id: string; title: string }[] };
  const track = data.tracks[0];
  return track ? { id: track.id, title: track.title } : null;
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
  // NonSharedBuffer (what fs.readFile returns) rather than plain Buffer, so
  // callers can reassign the result onto a readFile-derived variable.
): Promise<Buffer<ArrayBuffer> | null> {
  const apiKey = getEpidemicApiKey();
  if (!apiKey) return null;

  const found = await searchEpidemicTrack(catalogId);
  if (!found) {
    console.error("[music] No Epidemic Sound match for catalog category", catalogId);
    return null;
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-music-"));
  try {
    const audioBuffer = await downloadEpidemicTrack(found.id);
    const audioPath = path.join(tmpDir, "track.mp3");
    await writeFile(audioPath, audioBuffer);

    const videoPath = path.join(tmpDir, "input.mp4");
    await writeFile(videoPath, clipVideoBuffer);
    const outputPath = path.join(tmpDir, "output.mp4");

    const fadeStart = Math.max(0, clipDurationSeconds - 1);
    await runFfmpeg([
      "-i", videoPath,
      "-i", audioPath,
      "-filter_complex", `[1:a]atrim=0:${clipDurationSeconds},afade=t=out:st=${fadeStart}:d=1[aout]`,
      "-map", "0:v",
      "-map", "[aout]",
      // Re-encode (not -c:v copy) and hard-cap with -t: some source videos
      // (e.g. photo montages, which pass through a concat-demuxer step)
      // carry timestamps that make -shortest alone unreliable — it once let
      // a 7.5s video come out 2 minutes long once mixed with a longer track.
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
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
