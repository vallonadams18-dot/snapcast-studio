import test from "node:test";
import assert from "node:assert/strict";
import { parseSceneChangeTimes, planVideoSceneWindows } from "./videoScenePlanning.ts";

test("parses and deduplicates ffmpeg showinfo scene timestamps", () => {
  const output = "[showinfo] n:1 pts_time:2.5 x\n[showinfo] n:2 pts_time:8.125 x\npts_time:2.5";
  assert.deepEqual(parseSceneChangeTimes(output), [2.5, 8.125]);
});

test("detected cuts become distinct bounded windows", () => {
  const windows = planVideoSceneWindows(24, [2, 8, 15, 20], 3, 2.4);
  assert.equal(windows.length, 3);
  assert.ok(windows[0].startSeconds < windows[1].startSeconds);
  assert.ok(windows[1].startSeconds < windows[2].startSeconds);
  for (const window of windows) {
    assert.ok(window.startSeconds >= 0);
    assert.ok(window.endSeconds <= 24);
    assert.ok(Math.abs(window.endSeconds - window.startSeconds - 2.4) < 0.01);
  }
});

test("continuous phone take falls back to multiple evenly spaced moments", () => {
  const windows = planVideoSceneWindows(35, [], 6, 4.5);
  assert.equal(windows.length, 6);
  for (let index = 1; index < windows.length; index++) {
    assert.ok(windows[index].startSeconds - windows[index - 1].startSeconds > 4);
  }
});

test("short video becomes one safe full-length window", () => {
  assert.deepEqual(planVideoSceneWindows(1.8, [1], 3, 2.4), [{ startSeconds: 0, endSeconds: 1.8 }]);
});
