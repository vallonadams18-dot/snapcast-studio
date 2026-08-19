import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_IN_20_TEMPLATE,
  INSTANT_HYPE_TEMPLATE,
  LOVE_STORY_TEMPLATE,
  SOCIAL_TEMPLATES,
  expandSelectionForTemplate,
} from "./socialTemplates.ts";
import type { SelectionCandidate, SelectionResult } from "./photoSelection.ts";
import { buildEditPlan, planDurationSeconds } from "./editPlan.ts";
import { getMontageStyle } from "./montageStyles.ts";

function candidate(id: string, mediaType: "photo" | "video"): SelectionCandidate {
  return {
    id,
    mediaType,
    storagePath: `/safe/${id}`,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    energyScore: 70,
    visualQualityScore: 70,
    momentRarityScore: 70,
  };
}

test("Event in 20 is a real slot template, not a visual preset", () => {
  assert.equal(EVENT_IN_20_TEMPLATE.targetDurationSeconds, 20);
  assert.equal(EVENT_IN_20_TEMPLATE.maxScenesPerVideo, 6);
  assert.equal(EVENT_IN_20_TEMPLATE.allowsSingleVideo, true);
});

test("one uploaded video expands into distinct edit slots with hook and hero", () => {
  const video = candidate("video-1", "video");
  const selection: SelectionResult = {
    selected: [{ candidate: video, role: "opener", reason: "only source" }],
    excluded: [],
    duplicatesFound: 0,
  };
  const scenes = new Map([
    [video.id, [
      { startSeconds: 1, endSeconds: 3.4 },
      { startSeconds: 8, endSeconds: 10.4 },
      { startSeconds: 15, endSeconds: 17.4 },
    ]],
  ]);

  const result = expandSelectionForTemplate(selection, EVENT_IN_20_TEMPLATE, scenes);
  assert.equal(result.selected.length, 3);
  assert.deepEqual(result.selected.map((item) => item.sourceStartSeconds), [1, 8, 15]);
  assert.equal(result.selected[0].role, "opener");
  assert.equal(result.selected[2].role, "hero");
  // Three supplied windows hit the per-slot ceiling; hero may tie but never
  // becomes shorter than the opener.
  assert.ok((result.selected[2].durationSeconds ?? 0) >= (result.selected[0].durationSeconds ?? 0));
  assert.equal(new Set(result.selected.map((item) => item.candidate.id)).size, 1);
});

test("expanded edit caps slots while preserving opener and hero", () => {
  const selected = Array.from({ length: 8 }, (_, index) => ({
    candidate: candidate(`media-${index}`, index < 2 ? "video" : "photo"),
    role: index === 0 ? ("opener" as const) : index === 7 ? ("hero" as const) : ("build" as const),
    reason: "selected",
  }));
  const selection: SelectionResult = { selected, excluded: [], duplicatesFound: 2 };
  const scenes = new Map([
    ["media-0", [
      { startSeconds: 1, endSeconds: 3.4 },
      { startSeconds: 5, endSeconds: 7.4 },
      { startSeconds: 9, endSeconds: 11.4 },
    ]],
    ["media-1", [
      { startSeconds: 2, endSeconds: 4.4 },
      { startSeconds: 6, endSeconds: 8.4 },
      { startSeconds: 10, endSeconds: 12.4 },
    ]],
  ]);

  const result = expandSelectionForTemplate(selection, EVENT_IN_20_TEMPLATE, scenes);
  assert.equal(result.selected.length, EVENT_IN_20_TEMPLATE.maxSegments);
  assert.equal(result.selected[0].role, "opener");
  assert.equal(result.selected.at(-1)?.role, "hero");
  const peakIndex = result.selected.findIndex((item) => item.role === "peak");
  assert.ok(peakIndex >= 1 && peakIndex <= result.selected.length - 3);
  assert.equal(result.duplicatesFound, 2);
  const predicted = result.selected.reduce((total, item) => total + (item.durationSeconds ?? 0), 0) -
    (result.selected.length - 1) * 0.3;
  assert.ok(Math.abs(predicted - EVENT_IN_20_TEMPLATE.targetDurationSeconds) < 0.02);
});

test("Instant Hype opens with a one-second flash of the hero it ends on", () => {
  const selected = Array.from({ length: 7 }, (_, index) => ({
    candidate: candidate(`m-${index}`, "photo" as const),
    role: index === 0 ? ("opener" as const) : index === 6 ? ("hero" as const) : ("build" as const),
    reason: "selected",
  }));
  const selection: SelectionResult = { selected, excluded: [], duplicatesFound: 0 };

  const result = expandSelectionForTemplate(selection, INSTANT_HYPE_TEMPLATE, new Map());
  const slots = result.selected;
  const hero = slots.at(-1)!;

  // The tease IS the hero's media, one second, in the opener slot.
  assert.equal(slots[0].role, "opener");
  assert.equal(slots[0].candidate.id, hero.candidate.id);
  assert.equal(slots[0].durationSeconds, 1);
  assert.equal(hero.role, "hero");
  // The hero out-holds everything; the middles are rapid bursts.
  for (const slot of slots.slice(1, -1)) {
    assert.ok((hero.durationSeconds ?? 0) > (slot.durationSeconds ?? 0));
    assert.ok((slot.durationSeconds ?? 0) >= INSTANT_HYPE_TEMPLATE.slotClampSeconds.min);
    assert.ok((slot.durationSeconds ?? 0) <= INSTANT_HYPE_TEMPLATE.slotClampSeconds.max);
  }
  // Runtime lands near 12s once per-join overlap is subtracted.
  const predicted =
    slots.reduce((total, item) => total + (item.durationSeconds ?? 0), 0) -
    (slots.length - 1) * INSTANT_HYPE_TEMPLATE.transitionAllowancePerJoin;
  assert.ok(Math.abs(predicted - INSTANT_HYPE_TEMPLATE.targetDurationSeconds) < 1);

  // Determinism: same inputs, byte-identical plan.
  const again = expandSelectionForTemplate(selection, INSTANT_HYPE_TEMPLATE, new Map());
  assert.deepEqual(
    again.selected.map((s) => [s.candidate.id, s.role, s.durationSeconds]),
    slots.map((s) => [s.candidate.id, s.role, s.durationSeconds]),
  );
});

