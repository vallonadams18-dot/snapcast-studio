// Pure, dependency-free scene planning for uploaded videos. ffmpeg detects
// cut boundaries; this module turns those boundaries into distinct bounded
// windows. It deliberately degrades to evenly spaced windows when a phone
// video contains no hard cuts or the scene filter is unavailable.

export interface VideoSceneWindow {
  startSeconds: number;
  endSeconds: number;
}

export function parseSceneChangeTimes(ffmpegOutput: string): number[] {
  const times: number[] = [];
  const pattern = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  for (const match of ffmpegOutput.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 0) times.push(value);
  }
  return [...new Set(times.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}

function nearestAvailable(candidates: number[], target: number, chosen: number[], minGap: number): number | null {
  const valid = candidates.filter((candidate) => chosen.every((existing) => Math.abs(existing - candidate) >= minGap));
  if (valid.length === 0) return null;
  return valid.reduce((best, candidate) =>
    Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best,
  );
}

export function planVideoSceneWindows(
  durationSeconds: number,
  sceneChangeTimes: number[],
  desiredCount: number,
  windowSeconds: number,
): VideoSceneWindow[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || desiredCount <= 0) return [];
  const length = Math.min(Math.max(1, windowSeconds), durationSeconds);
  const latestStart = Math.max(0, durationSeconds - length);
  if (latestStart === 0) return [{ startSeconds: 0, endSeconds: Math.round(durationSeconds * 1000) / 1000 }];

  // A little after a detected cut avoids including a transition artifact.
  const detected = sceneChangeTimes
    .filter((t) => Number.isFinite(t) && t >= 0 && t < durationSeconds)
    .map((t) => Math.min(latestStart, Math.max(0, t + 0.12)));
  // Continuous phone takes are common at events. Generate as many fallback
  // moments as the template asks for instead of silently capping the edit at
  // four scenes. Keep a small margin at both ends to avoid camera-start and
  // camera-stop handling.
  const fallbackFractions = Array.from({ length: desiredCount }, (_, index) =>
    desiredCount === 1 ? 0.5 : 0.08 + (0.84 * index) / (desiredCount - 1),
  );
  const fallback = fallbackFractions.map((fraction) => latestStart * fraction);
  const candidates = [...new Set([...detected, ...fallback].map((t) => Math.round(t * 100) / 100))].sort((a, b) => a - b);
  const targets = Array.from({ length: desiredCount }, (_, i) => latestStart * ((i + 0.5) / desiredCount));
  const chosen: number[] = [];
  const minGap = Math.min(length * 0.8, latestStart / Math.max(1, desiredCount - 1));

  for (const target of targets) {
    const next = nearestAvailable(candidates, target, chosen, minGap);
    if (next !== null) chosen.push(next);
  }

  return chosen
    .sort((a, b) => a - b)
    .slice(0, desiredCount)
    .map((start) => ({
      startSeconds: Math.round(start * 100) / 100,
      endSeconds: Math.round(Math.min(durationSeconds, start + length) * 100) / 100,
    }));
}
