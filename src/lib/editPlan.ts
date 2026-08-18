// Client-safe: plain data and arithmetic, no Node built-ins.
//
// The EditPlan is the creative instruction sheet. Everything about what the
// video should CONTAIN is decided here; lib/video.ts only executes it.
//
// Before this, the renderer took a list of photo paths plus a style and made
// several decisions itself — how long each photo held, which direction the
// camera moved, which transition joined every pair. That worked while a
// style meant one motion and one transition for the whole video, and it is
// exactly what blocks a preset where the opening is a rapid burst of
// punch-ins and the closing shot is a long, still hold.
//
// Values are RESOLVED at plan time. "alternate" becomes a concrete zoom-in or
// zoom-out per segment here, so the renderer never has to infer anything from
// a segment's position. A plan can be read on its own and fully describes the
// video.
import { photoDurations, type MontageStyle } from "@/lib/montageStyles";
import type { NarrativeRole, SelectedPhoto, SelectionCandidate, SelectionResult } from "@/lib/photoSelection";

/** Concrete camera moves. "alternate" is resolved away before rendering. */
export type SegmentMotion = "zoom-in" | "zoom-out" | "pan-right" | "none";
export type SegmentTransition = MontageStyle["transition"];
export type SegmentFit = MontageStyle["fit"];

export interface EditSegment {
  mediaId: string;
  /** Readable local path for the renderer. Never logged. */
  sourcePath: string;
  role: NarrativeRole;
  durationSeconds: number;
  motion: SegmentMotion;
  /** Fraction of the frame the camera travels, e.g. 0.18 = an 18% push. */
  motionMagnitude: number;
  fit: SegmentFit;
  /**
   * Transition INTO the next segment. The final segment's value is unused —
   * nothing follows it.
   */
  transitionOut: SegmentTransition;
  transitionSeconds: number;
  /** Why this shot is here, in plain language. */
  reason: string;
}

export interface EditPlanMusic {
  /** Broad catalog category, which is what the mixer searches on. */
  catalogId: string;
  trackId: string | null;
  title: string | null;
  /** Null means "let the high-energy picker choose at mix time". */
  startSeconds: number | null;
  /** From the Epidemic API. Null when unknown — never guessed. */
  bpm: number | null;
  /**
   * Seconds between beats, i.e. 60 / bpm.
   *
   * IMPORTANT: this is beat SPACING, not beat PHASE. The API gives no
   * first-beat offset and there is no onset detection here, so cuts land on
   * musically sensible INTERVALS but are not aligned to the actual downbeats
   * of the recording. This is rhythm-aware pacing, not phase-locked beat
   * synchronisation, and it should never be described as the latter.
   */
  beatIntervalSeconds: number | null;
  /**
   * Strongest sustained energy position within the chosen section, from the
   * waveform. Null when no waveform analysis was possible. Recorded so a
   * plan explains WHY the peak sits where it does.
   */
  energyPeakOffsetSeconds?: number | null;
}

export interface EditPlan {
  planVersion: 1;
  styleId: string;
  styleName: string;
  /** Predicted picture length, before branded bookends. */
  targetDurationSeconds: number;
  segments: EditSegment[];
  music: EditPlanMusic | null;
  /** Nothing is deleted — this records what was left out, and why. */
  excluded: { mediaId: string; reason: string }[];
  duplicatesFound: number;
}

/**
 * Beat multiples a segment may occupy, by pacing character.
 *
 * Not one multiple for everything: a Cinematic montage on a 140 BPM track
 * must not become rapid-fire just because the song is fast, and a Punchy
 * montage on an 85 BPM track must not turn into a slideshow. Fast profiles
 * are allowed to sit on shorter multiples, slow ones on longer.
 */
