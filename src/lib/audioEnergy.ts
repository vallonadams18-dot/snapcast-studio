// Server-only: spawns ffmpeg and makes outbound fetches.
//
// Picks WHERE IN A TRACK a montage's music should start. Every generated
// video used to begin at 0:00, which on almost any produced track is the
// sparsest, quietest part of the arrangement — the intro. A recap that
// opens on the softest bars reads as flat no matter how good the pictures
// are. This finds a loud stretch instead.
//
// No new dependency: the waveform data is the same feed the music library
// already draws in the browser, and the fallback is ffmpeg, which is
// already a hard requirement of this app.
import { spawn } from "node:child_process";
import { resolveFfmpegPath } from "@/lib/ffmpegPaths";

export type EnergySource = "waveform" | "ffmpeg" | "heuristic";

export interface EnergyPick {
  startSeconds: number;
  source: EnergySource;
}

/**
 * Where to start when nothing can be measured. A quarter of the way in is
 * past the intro on most produced music and before any outro — a plainly
 * better default than 0:00, without pretending to be analysis.
 */
const HEURISTIC_FRACTION = 0.25;

function clampStart(start: number, trackLength: number, windowSeconds: number): number {
  const latest = Math.max(0, trackLength - windowSeconds);
  return Math.round(Math.min(Math.max(0, start), latest) * 100) / 100;
}

/**
 * Best window start over an energy curve.
 *
 * `curve` is evenly spaced magnitudes covering the whole track. Averaging
 * in linear power (not dB, not raw peaks) is what makes one stray transient
 * lose to a genuinely sustained loud section.
 */
function bestWindowStart(curve: number[], trackLength: number, windowSeconds: number): number {
  if (curve.length === 0 || trackLength <= 0) return 0;

  const secondsPerBucket = trackLength / curve.length;
  const windowBuckets = Math.max(1, Math.round(windowSeconds / secondsPerBucket));
  if (windowBuckets >= curve.length) return 0;

  // Rolling sum — O(n) rather than re-adding the window at every offset.
  let running = 0;
  for (let i = 0; i < windowBuckets; i++) running += curve[i];

  let best = running;
  let bestIndex = 0;
  for (let i = windowBuckets; i < curve.length; i++) {
    running += curve[i] - curve[i - windowBuckets];
    if (running > best) {
      best = running;
      bestIndex = i - windowBuckets + 1;
    }
  }

  return clampStart(bestIndex * secondsPerBucket, trackLength, windowSeconds);
}

/**
 * Epidemic's waveform JSON, which is interleaved min/max pairs of 8-bit
 * samples — the identical format MusicLibrary.tsx decodes to draw the
 * scrub bar. Collapsed here to one magnitude per pair.
 */
async function curveFromWaveform(waveformUrl: string): Promise<number[] | null> {
  let parsed: URL;
  try {
    parsed = new URL(waveformUrl);
  } catch {
    return null;
  }
  // Same host restriction as /api/music/waveform. This URL arrives from a
  // third-party API response, so it is not trusted input.
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".epidemicsound.com")) {
    console.error("[audioEnergy] refusing waveform fetch from unexpected host", parsed.hostname);
    return null;
  }

  try {
    const response = await fetch(parsed.toString());
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: number[] };
    const data = json.data ?? [];
    const pairs = Math.floor(data.length / 2);
    if (pairs === 0) return null;

    const curve: number[] = [];
    for (let i = 0; i < pairs; i++) {
      const magnitude = Math.max(Math.abs(data[i * 2]), Math.abs(data[i * 2 + 1])) / 128;
      // Square it: the waveform gives amplitude, and we want power, so a
      // loud passage outweighs a spiky quiet one.
      curve.push(magnitude * magnitude);
    }
    return curve;
  } catch (err) {
    console.error("[audioEnergy] waveform fetch failed", err);
    return null;
  }
}

// ffmpeg's `astats` reports per-window RMS and `ametadata` prints it. Both
// exist well back into ffmpeg 3.x, so this fallback works on old builds too
// (verified against 3.4, which is what some dev machines still have).
// mp3 decodes in 1152-sample frames, so ~40 frames ≈ 1.05s at 44.1kHz.
const ASTATS_RESET_FRAMES = 40;

function runFfmpegCapturingStdout(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), args);
    let stdout = "";
    // stderr is drained but ignored — ffmpeg logs progress there even on
    // success, and leaving the pipe unread can stall the child.
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", () => {});
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`ffmpeg astats exited ${code}`))));
  });
}

