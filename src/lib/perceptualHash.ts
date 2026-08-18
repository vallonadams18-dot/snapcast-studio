// Server-only: spawns ffmpeg.
//
// Perceptual hashing for near-duplicate detection, with no new dependency.
// There is no image library in this project (no sharp, no jimp, no canvas),
// and ffmpeg is already a hard requirement — so it does the decoding.
//
// The algorithm is dHash: shrink to 9x8 greyscale, then compare each pixel
// to its right-hand neighbour. That yields 8 comparisons per row across 8
// rows = 64 bits describing the image's gradient structure rather than its
// exact pixels, which is what makes it survive the things photo-booth shots
// actually vary by — exposure shifts, a slightly different crop, and JPEG
// recompression — while still separating genuinely different moments.
import { spawn } from "node:child_process";
import { resolveFfmpegPath } from "@/lib/ffmpegPaths";

/** 64 comparison bits, one per byte. */
export type PerceptualHash = Uint8Array;

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

/**
 * Bit distance below which two photos are treated as the same moment.
 *
 * Calibrated conservatively: a lower number keeps more near-duplicates, a
 * higher one risks discarding genuinely different shots that happen to share
 * a composition (the same two people at the same booth backdrop). 10 of 64
 * bits is the usual starting point for dHash, and it wants checking against
 * a real event before it is trusted.
 */
export const DUPLICATE_DISTANCE = 10;

function runCapturingStdout(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), args);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    // Drained but ignored — ffmpeg logs to stderr even on success, and an
    // unread pipe can stall the child.
    proc.stderr.on("data", () => {});
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg hash exited ${code}`)),
    );
  });
}

/**
 * 64-bit perceptual hash of an image file, or null if it could not be read.
 *
 * Null is not a failure worth surfacing: a photo we cannot hash simply takes
 * no part in duplicate comparison and is still eligible for the montage.
 * Losing a photo because its hash failed would be far worse than showing a
 * duplicate.
 */
export async function computeDHash(imagePath: string): Promise<PerceptualHash | null> {
  try {
    const raw = await runCapturingStdout([
      "-i", imagePath,
      "-vf", `scale=${HASH_WIDTH}:${HASH_HEIGHT}`,
      "-pix_fmt", "gray",
      "-frames:v", "1",
      "-f", "rawvideo",
      "-",
    ]);

    if (raw.length < HASH_WIDTH * HASH_HEIGHT) return null;

    // One byte per comparison rather than a packed 64-bit integer: BigInt
    // literals need an ES2020 target and this project sets a lower one, and
    // 64 bytes per photo is not worth changing a compiler target over.
    const hash = new Uint8Array(HASH_HEIGHT * (HASH_WIDTH - 1));
    let bit = 0;
    for (let y = 0; y < HASH_HEIGHT; y++) {
      for (let x = 0; x < HASH_WIDTH - 1; x++) {
        const left = raw[y * HASH_WIDTH + x];
        const right = raw[y * HASH_WIDTH + x + 1];
        hash[bit++] = left > right ? 1 : 0;
      }
    }
    return hash;
  } catch {
    return null;
  }
}

/** Number of differing bits. 0 = identical structure, 64 = maximally different. */
export function hammingDistance(a: PerceptualHash, b: PerceptualHash): number {
  let count = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) count++;
  }
  return count;
}

/** True when two photos are close enough to be the same moment. */
export function isNearDuplicate(a: PerceptualHash | null, b: PerceptualHash | null): boolean {
  if (a === null || b === null) return false;
  return hammingDistance(a, b) <= DUPLICATE_DISTANCE;
}