function allowedBeatMultiples(style: MontageStyle, beatIntervalSeconds: number): number[] {
  // Centre on however many beats the style's own shot length occupies at THIS
  // tempo. A fixed list cannot work: Cinematic's 3.2s shot is 4.5 beats at 85
  // BPM but 7.0 at 132, so a hardcoded set clamps every segment to its
  // maximum — which both flattens the pacing profile and drags the runtime
  // ~18% short, with no headroom left for drift correction to recover.
  const centre = Math.max(1, Math.round(style.secondsPerPhoto / beatIntervalSeconds));
  // Fast profiles get more room to vary; slow ones stay near their centre so
  // a high-BPM track cannot turn Cinematic into rapid cuts.
  const spread = style.pacing === "accelerate" || style.pacing === "alternating" ? 2 : 1;

  const multiples: number[] = [];
  for (let m = Math.max(1, centre - spread); m <= centre + spread; m++) multiples.push(m);
  return multiples;
}

/**
 * Nudge durations onto beat-interval multiples.
 *
 * The style's pacing profile is the STARTING POINT, not something this
 * replaces: each duration moves to the nearest allowed multiple of the beat
 * interval, so an accelerating profile still accelerates and a held hero
 * shot is still the longest. Only the exact lengths change.
 *
 * Beat SPACING only. There is no first-beat offset available, so cuts land
 * on musically sensible intervals rather than on the recording's actual
 * downbeats. Rhythm-aware, not phase-locked.
 */
function snapDurationsToBeats(
  durations: number[],
  beatIntervalSeconds: number,
  style: MontageStyle,
  roles: NarrativeRole[],
): number[] {
  // A cross-fade longer than its segment breaks xfade outright, so this floor
  // is a correctness bound and snapping must never cross it.
  const floor = Math.max(0.8, style.transitionSeconds + 0.35);
  const multiples = allowedBeatMultiples(style, beatIntervalSeconds).filter((m) => m * beatIntervalSeconds >= floor);
  if (multiples.length === 0) return durations;

  const snapOne = (seconds: number) =>
    multiples.reduce((best, m) => {
      const candidate = m * beatIntervalSeconds;
      return Math.abs(candidate - seconds) < Math.abs(best - seconds) ? candidate : best;
    }, multiples[0] * beatIntervalSeconds);

  const snapped = durations.map(snapOne);

  // Drift control. Snapping eight segments in the same direction compounds,
  // so if the total strays far from the style's intent, step individual
  // segments to a neighbouring multiple — rather than rescaling everything,
  // which would immediately pull them all back off the beat.
  const target = durations.reduce((a, b) => a + b, 0);
  const maxDrift = 0.1;
  for (let guard = 0; guard < snapped.length * 2; guard++) {
    const total = snapped.reduce((a, b) => a + b, 0);
    const drift = (total - target) / target;
    if (Math.abs(drift) <= maxDrift) break;

    // Adjust the segment furthest from its original length, so the shape of
    // the pacing profile survives.
    const direction = drift > 0 ? -1 : 1;
    let bestIndex = -1;
    let bestGain = 0;
    snapped.forEach((current, i) => {
      const currentMultiple = Math.round(current / beatIntervalSeconds);
      const nextMultiple = currentMultiple + direction;
      if (!multiples.includes(nextMultiple)) return;
      const gain = Math.abs(current - durations[i]) - Math.abs(nextMultiple * beatIntervalSeconds - durations[i]);
      if (gain > bestGain) {
        bestGain = gain;
        bestIndex = i;
      }
    });
    if (bestIndex < 0) break;
    snapped[bestIndex] = (Math.round(snapped[bestIndex] / beatIntervalSeconds) + direction) * beatIntervalSeconds;
  }

  // Some tempos simply cannot express a style. Punchy wants ~0.9s shots, but
  // at 85 BPM one beat is 0.706s — below the transition-safety floor — so the
  // shortest legal multiple is two beats at 1.41s and the runtime inflates
  // over 13%. When rhythm and style intent genuinely cannot both be met,
  // style intent wins: the music-aware layer is meant to REFINE pacing, not
  // stretch a fast edit into a slow one.
  const finalDrift = Math.abs(snapped.reduce((a, b) => a + b, 0) - target) / target;
  if (finalDrift > maxDrift) return durations;

  // Hero hold emphasis.
  //
  // Snapping rounds to the nearest multiple, which can quietly flatten the
  // ending: a real 67 BPM render put the hero at 3.58s and the opener at
  // 3.58s too, so the shot the video rests on read as just another beat. The
  // last frame is what plays as a social video loops, and it should feel
  // deliberately held.
  //
  // Stepped up a whole beat at a time rather than padded with arbitrary
  // seconds, so the hero stays on the same rhythmic grid as everything else.
  const heroIndex = snapped.length - 1;
  if (heroIndex > 0 && roles[heroIndex] === "hero") {
    const peakIndex = roles.indexOf("peak");
    // The two shots the hero has to out-hold: the opening hook and the peak.
    const mustBeat = Math.max(snapped[0], peakIndex > 0 ? snapped[peakIndex] : 0);
    // One step past the normal ceiling is allowed — a deliberate hold is
    // exactly the case that earns it.
    const ceiling = Math.max(...multiples) + 1;
    // Slightly wider than the general budget, because this lengthens exactly
    // one segment on purpose. Not wide enough to turn a 12s montage into 25s.
    const heroDriftBudget = 0.15;

    for (let step = 0; step < 4 && snapped[heroIndex] <= mustBeat + 1e-6; step++) {
      const nextMultiple = Math.round(snapped[heroIndex] / beatIntervalSeconds) + 1;
      if (nextMultiple > ceiling) break;
      const candidate = nextMultiple * beatIntervalSeconds;
      const projected = snapped.reduce((a, b) => a + b, 0) - snapped[heroIndex] + candidate;
      if (Math.abs(projected - target) / target > heroDriftBudget) break;
      snapped[heroIndex] = candidate;
    }

    // Requirement: snapping must never leave the hero SHORTER than the opener
    // or the peak. If the tempo cannot express that, fall back to the style's
    // own durations — photoDurations always gives the closing shot the
    // largest multiplier, so hero-longest is guaranteed there.
    if (snapped[heroIndex] < mustBeat - 1e-6) return durations;
  }

  return snapped.map((d) => Math.round(Math.max(floor, d) * 1000) / 1000);
}

