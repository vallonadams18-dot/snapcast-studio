// Server-only (reaches perceptualHash, which spawns ffmpeg).
//
// Decides WHICH photos go in a montage and IN WHAT ORDER.
//
// This replaces "sort by total score, take the top eight", which produced
// two problems at once. Scoring is per-image with no cross-image awareness,
// so five near-identical frames from one photo-booth session all scored
// alike and all got picked — a montage of the same moment repeated. And
// because the order was score-descending, quality decayed from start to
// finish, leaving the weakest image on screen at the end, which is exactly
// the frame a looping social video rests on.
import { computeDHash, isNearDuplicate, hammingDistance, type PerceptualHash } from "@/lib/perceptualHash";

/** Where a photo sits in the video's arc. */
export type NarrativeRole = "opener" | "build" | "variety" | "peak" | "hero";

export interface SelectionCandidate {
  id: string;
  storagePath: string;
  createdAt: Date;
  energyScore: number | null;
  visualQualityScore: number | null;
  momentRarityScore: number | null;
}

export interface SelectedPhoto<T extends SelectionCandidate = SelectionCandidate> {
  candidate: T;
  role: NarrativeRole;
  /** Plain-language explanation. Debuggable now, user-facing later. */
  reason: string;
}

export interface SelectionResult<T extends SelectionCandidate = SelectionCandidate> {
  selected: SelectedPhoto<T>[];
  /** Nothing is deleted — this only records what was left out, and why. */
  excluded: { mediaId: string; reason: string }[];
  duplicatesFound: number;
}

/** Hashing costs one ffmpeg spawn each (~50ms); bound the work per render. */
const MAX_HASH_CANDIDATES = 30;

function totalScore(c: SelectionCandidate): number {
  return (c.energyScore ?? 0) + (c.visualQualityScore ?? 0) + (c.momentRarityScore ?? 0);
}

/** How arresting a shot is — what a first frame has to do. */
function energyOf(c: SelectionCandidate): number {
  return c.energyScore ?? 0;
}

/** How memorable a shot is — what the closing frame has to do. */
function heroScore(c: SelectionCandidate): number {
  return (c.momentRarityScore ?? 0) + (c.energyScore ?? 0);
}

/**
 * Group near-identical photos and keep the best of each group.
 *
 * Iterating in score order means the first member of a group is its
 * strongest, so it becomes the representative and the rest are recorded as
 * duplicates. Photos that could not be hashed never match anything and are
 * always kept — a hashing failure must not cost someone a photo.
 */
function clusterByLikeness<T extends SelectionCandidate>(
  ranked: { candidate: T; hash: PerceptualHash | null }[],
): { reps: { candidate: T; hash: PerceptualHash | null }[]; duplicates: { candidate: T; ofId: string }[] } {
  const reps: { candidate: T; hash: PerceptualHash | null }[] = [];
  const duplicates: { candidate: T; ofId: string }[] = [];

  for (const entry of ranked) {
    const match = reps.find((rep) => isNearDuplicate(rep.hash, entry.hash));
    if (match) duplicates.push({ candidate: entry.candidate, ofId: match.candidate.id });
    else reps.push(entry);
  }

  return { reps, duplicates };
}

/**
 * Order the middle of the video so consecutive shots don't look alike.
 *
 * Greedy walk: from the shot just placed, take whichever remaining photo is
 * most visually distant. Reuses the dHash distance already computed for
 * duplicate detection — one measurement doing two jobs. Where hashes are
 * missing it falls back to chronology, which keeps an unscored event (no API
 * key connected) in a sensible order rather than an arbitrary one.
 */
