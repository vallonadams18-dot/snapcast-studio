// EditPlan v3 plan-level tests — run with:
//   npm run test:plan
// Pure planning logic, no ffmpeg: these assert the creative contract —
// photos keep the v2 language exactly, videos get explicit mediaKind with
// trim windows, and the whole plan stays deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEditPlan,
  describeEditPlan,
  videoSegmentSeconds,
  videoTrimStartSeconds,
  type EditPlanMusic,
} from "./editPlan.ts";
import { getMontageStyle, photoDurations } from "./montageStyles.ts";
import type { NarrativeRole, SelectedPhoto, SelectionCandidate, SelectionResult } from "./photoSelection.ts";

interface TestCandidate extends SelectionCandidate {
  id: string;
}

function candidate(id: string, mediaType: "photo" | "video", score = 60): TestCandidate {
  return {
    id,
    storagePath: `/fake/${id}`,
    createdAt: new Date(1700000000000 + id.charCodeAt(id.length - 1) * 1000),
    mediaType,
    energyScore: score,
    visualQualityScore: score,
    momentRarityScore: score,
  };
}

function selectionOf(items: [TestCandidate, NarrativeRole][]): SelectionResult<TestCandidate> {
  const selected: SelectedPhoto<TestCandidate>[] = items.map(([c, role]) => ({
    candidate: c,
    role,
    reason: "test",
  }));
  return { selected, excluded: [], duplicatesFound: 0 };
}

function pathsFor(items: [TestCandidate, NarrativeRole][]): Map<string, string> {
  return new Map(items.map(([c]) => [c.id, `/resolved/${c.id}`]));
}

const CINEMATIC = getMontageStyle("cinematic");
const HYPE = getMontageStyle("hype");

const MUSIC_120: EditPlanMusic = {
  catalogId: "test",
  trackId: "t1",
  title: "Test Track",
  startSeconds: 10,
  bpm: 120,
  beatIntervalSeconds: 0.5,
  energyPeakOffsetSeconds: null,
};

test("pure-photo plan keeps the v2 language exactly, under planVersion 3", () => {
  const items: [TestCandidate, NarrativeRole][] = [
    [candidate("pa", "photo", 80), "opener"],
    [candidate("pb", "photo", 60), "build"],
    [candidate("pc", "photo", 55), "variety"],
    [candidate("pd", "photo", 70), "peak"],
    [candidate("pe", "photo", 90), "hero"],
  ];
  const plan = buildEditPlan({ selection: selectionOf(items), style: CINEMATIC, pathsByMediaId: pathsFor(items), music: null });

  assert.equal(plan.planVersion, 3);
  assert.deepEqual(
    plan.segments.map((s) => s.durationSeconds),
    photoDurations(5, CINEMATIC),
  );
  for (const s of plan.segments) {
    assert.equal(s.mediaKind, "photo");
    assert.equal(s.sourceStartSeconds, 0);
  }
  assert.equal(plan.segments.at(-1)!.role, "hero");
});

test("a video segment is explicit: kind, no synthesised motion, bounded trim", () => {
  const vid = candidate("v-long", "video");
  const items: [TestCandidate, NarrativeRole][] = [
    [candidate("pa", "photo", 80), "opener"],
    [vid, "build"],
    [candidate("pc", "photo", 55), "variety"],
    [candidate("pd", "photo", 70), "peak"],
    [candidate("pe", "photo", 90), "hero"],
  ];
  const plan = buildEditPlan({
    selection: selectionOf(items),
    style: CINEMATIC,
    pathsByMediaId: pathsFor(items),
    music: null,
    videoDurationsById: new Map([[vid.id, 20]]),
  });

  const seg = plan.segments.find((s) => s.mediaId === vid.id)!;
  assert.equal(seg.mediaKind, "video");
  assert.equal(seg.motion, "none");
  assert.equal(seg.motionMagnitude, 0);
  assert.equal(seg.bgMagnitude, 0);
  assert.equal(seg.rotateDriftDegrees, 0);
  assert.ok(seg.durationSeconds >= 2 && seg.durationSeconds <= 4.5);
  assert.ok(seg.sourceStartSeconds >= 0);
  assert.ok(seg.sourceStartSeconds + seg.durationSeconds <= 20);
  // Photos around it keep the preset's camera language.
  const photoSeg = plan.segments.find((s) => s.mediaId === "pa")!;
  assert.notEqual(photoSeg.motion, "none");
});

test("with a known tempo the video hold lands on whole beats", () => {
  const vid = candidate("v-beat", "video");
  const items: [TestCandidate, NarrativeRole][] = [
    [candidate("pa", "photo", 80), "opener"],
    [vid, "build"],
    [candidate("pd", "photo", 70), "peak"],
    [candidate("pe", "photo", 90), "hero"],
  ];
  const plan = buildEditPlan({
    selection: selectionOf(items),
    style: HYPE,
    pathsByMediaId: pathsFor(items),
    music: MUSIC_120,
    videoDurationsById: new Map([[vid.id, 30]]),
  });

  const seg = plan.segments.find((s) => s.mediaId === vid.id)!;
  const beats = seg.durationSeconds / 0.5;
  assert.ok(Math.abs(beats - Math.round(beats)) < 1e-6, `duration ${seg.durationSeconds} is not a beat multiple`);
});

