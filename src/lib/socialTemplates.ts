// Client-safe template data plus pure slot planning. A SocialTemplate
// describes WHAT story to assemble; MontageStyle describes HOW that story
// looks. Keeping those concepts separate prevents "templates" from becoming
// renamed zoom presets again.
import type { SelectedPhoto, SelectionCandidate, SelectionResult } from "./photoSelection.ts";
import type { VideoSceneWindow } from "./videoScenePlanning.ts";

export interface SocialTemplate {
  id: string;
  name: string;
  category: "event" | "party" | "wedding" | "luxury" | "corporate" | "social";
  description: string;
  targetDurationSeconds: number;
  minSourceAssets: number;
  maxSourceAssets: number;
  maxSegments: number;
  maxScenesPerVideo: number;
  videoSceneSeconds: number;
  allowsSingleVideo: boolean;
  basePresetId: string;

  // ---- narrative policy: the template's pacing DNA -------------------
  /** Screen-time weight per narrative role. "middle" covers build/variety. */
  slotWeights: { opener: number; middle: number; peak: number; hero: number };
  /** Per-slot screen-time bounds, seconds. */
  slotClampSeconds: { min: number; max: number };
  /** Where the energy peak sits, as a fraction of the edit (0–1). */
  peakPosition: number;
  /**
   * Expected per-join overlap for the base preset's transitions, so the
   * runtime lands near the target: crossfade presets eat real time at every
   * join, hard-cut presets eat none.
   */
  transitionAllowancePerJoin: number;
  /**
   * Instant-hook opener: prepend a short tease of the HERO media as the
   * very first slot, null to disable. The hero still closes the video —
   * the tease is the curiosity hook, the ending pays it off.
   */
  heroFlashSeconds: number | null;
}

export const EVENT_IN_20_TEMPLATE: SocialTemplate = {
  id: "event-in-20",
  name: "Event in 20 Seconds",
  category: "event",
  description: "A fast hook, mixed event moments, an energy peak, and a strong hero ending.",
  targetDurationSeconds: 20,
  minSourceAssets: 2,
  maxSourceAssets: 8,
  maxSegments: 10,
  maxScenesPerVideo: 6,
  // Detection reserves enough source around each cut for the role-aware
  // slot timing below; most slots play less than this.
  videoSceneSeconds: 4.5,
  allowsSingleVideo: true,
  basePresetId: "party",
  slotWeights: { opener: 1.1, middle: 0.95, peak: 1.05, hero: 1.35 },
  slotClampSeconds: { min: 1.2, max: 4.5 },
  peakPosition: 0.68,
  transitionAllowancePerJoin: 0.3,
  heroFlashSeconds: null,
};

export const INSTANT_HYPE_TEMPLATE: SocialTemplate = {
  id: "instant-hype",
  name: "Instant Hype",
  category: "party",
  description: "A one-second hero flash up front, rapid beat bursts, and a big final hold.",
  targetDurationSeconds: 12,
  minSourceAssets: 2,
  maxSourceAssets: 12,
  maxSegments: 11,
  maxScenesPerVideo: 5,
  videoSceneSeconds: 3.2,
  allowsSingleVideo: true,
  // Hype: hard cuts, zoom punches, white-flash accents into peak and hero.
  basePresetId: "hype",
  slotWeights: { opener: 1.0, middle: 0.8, peak: 1.05, hero: 1.8 },
  slotClampSeconds: { min: 0.6, max: 3.2 },
  peakPosition: 0.7,
  // Hype joins are hard cuts — almost no overlap to compensate for.
  transitionAllowancePerJoin: 0.05,
  heroFlashSeconds: 1,
};

export const LOVE_STORY_TEMPLATE: SocialTemplate = {
  id: "love-story",
  name: "Love Story",
  category: "wedding",
  description: "An emotional opener, gentle builds with longer holds, and an intimate final hero.",
  targetDurationSeconds: 21,
  minSourceAssets: 3,
  maxSourceAssets: 9,
  maxSegments: 8,
  maxScenesPerVideo: 4,
  videoSceneSeconds: 5,
  allowsSingleVideo: true,
  // Cinematic: slow eased push-ins, long fades, one restrained accent.
  basePresetId: "cinematic",
  slotWeights: { opener: 1.15, middle: 0.95, peak: 1.1, hero: 1.5 },
  slotClampSeconds: { min: 1.8, max: 4.8 },
  peakPosition: 0.72,
  // Cinematic fades overlap generously at every join.
  transitionAllowancePerJoin: 0.6,
  heroFlashSeconds: null,
};

export const SOCIAL_TEMPLATES: SocialTemplate[] = [
  INSTANT_HYPE_TEMPLATE,
  LOVE_STORY_TEMPLATE,
  EVENT_IN_20_TEMPLATE,
];