function orderForVariety<T extends SelectionCandidate>(
  pool: { candidate: T; hash: PerceptualHash | null }[],
  startFrom: PerceptualHash | null,
): { candidate: T; hash: PerceptualHash | null }[] {
  const remaining = [...pool];
  const ordered: { candidate: T; hash: PerceptualHash | null }[] = [];
  let previousHash: PerceptualHash | null = startFrom;

  while (remaining.length > 0) {
    let bestIndex = 0;
    if (previousHash !== null) {
      let bestDistance = -1;
      remaining.forEach((entry, i) => {
        // Unhashable photos get a mid-range score so they neither dominate
        // nor sink to the end of the sequence.
        const prev = previousHash;
        const distance = entry.hash === null || prev === null ? 32 : hammingDistance(prev, entry.hash);
        if (distance > bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      });
    } else {
      // No hash to compare against — fall back to chronological order.
      bestIndex = remaining.reduce(
        (best, entry, i) => (entry.candidate.createdAt < remaining[best].candidate.createdAt ? i : best),
        0,
      );
    }

    const [picked] = remaining.splice(bestIndex, 1);
    ordered.push(picked);
    if (picked.hash !== null) previousHash = picked.hash;
  }

  return ordered;
}

/**
 * Pick and sequence the photos for a montage.
 *
 * `resolvePath` returns a readable local path for a candidate, or null if it
 * cannot be fetched. Injected rather than imported so this module stays free
 * of storage concerns.
 *
 * The arc is deliberate:
 *   opener  strongest energy — the first second decides whether anyone stays
 *   build   varied middle, no two neighbours looking alike
 *   peak    second-strongest, placed around three-quarters through
 *   hero    the most memorable shot, RESERVED for last and never spent early
 */
export async function selectPhotosForMontage<T extends SelectionCandidate>(
  candidates: T[],
  maxPhotos: number,
  resolvePath: (candidate: T) => Promise<string | null>,
): Promise<SelectionResult<T>> {
  const excluded: { mediaId: string; reason: string }[] = [];

  // Score order first, so each duplicate group keeps its strongest member.
  // Chronology breaks ties, which is what carries an unscored event.
  const byScore = [...candidates].sort((a, b) => {
    const diff = totalScore(b) - totalScore(a);
    return diff !== 0 ? diff : a.createdAt.getTime() - b.createdAt.getTime();
  });

  const hashPool = byScore.slice(0, MAX_HASH_CANDIDATES);
  for (const overflow of byScore.slice(MAX_HASH_CANDIDATES)) {
    excluded.push({ mediaId: overflow.id, reason: "not among the top-scoring candidates" });
  }

  const ranked = await Promise.all(
    hashPool.map(async (candidate) => {
      const path = await resolvePath(candidate);
      return { candidate, hash: path ? await computeDHash(path) : null };
    }),
  );

  const { reps, duplicates } = clusterByLikeness(ranked);
  for (const dup of duplicates) {
    excluded.push({ mediaId: dup.candidate.id, reason: `near-duplicate of ${dup.ofId}` });
  }

  // Deduping can leave fewer photos than asked for. Top back up from the
  // duplicates rather than shipping a three-photo video — a repeated moment
  // beats no montage at all.
  let pool = reps;
  if (pool.length < maxPhotos && duplicates.length > 0) {
    const shortfall = maxPhotos - pool.length;
    const topUp = duplicates.slice(0, shortfall);
    pool = [...pool, ...topUp.map((d) => ({ candidate: d.candidate, hash: null as PerceptualHash | null }))];
    for (const used of topUp) {
      const i = excluded.findIndex((e) => e.mediaId === used.candidate.id);
      if (i >= 0) excluded.splice(i, 1);
    }
  }

  pool = pool.slice(0, maxPhotos);
  if (pool.length === 0) return { selected: [], excluded, duplicatesFound: duplicates.length };

  const take = (list: typeof pool, by: (c: T) => number) => {
    let bestIndex = 0;
    list.forEach((entry, i) => {
      if (by(entry.candidate) > by(list[bestIndex].candidate)) bestIndex = i;
    });
    return list.splice(bestIndex, 1)[0];
  };

  const working = [...pool];

  // Hero comes out FIRST so it cannot be spent earlier in the sequence.
  const hero = working.length > 1 ? take(working, heroScore) : null;
  const opener = working.length > 0 ? take(working, energyOf) : null;
  const peak = working.length > 2 ? take(working, totalScore) : null;

  const middle = orderForVariety(working, opener?.hash ?? null);

  const selected: SelectedPhoto<T>[] = [];
  if (opener) {
    selected.push({ candidate: opener.candidate, role: "opener", reason: "Highest energy — opens the video" });
  }

  // Peak sits about three-quarters through: far enough in to have built to
  // it, early enough that the hero still lands last.
  const peakIndex = peak ? Math.max(1, Math.round(middle.length * 0.75)) : -1;
  middle.forEach((entry, i) => {
    if (i === peakIndex && peak) {
      selected.push({ candidate: peak.candidate, role: "peak", reason: "Strongest shot of the middle section" });
    }
    selected.push({
      candidate: entry.candidate,
      role: i % 2 === 0 ? "build" : "variety",
      reason: "Sequenced to look different from the shot before it",
    });
  });
  if (peak && peakIndex >= middle.length) {
    selected.push({ candidate: peak.candidate, role: "peak", reason: "Strongest shot of the middle section" });
  }

  if (hero) {
    selected.push({ candidate: hero.candidate, role: "hero", reason: "Most memorable shot — held for the ending" });
  }

  return { selected, excluded, duplicatesFound: duplicates.length };
}