test("a source shorter than the target bounds both hold and trim", () => {
  const vid = candidate("v-short", "video");
  const items: [TestCandidate, NarrativeRole][] = [
    [candidate("pa", "photo", 80), "opener"],
    [vid, "build"],
    [candidate("pe", "photo", 90), "hero"],
  ];
  const plan = buildEditPlan({
    selection: selectionOf(items),
    style: CINEMATIC,
    pathsByMediaId: pathsFor(items),
    music: null,
    videoDurationsById: new Map([[vid.id, 1.6]]),
  });

  const seg = plan.segments.find((s) => s.mediaId === vid.id)!;
  assert.equal(seg.durationSeconds, 1.6);
  assert.equal(seg.sourceStartSeconds, 0);
});

test("a video hero still out-holds the opener and the peak", () => {
  const vid = candidate("v-hero", "video");
  const items: [TestCandidate, NarrativeRole][] = [
    [candidate("pa", "photo", 80), "opener"],
    [candidate("pb", "photo", 60), "build"],
    [candidate("pd", "photo", 70), "peak"],
    [vid, "hero"],
  ];
  const plan = buildEditPlan({
    selection: selectionOf(items),
    style: CINEMATIC,
    pathsByMediaId: pathsFor(items),
    music: null,
    videoDurationsById: new Map([[vid.id, 12]]),
  });

  const durations = plan.segments.map((s) => s.durationSeconds);
  const hero = durations.at(-1)!;
  assert.ok(hero > durations[0], "hero must out-hold the opener");
  assert.ok(hero > durations[2], "hero must out-hold the peak");
});

test("plans are deterministic: same input, identical plan", () => {
  const vid = candidate("v-det", "video");
  const items: [TestCandidate, NarrativeRole][] = [
    [candidate("pa", "photo", 80), "opener"],
    [vid, "build"],
    [candidate("pd", "photo", 70), "peak"],
    [candidate("pe", "photo", 90), "hero"],
  ];
  const build = () =>
    buildEditPlan({
      selection: selectionOf(items),
      style: HYPE,
      pathsByMediaId: pathsFor(items),
      music: MUSIC_120,
      videoDurationsById: new Map([[vid.id, 30]]),
    });
  assert.deepEqual(build(), build());
});

test("accents and signature joins still fire around a video peak", () => {
  const vid = candidate("v-peak", "video");
  const items: [TestCandidate, NarrativeRole][] = [
    [candidate("pa", "photo", 80), "opener"],
    [candidate("pb", "photo", 60), "build"],
    [vid, "peak"],
    [candidate("pe", "photo", 90), "hero"],
  ];
  const plan = buildEditPlan({
    selection: selectionOf(items),
    style: HYPE,
    pathsByMediaId: pathsFor(items),
    music: null,
    videoDurationsById: new Map([[vid.id, 10]]),
  });

  const peakIdx = plan.segments.findIndex((s) => s.role === "peak");
  assert.ok(peakIdx > 0);
  assert.equal(plan.segments[peakIdx].accent, "flash-in");
  assert.equal(plan.segments[peakIdx - 1].transitionOut, "fadewhite");
});

test("describeEditPlan names video segments and the mixed count", () => {
  const vid = candidate("v-desc", "video");
  const items: [TestCandidate, NarrativeRole][] = [
    [candidate("pa", "photo", 80), "opener"],
    [vid, "build"],
    [candidate("pe", "photo", 90), "hero"],
  ];
  const plan = buildEditPlan({
    selection: selectionOf(items),
    style: CINEMATIC,
    pathsByMediaId: pathsFor(items),
    music: null,
    videoDurationsById: new Map([[vid.id, 20]]),
  });

  const description = describeEditPlan(plan);
  assert.match(description, /2 photos \+ 1 video\b/);
  assert.match(description, /live video from/);
  assert.doesNotMatch(description, /\/resolved\//); // never leak paths
});

test("videoSegmentSeconds and videoTrimStartSeconds policy directly", () => {
  // Doubled style length, clamped to the 2–4.5s window.
  assert.equal(videoSegmentSeconds(1.4, null, null), 2.8);
  assert.equal(videoSegmentSeconds(3.2, null, null), 4.5);
  assert.equal(videoSegmentSeconds(0.8, null, null), 2);
  // Beat-aligned when tempo is known.
  assert.equal(videoSegmentSeconds(1.4, 0.5, null) % 0.5, 0);
  // Bounded by the source.
  assert.equal(videoSegmentSeconds(2, null, 1.2), 1.2);
  // Trim centres just before the middle and stays inside the file.
  assert.equal(videoTrimStartSeconds(null, 3), 0);
  assert.equal(videoTrimStartSeconds(2, 3), 0);
  const start = videoTrimStartSeconds(20, 3);
  assert.ok(start > 0 && start + 3 <= 20);
});
