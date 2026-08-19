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
};

export const SOCIAL_TEMPLATES: SocialTemplate[] = [EVENT_IN_20_TEMPLATE];

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

  const selected = sampleToLimit(expanded, template.maxSegments);
  if (selected.length === 0) return { ...selection, selected: [] };

  // Roles describe the expanded EDIT, not the source-file list. The final
  // slot is always hero; a peak owns a late-middle slot but never crowds it.
  const peakIndex = selected.length >= 4 ? Math.min(selected.length - 3, Math.max(1, Math.round((selected.length - 1) * 0.68))) : -1;
  const rerolled = selected.map((item, index): TemplateSelectedMedia<T> => {
    if (index === 0) return { ...item, role: "opener", reason: `${item.reason}; template opening hook` };
    if (index === selected.length - 1) {
      return { ...item, role: "hero", reason: `${item.reason}; template hero ending` };
    }
    if (index === peakIndex) return { ...item, role: "peak", reason: `${item.reason}; template energy peak` };
    return { ...item, role: index % 2 === 0 ? "variety" : "build" };
  });

  // A real template owns timing. Budget a modest transition overlap, then
  // distribute the actual screen time by narrative role. This keeps the
  // result close to 20 seconds across different media counts instead of the
  // name describing a runtime the renderer never attempts to reach.
  const transitionAllowance = Math.max(0, rerolled.length - 1) * 0.3;
  const screenTimeBudget = template.targetDurationSeconds + transitionAllowance;
  const weightFor = (item: TemplateSelectedMedia<T>) =>
    item.role === "hero" ? 1.35 : item.role === "opener" ? 1.1 : item.role === "peak" ? 1.05 : 0.95;
  const weightSum = rerolled.reduce((total, item) => total + weightFor(item), 0);
  const timed = rerolled.map((item) => ({
    ...item,
    durationSeconds: Math.round(Math.min(4.5, Math.max(1.2, (screenTimeBudget * weightFor(item)) / weightSum)) * 1000) / 1000,
  }));

  return { ...selection, selected: timed };
}
