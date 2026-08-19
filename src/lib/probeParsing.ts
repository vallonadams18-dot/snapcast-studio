// Parsing for `ffmpeg -i` header probes. Kept free of app imports so the
// upload test suite can exercise it under plain `node --test`.

/**
 * Extract the duration, in seconds, from an ffmpeg header dump.
 *
 * MUST be given the COMPLETE stderr of the probe. `Duration:` appears right
 * after the input's global metadata and BEFORE the per-stream listing — and
 * a metadata-heavy container (every real iPhone .mov: extra streams,
 * QuickTime tags, colour info) prints well over 2000 characters of stream
 * detail after it. Parsing any tail-truncated form of the output is exactly
 * the bug that had customer videos rejected as "corrupt".
 *
 * Returns null when no parseable duration exists (including `Duration:
 * N/A`, which ffmpeg prints for genuinely unreadable/raw streams).
 */
export function parseFfmpegDuration(probeOutput: string): number | null {
  const match = probeOutput.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}
