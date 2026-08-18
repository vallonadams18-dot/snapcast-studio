// Client-safe: plain data and arithmetic, no Node built-ins.
//
// The EditPlan is the creative instruction sheet. Everything about what the
// video should CONTAIN is decided here; lib/video.ts only executes it.
//
// 2D makes the authoring per-segment for real: role-aware treatments, a
// motion vocabulary cycled through the middle, curated transitions with the
// decorated join gated to peak and hero, a bounded accent budget, and one
// grade for the whole video. All of it resolves to plain numbers HERE — the
// renderer stays judgment-free — and any variety is chosen with a seed
// derived from the photo set, so re-planning the same event reproduces the
// identical plan while different events differ.
import {
  photoDurations,
  maxTransitionSeconds,
  type MontageStyle,
  type MotionKind,
  type MotionEasing,
  type RoleTreatment,
} from "@/lib/montageStyles";
import type { NarrativeRole, SelectedPhoto, SelectionCandidate, SelectionResult } from "@/lib/photoSelection";

export type SegmentMotion = MotionKind;
export type SegmentFit = MontageStyle["fit"];

export interface EditSegment {
  mediaId: string;
  /** Readable local path for the renderer. Never logged. */
  sourcePath: string;
  role: NarrativeRole;
  durationSeconds: number;

  motion: SegmentMotion;
  /** Fraction of the frame the camera travels, e.g. 0.2 = a 20% move. */
  motionMagnitude: number;
  easing: MotionEasing;
  /**
   * Blurred-backdrop motion rate for two-layer parallax. The difference
   * between this and motionMagnitude is the depth cue. 0 = single layer.
   */
  bgMagnitude: number;
  /** Slow rotation drift across the segment, degrees. 0 = none. */
  rotateDriftDegrees: number;
  fit: SegmentFit;

  /**
   * Transition INTO the next segment (the final segment's value is unused).
   * An accent overrides this on the PREVIOUS segment — see `accent`.
   */
  transitionOut: string;
  transitionSeconds: number;
  /**
   * "flash-in": this segment is entered through a short white flash. The
   * plan realises it by rewriting the previous segment's transitionOut, so
   * the renderer needs no accent knowledge — the field remains for the log.
   */
  accent: "flash-in" | null;

  /** Why this shot is here, in plain language. */
  reason: string;
}

export interface EditPlanMusic {
  catalogId: string;
  trackId: string | null;
  title: string | null;
  /** Null means "let the high-energy picker choose at mix time". */
  startSeconds: number | null;
  /** From the Epidemic API. Null when unknown — never guessed. */
  bpm: number | null;
  /**
   * Seconds between beats (60/bpm). Beat SPACING, not beat PHASE — no
   * first-beat offset exists, so this is rhythm-aware pacing, never
   * phase-locked sync, and must not be described as the latter.
   */
  beatIntervalSeconds: number | null;
  /** Where the section's energy peaks, seconds from section start. */
  energyPeakOffsetSeconds?: number | null;
}

export interface EditPlan {
  planVersion: 2;
  presetId: string;
  presetName: string;
  /** One grade for the entire video — uniformity is the art direction. */
  look: MontageStyle["look"];
  /** Predicted picture length, before branded bookends. */
  targetDurationSeconds: number;
  segments: EditSegment[];
  music: EditPlanMusic | null;
  /** Nothing is deleted — this records what was left out, and why. */
  excluded: { mediaId: string; reason: string }[];
  duplicatesFound: number;
}

// ------------------------------------------------------------ seeded PRNG --
/**
 * Deterministic seed from the photo set. Same event content → same plan,
 * byte for byte; different events → different vocabulary offsets. Never
 * Math.random: a re-render must be reproducible to be debuggable.
 */