test("Instant Hype flash never exceeds maxSegments", () => {
  const selected = Array.from({ length: 14 }, (_, index) => ({
    candidate: candidate(`m-${index}`, "photo" as const),
    role: index === 0 ? ("opener" as const) : index === 13 ? ("hero" as const) : ("build" as const),
    reason: "selected",
  }));
  const selection: SelectionResult = { selected, excluded: [], duplicatesFound: 0 };
  const result = expandSelectionForTemplate(selection, INSTANT_HYPE_TEMPLATE, new Map());
  assert.ok(result.selected.length <= INSTANT_HYPE_TEMPLATE.maxSegments);
  assert.equal(result.selected[0].candidate.id, result.selected.at(-1)!.candidate.id);
});

test("Love Story holds longer, builds gently, and never flashes", () => {
  const selected = Array.from({ length: 7 }, (_, index) => ({
    candidate: candidate(`w-${index}`, index === 3 ? ("video" as const) : ("photo" as const)),
    role: index === 0 ? ("opener" as const) : index === 6 ? ("hero" as const) : ("build" as const),
    reason: "selected",
  }));
  const selection: SelectionResult = { selected, excluded: [], duplicatesFound: 0 };
  const scenes = new Map([["w-3", [{ startSeconds: 2, endSeconds: 7 }]]]);

  const result = expandSelectionForTemplate(selection, LOVE_STORY_TEMPLATE, scenes);
  const slots = result.selected;

  // No hero flash: the opener is its own moment, not a tease.
  assert.notEqual(slots[0].candidate.id, slots.at(-1)!.candidate.id);
  assert.equal(slots[0].role, "opener");
  assert.equal(slots.at(-1)!.role, "hero");
  // Every hold is unhurried — the emotional pacing floor.
  for (const slot of slots) {
    assert.ok((slot.durationSeconds ?? 0) >= LOVE_STORY_TEMPLATE.slotClampSeconds.min);
  }
  // The hero is the longest hold in the video.
  const heroSeconds = slots.at(-1)!.durationSeconds ?? 0;
  for (const slot of slots.slice(0, -1)) assert.ok(heroSeconds >= (slot.durationSeconds ?? 0));
  const predicted =
    slots.reduce((total, item) => total + (item.durationSeconds ?? 0), 0) -
    (slots.length - 1) * LOVE_STORY_TEMPLATE.transitionAllowancePerJoin;
  assert.ok(Math.abs(predicted - LOVE_STORY_TEMPLATE.targetDurationSeconds) < 1);
});

test("all templates carry a coherent narrative policy", () => {
  for (const t of SOCIAL_TEMPLATES) {
    assert.ok(t.slotWeights.hero > t.slotWeights.middle, `${t.id}: hero must out-weigh the middle`);
    assert.ok(t.slotClampSeconds.min < t.slotClampSeconds.max, `${t.id}: clamp range`);
    assert.ok(t.peakPosition > 0.5 && t.peakPosition < 0.9, `${t.id}: peak sits late-middle`);
    if (t.heroFlashSeconds !== null) assert.ok(t.heroFlashSeconds <= 1.5, `${t.id}: a flash is a tease, not a scene`);
  }
});

test("one long video can fill six distinct slots near the target runtime", () => {
  const video = candidate("long-video", "video");
  const selection: SelectionResult = {
    selected: [{ candidate: video, role: "opener", reason: "only source" }],
    excluded: [],
    duplicatesFound: 0,
  };
  const windows = Array.from({ length: 6 }, (_, index) => ({
    startSeconds: index * 5,
    endSeconds: index * 5 + 4.5,
  }));
  const result = expandSelectionForTemplate(selection, EVENT_IN_20_TEMPLATE, new Map([[video.id, windows]]));
  assert.equal(result.selected.length, 6);
  const predicted = result.selected.reduce((total, item) => total + (item.durationSeconds ?? 0), 0) - 5 * 0.3;
  assert.ok(Math.abs(predicted - 20) < 0.15);
  assert.equal(result.selected.at(-1)?.role, "hero");

  const plan = buildEditPlan({
    selection: result,
    style: getMontageStyle(EVENT_IN_20_TEMPLATE.basePresetId),
    pathsByMediaId: new Map([[video.id, "/safe/long-video.mp4"]]),
    videoDurationsById: new Map([[video.id, 35]]),
    music: null,
  });
  assert.equal(plan.segments.length, 6);
  assert.deepEqual(plan.segments.map((segment) => segment.sourceStartSeconds), [0, 5, 10, 15, 20, 25]);
  assert.equal(plan.segments.at(-1)?.role, "hero");
  assert.ok(Math.abs(planDurationSeconds(plan.segments) - 20) < 0.35);
});