export function getSocialTemplate(id: unknown): SocialTemplate | null {
  if (typeof id !== "string") return null;
  return SOCIAL_TEMPLATES.find((template) => template.id === id) ?? null;
}

export interface TemplateSelectedMedia<T extends SelectionCandidate = SelectionCandidate> extends SelectedPhoto<T> {
  /** Template-selected trim window for a video segment. */
  sourceStartSeconds?: number;
  /** Exact slot duration for a detected video scene. */
  durationSeconds?: number;
}

function sampleToLimit<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  if (limit <= 1) return [items[items.length - 1]];
  const out: T[] = [];
  for (let i = 0; i < limit; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (limit - 1))]);
  }
  return out;
}

/**
 * Expand selected videos into several distinct scene slots, then re-assert a
 * template narrative over the expanded sequence. Source assets are never
 * mutated; repeated video slots still point at the same original Media row.
 */
export function expandSelectionForTemplate<T extends SelectionCandidate>(
  selection: SelectionResult<T>,
  template: SocialTemplate,
  scenesByMediaId: Map<string, VideoSceneWindow[]>,
): SelectionResult<T> {
  const expanded: TemplateSelectedMedia<T>[] = [];

  for (const item of selection.selected) {
    if (item.candidate.mediaType !== "video") {
      expanded.push({ ...item });
      continue;
    }

    const scenes = (scenesByMediaId.get(item.candidate.id) ?? []).slice(0, template.maxScenesPerVideo);
    if (scenes.length === 0) {
      expanded.push({ ...item });
      continue;
    }

    scenes.forEach((scene, index) => {
      expanded.push({
        ...item,
        sourceStartSeconds: scene.startSeconds,
        durationSeconds: scene.endSeconds - scene.startSeconds,
        reason: `${item.reason}; video moment ${index + 1} of ${scenes.length} at ${scene.startSeconds.toFixed(1)}s`,
      });
    });
  }

  // A hero-flash template reserves its first slot for the tease that gets
  // prepended after timing — sample one fewer so maxSegments still holds.
  const wantsFlash = template.heroFlashSeconds !== null && expanded.length >= 2;
  const limit = wantsFlash ? Math.max(2, template.maxSegments - 1) : template.maxSegments;
  const selected = sampleToLimit(expanded, limit);
  if (selected.length === 0) return { ...selection, selected: [] };

  // Roles describe the expanded EDIT, not the source-file list. The final
  // slot is always hero; a peak owns a late-middle slot but never crowds it.
  const peakIndex =
    selected.length >= 4
      ? Math.min(selected.length - 3, Math.max(1, Math.round((selected.length - 1) * template.peakPosition)))
      : -1;
  const rerolled = selected.map((item, index): TemplateSelectedMedia<T> => {
    if (index === 0) return { ...item, role: "opener", reason: `${item.reason}; template opening hook` };
    if (index === selected.length - 1) {
      return { ...item, role: "hero", reason: `${item.reason}; template hero ending` };
    }
    if (index === peakIndex) return { ...item, role: "peak", reason: `${item.reason}; template energy peak` };
    return { ...item, role: index % 2 === 0 ? "variety" : "build" };
  });

  // A real template owns timing. Budget the base preset's per-join overlap,
  // then distribute the actual screen time by the template's role weights,
  // so the runtime lands near the target across different media counts
  // instead of the name describing a runtime the renderer never reaches.
  const flashSeconds = wantsFlash ? template.heroFlashSeconds! : 0;
  const joinCount = Math.max(0, rerolled.length - 1 + (wantsFlash ? 1 : 0));
  const transitionAllowance = joinCount * template.transitionAllowancePerJoin;
  const screenTimeBudget = template.targetDurationSeconds + transitionAllowance - flashSeconds;
  const { slotWeights: w, slotClampSeconds: clamp } = template;
  const weightFor = (item: TemplateSelectedMedia<T>) =>
    item.role === "hero" ? w.hero : item.role === "opener" ? w.opener : item.role === "peak" ? w.peak : w.middle;
  const weightSum = rerolled.reduce((total, item) => total + weightFor(item), 0);
  const timed = rerolled.map((item) => ({
    ...item,
    durationSeconds:
      Math.round(Math.min(clamp.max, Math.max(clamp.min, (screenTimeBudget * weightFor(item)) / weightSum)) * 1000) /
      1000,
  }));

  if (wantsFlash && timed.length >= 2) {
    // The tease shows the SAME media the video ends on — hook first second,
    // pay it off last. The demoted first slot rejoins the middle build.
    const hero = timed[timed.length - 1];
    const flash: TemplateSelectedMedia<T> = {
      ...hero,
      role: "opener",
      durationSeconds: flashSeconds,
      reason: "hero flash — a one-second tease of the ending as the hook",
    };
    timed[0] = { ...timed[0], role: "build" };
    return { ...selection, selected: [flash, ...timed] };
  }

  return { ...selection, selected: timed };
}
