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
  const durations = photoDurations(usable.length, style);

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