async function curveFromAudioFile(audioPath: string): Promise<number[] | null> {
  try {
    const output = await runFfmpegCapturingStdout([
      "-i", audioPath,
      "-af", `astats=metadata=1:reset=${ASTATS_RESET_FRAMES},ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      "-f", "null",
      "-",
    ]);

    const curve: number[] = [];
    for (const match of output.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/g)) {
      const raw = match[1];
      if (raw === "-inf") {
        curve.push(0);
        continue;
      }
      const db = Number(raw);
      if (!Number.isFinite(db)) continue;
      // dB -> linear power, so windows can be meaningfully averaged.
      curve.push(Math.pow(10, db / 10));
    }

    return curve.length > 2 ? curve : null;
  } catch (err) {
    console.error("[audioEnergy] ffmpeg astats analysis failed", err);
    return null;
  }
}

export interface SectionEnergy {
  /** Where the analysed section starts, in track time. */
  sectionStartSeconds: number;
  /** Strongest SUSTAINED energy position, relative to the section start. */
  peakOffsetSeconds: number;
  /** peakOffsetSeconds / windowSeconds, clamped to 0..1. */
  peakFraction: number;
  /** True when the raw maximum sat in the final 20% and was re-searched earlier. */
  clampedFromEnd: boolean;
  source: EnergySource;
}

/**
 * Locate the strongest sustained energy region WITHIN a music section.
 *
 * Waveform-only on purpose: the download endpoint currently 402s, but the
 * waveform JSON rides along free on every search response, so this works
 * with no audio bytes at all. Returns null whenever the waveform is missing,
 * malformed, or the section leaves no room to choose — callers keep their
 * existing narrative placement in that case. An enhancement, never a
 * dependency.
 *
 * "Sustained" means a rolling sub-window (~a fifth of the section, at least
 * 1.5s) is scored in linear power, so a held chorus outranks one transient
 * hit — the same reasoning bestWindowStart already applies at track scale.
 *
 * The final-20% rule lives HERE, not in the caller: the hero shot owns the
 * ending, so when the raw maximum falls in the section's last fifth the
 * search re-runs restricted to the first 80% and reports that position
 * instead, flagged as clamped. The narrative arc wins over the waveform.
 */
export async function analyzeSectionEnergy(options: {
  waveformUrl?: string | null;
  trackLengthSeconds?: number | null;
  windowSeconds: number;
  /** Explicit section start (the user's manual pick). Null = loudest window. */
  sectionStartSeconds?: number | null;
}): Promise<SectionEnergy | null> {
  const { waveformUrl, windowSeconds } = options;
  const trackLength = options.trackLengthSeconds ?? 0;
  if (!waveformUrl || trackLength <= 0 || windowSeconds <= 0 || trackLength <= windowSeconds) return null;

  const curve = await curveFromWaveform(waveformUrl);
  if (!curve || curve.length < 4) return null;

  const secondsPerBucket = trackLength / curve.length;
  const sectionStart =
    options.sectionStartSeconds != null
      ? clampStart(options.sectionStartSeconds, trackLength, windowSeconds)
      : bestWindowStart(curve, trackLength, windowSeconds);

  const first = Math.floor(sectionStart / secondsPerBucket);
  const count = Math.max(2, Math.round(windowSeconds / secondsPerBucket));
  const section = curve.slice(first, first + count);
  if (section.length < 2) return null;

  const subLen = Math.max(1, Math.round(Math.max(1.5, windowSeconds * 0.2) / secondsPerBucket));
  const bestSubStart = (buckets: number[]): number => {
    const len = Math.min(subLen, buckets.length);
    let running = 0;
    for (let i = 0; i < len; i++) running += buckets[i];
    let best = running;
    let bestIndex = 0;
    for (let i = len; i < buckets.length; i++) {
      running += buckets[i] - buckets[i - len];
      if (running > best) {
        best = running;
        bestIndex = i - len + 1;
      }
    }
    return bestIndex;
  };

  let peakIndex = bestSubStart(section);
  let clampedFromEnd = false;
  const lastFifthStart = Math.floor(section.length * 0.8);
  if (peakIndex >= lastFifthStart) {
    peakIndex = bestSubStart(section.slice(0, lastFifthStart));
    clampedFromEnd = true;
  }

  const peakOffsetSeconds = Math.round(peakIndex * secondsPerBucket * 100) / 100;
  return {
    sectionStartSeconds: Math.round(sectionStart * 100) / 100,
    peakOffsetSeconds,
    peakFraction: Math.min(1, Math.max(0, peakOffsetSeconds / windowSeconds)),
    clampedFromEnd,
    source: "waveform",
  };
}

/**
 * Choose a start offset for a `windowSeconds`-long slice of a track.
 *
 * Tries the cheap, already-available source first and degrades in steps,
 * matching how the rest of the ffmpeg work in this codebase behaves: never
 * fail the render over an enhancement.
 *
 *   1. Epidemic waveform JSON  — free, no decode, already fetched for the UI
 *   2. ffmpeg astats           — needs the file, works on any ffmpeg build
 *   3. fixed fraction          — no measurement, still better than 0:00
 */
export async function pickHighEnergyStart(options: {
  waveformUrl?: string | null;
  audioPath?: string | null;
  trackLengthSeconds?: number | null;
  windowSeconds: number;
}): Promise<EnergyPick> {
  const { waveformUrl, audioPath, windowSeconds } = options;
  const trackLength = options.trackLengthSeconds ?? 0;

  if (waveformUrl && trackLength > windowSeconds) {
    const curve = await curveFromWaveform(waveformUrl);
    if (curve) {
      return { startSeconds: bestWindowStart(curve, trackLength, windowSeconds), source: "waveform" };
    }
  }

  if (audioPath) {
    const curve = await curveFromAudioFile(audioPath);
    if (curve) {
      // astats windows are evenly spaced, so the curve's own length gives a
      // duration even when the API didn't tell us one.
      const measuredLength =
        trackLength > 0 ? trackLength : (curve.length * ASTATS_RESET_FRAMES * 1152) / 44100;
      if (measuredLength > windowSeconds) {
        return { startSeconds: bestWindowStart(curve, measuredLength, windowSeconds), source: "ffmpeg" };
      }
    }
  }

  if (trackLength > windowSeconds) {
    return {
      startSeconds: clampStart(trackLength * HEURISTIC_FRACTION, trackLength, windowSeconds),
      source: "heuristic",
    };
  }

  // Track is barely longer than the clip — there is no meaningful choice.
  return { startSeconds: 0, source: "heuristic" };
}
