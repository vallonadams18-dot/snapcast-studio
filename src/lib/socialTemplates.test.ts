import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_IN_20_TEMPLATE, expandSelectionForTemplate } from "./socialTemplates.ts";
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