/**
 * Resolve a style's motion for one position in the sequence.
 *
 * "alternate" is the only style value that depends on where a segment sits.
 * Collapsing it here keeps the renderer free of sequencing logic.
 */
function resolveMotion(style: MontageStyle, index: number): SegmentMotion {
  if (style.motion !== "alternate") return style.motion;
  // Alternating push and pull is what gives a fast cut sequence its rhythm —
  // every photo moving the same way reads as one long drift.
  return index % 2 === 0 ? "zoom-in" : "zoom-out";
}

/**
 * Build the plan for a montage.
 *
 * Phase 2A's selection has already decided WHICH photos and IN WHAT ORDER;
 * this attaches the timing and camera treatment to that decision. Segment
 * values currently derive from the chosen style, which is deliberate for
 * now — the architectural win is that they are per-segment, so a preset can
 * vary them later without touching the renderer.
 */
export function buildEditPlan<T extends SelectionCandidate>(options: {
  selection: SelectionResult<T>;
  style: MontageStyle;
  /** Local path per media id, from the caller's storage resolution. */
  pathsByMediaId: Map<string, string>;
  music: EditPlanMusic | null;
}): EditPlan {
  const { selection, style, pathsByMediaId, music } = options;

  // Only photos we can actually read become segments.
  const usable: SelectedPhoto<T>[] = selection.selected.filter((s) => pathsByMediaId.has(s.candidate.id));

  // Style intent first, then music rhythm refines it. When BPM is unknown
  // the style profile is used exactly as Phase 1 and 2B shipped it —
  // rhythm-aware pacing is an enhancement, never a render dependency.
  const styleDurations = photoDurations(usable.length, style);
  const beatInterval = music?.beatIntervalSeconds ?? null;
  const durations =
    beatInterval && beatInterval > 0
      ? snapDurationsToBeats(styleDurations, beatInterval, style, usable.map((u) => u.role))
      : styleDurations;

  const segments: EditSegment[] = usable.map((item, index) => ({
    mediaId: item.candidate.id,
    sourcePath: pathsByMediaId.get(item.candidate.id)!,
    role: item.role,
    durationSeconds: durations[index],
    motion: resolveMotion(style, index),
    motionMagnitude: style.motionMagnitude,
    fit: style.fit,
    transitionOut: style.transition,
    transitionSeconds: style.transitionSeconds,
    reason: item.reason,
  }));

  const excluded = [...selection.excluded];
  for (const item of selection.selected) {
    if (!pathsByMediaId.has(item.candidate.id)) {
      excluded.push({ mediaId: item.candidate.id, reason: "file could not be read" });
    }
  }

  return {
    planVersion: 1,
    styleId: style.id,
    styleName: style.name,
    targetDurationSeconds: planDurationSeconds(segments),
    segments,
    music,
    excluded,
    duplicatesFound: selection.duplicatesFound,
  };
}