function seedFromIds(ids: string[]): number {
  let h = 2166136261;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

// -------------------------------------------------------- rhythm snapping --
function allowedBeatMultiples(style: MontageStyle, beatIntervalSeconds: number): number[] {
  // Centre on however many beats the style's own shot length occupies at
  // THIS tempo — a fixed list clamps every segment at high BPM, flattening
  // the profile and dragging runtime short.
  const centre = Math.max(1, Math.round(style.secondsPerPhoto / beatIntervalSeconds));
  const spread = style.pacing === "accelerate" || style.pacing === "alternating" ? 2 : 1;

  const multiples: number[] = [];
  for (let m = Math.max(1, centre - spread); m <= centre + spread; m++) multiples.push(m);
  return multiples;
}

/**
 * Nudge durations onto beat-interval multiples. The style's pacing profile
 * is the STARTING POINT: an accelerating profile still accelerates, a hero
 * hold is still the longest. Beat SPACING only — never phase-locked.
 */
function snapDurationsToBeats(
  durations: number[],
  beatIntervalSeconds: number,
  style: MontageStyle,
  roles: NarrativeRole[],
): number[] {
  // A cross-fade cannot outlast its segments; floor covers the LONGEST join
  // this preset can assign.
  const floor = Math.max(0.8, maxTransitionSeconds(style) + 0.35);
  const multiples = allowedBeatMultiples(style, beatIntervalSeconds).filter((m) => m * beatIntervalSeconds >= floor);
  if (multiples.length === 0) return durations;

  const snapOne = (seconds: number) =>
    multiples.reduce((best, m) => {
      const candidate = m * beatIntervalSeconds;
      return Math.abs(candidate - seconds) < Math.abs(best - seconds) ? candidate : best;
    }, multiples[0] * beatIntervalSeconds);

  const snapped = durations.map(snapOne);

  // Drift control: step individual segments to a neighbouring multiple
  // rather than rescaling everything, which would pull all of them off-beat.
  const target = durations.reduce((a, b) => a + b, 0);
  const maxDrift = 0.1;
  for (let guard = 0; guard < snapped.length * 2; guard++) {
    const total = snapped.reduce((a, b) => a + b, 0);
    const drift = (total - target) / target;
    if (Math.abs(drift) <= maxDrift) break;

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

  // Some tempos cannot express a style (Hype at 85 BPM: one beat sits under
  // the transition floor). Style intent wins over rhythm — fall back.
  const finalDrift = Math.abs(snapped.reduce((a, b) => a + b, 0) - target) / target;
  if (finalDrift > maxDrift) return durations;

  // Hero hold: the closing shot must out-hold the opener and the peak.
  // Stepped up whole beats — never padded with arbitrary seconds — one
  // multiple past the ceiling if needed, inside a slightly wider budget.
  const heroIndex = snapped.length - 1;
  if (heroIndex > 0 && roles[heroIndex] === "hero") {
    const peakIndex = roles.indexOf("peak");
    const mustBeat = Math.max(snapped[0], peakIndex > 0 ? snapped[peakIndex] : 0);
    const ceiling = Math.max(...multiples) + 1;
    const heroDriftBudget = 0.15;

    for (let step = 0; step < 4 && snapped[heroIndex] <= mustBeat + 1e-6; step++) {
      const nextMultiple = Math.round(snapped[heroIndex] / beatIntervalSeconds) + 1;
      if (nextMultiple > ceiling) break;
      const candidate = nextMultiple * beatIntervalSeconds;
      const projected = snapped.reduce((a, b) => a + b, 0) - snapped[heroIndex] + candidate;
      if (Math.abs(projected - target) / target > heroDriftBudget) break;
      snapped[heroIndex] = candidate;
    }

    if (snapped[heroIndex] < mustBeat - 1e-6) return durations;
  }

  return snapped.map((d) => Math.round(Math.max(floor, d) * 1000) / 1000);
}

// --------------------------------------------------------------- authoring --
/** Treatment for one segment, resolved from role + vocabulary + seed. */
function treatmentFor(
  style: MontageStyle,
  role: NarrativeRole,
  middleIndex: number,
  vocabOffset: number,
): RoleTreatment {
  if (role === "opener") return style.opener;
  if (role === "peak") return style.peak;
  if (role === "hero") return style.hero;
  const vocab = style.motionVocabulary;
  return vocab[(vocabOffset + middleIndex) % vocab.length];
}

/**
 * Build the plan for a montage. Selection has already decided WHICH photos
 * in WHAT order; this attaches the preset's visual language to that
 * decision: per-segment motion/easing/parallax, curated transitions with
 * the signature join gated to peak and hero, and a bounded flash budget
 * spent where the narrative peaks.
 */
export function buildEditPlan<T extends SelectionCandidate>(options: {
  selection: SelectionResult<T>;
  style: MontageStyle;
  /** Local path per media id, from the caller's storage resolution. */
  pathsByMediaId: Map<string, string>;
  music: EditPlanMusic | null;
}): EditPlan {
  const { selection, style, pathsByMediaId, music } = options;

  const usable: SelectedPhoto<T>[] = selection.selected.filter((s) => pathsByMediaId.has(s.candidate.id));

  // Style intent first, then music rhythm refines it; unknown BPM keeps the
  // profile exactly as authored. Enhancement, never a render dependency.
  const styleDurations = photoDurations(usable.length, style);
  const beatInterval = music?.beatIntervalSeconds ?? null;
  const durations =
    beatInterval && beatInterval > 0
      ? snapDurationsToBeats(
          styleDurations,
          beatInterval,
          style,
          usable.map((u) => u.role),
        )
      : styleDurations;

  const seed = seedFromIds(usable.map((u) => u.candidate.id));
  const vocabOffset = seed % Math.max(1, style.motionVocabulary.length);

  let middleIndex = 0;
  const segments: EditSegment[] = usable.map((item, index) => {
    const role = item.role;
    const treatment = treatmentFor(style, role, role === "build" || role === "variety" ? middleIndex++ : 0, vocabOffset);
    return {
      mediaId: item.candidate.id,
      sourcePath: pathsByMediaId.get(item.candidate.id)!,
      role,
      durationSeconds: durations[index],
      motion: treatment.motion,
      motionMagnitude: treatment.magnitude,
      easing: treatment.easing,
      bgMagnitude: style.fit === "blurred" ? style.bgMagnitude : 0,
      rotateDriftDegrees: style.rotateDriftDegrees,
      fit: style.fit,
      transitionOut: style.baseTransition.kind,
      transitionSeconds: style.baseTransition.seconds,
      accent: null,
      reason: item.reason,
    };
  });

  // Role-gated decoration: the signature join may ONLY fire entering the
  // peak and entering the hero. Everything else keeps the preset's base
  // join. Two decorated moments per video, maximum — restraint is the point.
  const peakIdx = segments.findIndex((s) => s.role === "peak");
  const heroIdx = segments.length - 1;
  if (peakIdx > 0) {
    segments[peakIdx - 1].transitionOut = style.signatureTransition.kind;
    segments[peakIdx - 1].transitionSeconds = style.signatureTransition.seconds;
  }
  if (heroIdx > 0 && segments[heroIdx].role === "hero" && peakIdx !== heroIdx) {
    segments[heroIdx - 1].transitionOut = style.signatureTransition.kind;
    segments[heroIdx - 1].transitionSeconds = style.signatureTransition.seconds;
  }

  // Accent budget: a short white flash INTO the peak (the "something
  // happened" moment, sitting where 2C put the music's energy), and — for
  // the energetic presets with budget left — into the hero. Realised by
  // rewriting the previous join, so the renderer stays accent-blind.
  let accentsLeft = style.accentBudget;
  if (accentsLeft > 0 && peakIdx > 0) {
    segments[peakIdx].accent = "flash-in";
    segments[peakIdx - 1].transitionOut = "fadewhite";
    segments[peakIdx - 1].transitionSeconds = Math.min(0.18, Math.max(0.1, style.signatureTransition.seconds / 2));
    accentsLeft -= 1;
  }
  if (accentsLeft > 0 && heroIdx > 0 && segments[heroIdx].role === "hero" && heroIdx !== peakIdx) {
    segments[heroIdx].accent = "flash-in";
    segments[heroIdx - 1].transitionOut = "fadewhite";
    segments[heroIdx - 1].transitionSeconds = Math.min(0.18, Math.max(0.1, style.signatureTransition.seconds / 2));
    accentsLeft -= 1;
  }

  // No-repeat guard for presets whose base join is decorative (slides):
  // two identical decorated joins in a row read as a gimmick. Alternate
  // direction deterministically instead.
  for (let i = 1; i < segments.length - 1; i++) {
    const prev = segments[i - 1];
    const cur = segments[i];
    if (cur.transitionOut === prev.transitionOut && cur.transitionOut === "slideleft") {
      cur.transitionOut = "slideright";
    }
  }

  const excluded = [...selection.excluded];
  for (const item of selection.selected) {
    if (!pathsByMediaId.has(item.candidate.id)) {
      excluded.push({ mediaId: item.candidate.id, reason: "file could not be read" });
    }
  }

  return {
    planVersion: 2,
    presetId: style.id,
    presetName: style.name,
    look: style.look,
    targetDurationSeconds: planDurationSeconds(segments),
    segments,
    music,
    excluded,
    duplicatesFound: selection.duplicatesFound,
  };
}

/**
 * Predicted picture length, accounting for per-segment transition overlap.
 * A PREDICTION — callers needing truth probe the rendered file.
 */
export function planDurationSeconds(segments: EditSegment[]): number {
  const raw = segments.reduce((total, s) => total + s.durationSeconds, 0);
  const overlap = segments.slice(0, -1).reduce((total, s) => total + effectiveTransitionSeconds(s), 0);
  return Math.max(0, raw - overlap);
}

/** A hard cut has no overlap; everything else overlaps by its duration. */
export function effectiveTransitionSeconds(segment: EditSegment): number {
  return segment.transitionOut === "cut" ? 0 : segment.transitionSeconds;
}

/** True when no segment asks for a real blend, so plain concat will do. */
export function isAllHardCuts(segments: EditSegment[]): boolean {
  return segments.slice(0, -1).every((s) => s.transitionOut === "cut" || s.transitionSeconds <= 0);
}

/**
 * One-line-per-segment summary for logs. Omits storage paths — this is for
 * answering "why does the edit look like this", not for exposing disk.
 */
export function describeEditPlan(plan: EditPlan): string {
  const header =
    `[plan v${plan.planVersion}] preset=${plan.presetName} · ${plan.segments.length} segments · ` +
    `~${plan.targetDurationSeconds.toFixed(1)}s · look sat=${plan.look.saturation} con=${plan.look.contrast} ` +
    `vig=${plan.look.vignette} grain=${plan.look.grain} · ${plan.duplicatesFound} near-duplicates skipped` +
    (plan.music ? ` · music=${plan.music.title ?? plan.music.catalogId}` : " · no music");

  const rows = plan.segments.map((s, i) => {
    const move =
      s.motion === "none"
        ? "still"
        : `${s.motion} ${Math.round(s.motionMagnitude * 100)}%/${s.easing}` +
          (s.bgMagnitude > 0 ? ` bg${Math.round(s.bgMagnitude * 100)}%` : "") +
          (s.rotateDriftDegrees > 0 ? ` rot${s.rotateDriftDegrees}°` : "");
    const join =
      i === plan.segments.length - 1
        ? "end"
        : `${s.transitionOut}${s.transitionSeconds ? ` ${s.transitionSeconds}s` : ""}`;
    const accent = s.accent ? ` ⚡${s.accent}` : "";
    return `  ${String(i + 1).padStart(2)}. ${s.role.padEnd(7)} ${s.mediaId.slice(-6)} ${s.durationSeconds.toFixed(2)}s ${move.padEnd(30)} → ${join}${accent}`;
  });

  return [header, ...rows].join("\n");
}