/**
 * Predicted picture length, accounting for transition overlap.
 *
 * Each cross-fade overlaps its pair, so the timeline is shorter than the sum
 * of the segments by one transition per join. Overlap is now summed
 * per-segment rather than assuming one shared value.
 *
 * This remains a PREDICTION. Callers that need a real duration — to trim
 * music against, say — should probe the rendered file, since no prediction
 * can know whether branded cards rendered or how the encoder rounded.
 */
export function planDurationSeconds(segments: EditSegment[]): number {
  const raw = segments.reduce((total, s) => total + s.durationSeconds, 0);
  // The last segment's transitionOut joins nothing, so it never overlaps.
  const overlap = segments.slice(0, -1).reduce((total, s) => total + effectiveTransitionSeconds(s), 0);
  return Math.max(0, raw - overlap);
}

/**
 * A hard cut has no overlap; everything else overlaps by its own duration.
 *
 * xfade cannot express a zero-length blend, so a "cut" inside a mixed chain
 * is rendered as a single frame of cross-fade (see CUT_AS_XFADE_SECONDS in
 * lib/video.ts). One frame at 30fps is imperceptible, and it lets a plan mix
 * rapid cuts with softer transitions in the same video — which is the whole
 * point of describing transitions per segment.
 */
export function effectiveTransitionSeconds(segment: EditSegment): number {
  return segment.transitionOut === "cut" ? 0 : segment.transitionSeconds;
}

/** True when no segment asks for a real blend, so plain concat will do. */
export function isAllHardCuts(segments: EditSegment[]): boolean {
  return segments.slice(0, -1).every((s) => s.transitionOut === "cut" || s.transitionSeconds <= 0);
}

/**
 * One-line-per-segment summary for logs.
 *
 * Deliberately omits storage paths: this is for answering "why did Snapcast
 * make this edit?", not for exposing where files live.
 */
export function describeEditPlan(plan: EditPlan): string {
  const header =
    `[plan v${plan.planVersion}] ${plan.styleName} · ${plan.segments.length} segments · ` +
    `~${plan.targetDurationSeconds.toFixed(1)}s · ${plan.duplicatesFound} near-duplicates skipped` +
    (plan.music ? ` · music=${plan.music.title ?? plan.music.catalogId}` : " · no music");

  const rows = plan.segments.map((s, i) => {
    const move = s.motion === "none" ? "still" : `${s.motion} ${Math.round(s.motionMagnitude * 100)}%`;
    const join = i === plan.segments.length - 1 ? "end" : `${s.transitionOut}${s.transitionSeconds ? ` ${s.transitionSeconds}s` : ""}`;
    return `  ${String(i + 1).padStart(2)}. ${s.role.padEnd(7)} ${s.mediaId.slice(-6)} ${s.durationSeconds.toFixed(2)}s ${move.padEnd(16)} → ${join}`;
  });

  return [header, ...rows].join("\n");
}
