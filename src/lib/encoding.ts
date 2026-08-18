// Shared x264 settings. Deliberately dependency-free (no imports at all) so
// video.ts / music.ts / branding.ts can all pull from here without any risk
// of an import cycle between them.
//
// Two tiers, on purpose. A montage passes through five to seven encodes
// (per-photo segment -> transition concat -> bookend normalise -> bookend
// concat -> music mix -> watermark). Encoding every one of those at the
// delivery quality stacks generation loss; encoding intermediates a little
// finer costs a few MB of scratch space and keeps the final frame clean.

/** Output frame rate. TikTok/Reels are natively 30; 25 reads as judder. */
export const VIDEO_FPS = 30;

/**
 * Mid-chain encodes — anything that will itself be re-encoded later.
 * Finer than delivery so repeated generations don't compound artefacts.
 */
export const INTERMEDIATE_ENCODE = ["-crf", "18", "-preset", "veryfast"] as const;

/**
 * The file a client actually downloads or plays.
 *
 * +faststart moves the moov atom to the front of the mp4. Without it a
 * browser must fetch the tail before it can start playing or scrub, which
 * is exactly the wrong shape for a phone on venue wifi.
 *
 * CRF 20 is finer than x264's default of 23 — better looking, and larger.
 * That trade is deliberate: low-light venue footage and string lights are
 * precisely what falls apart at 23.
 */
export const DELIVERY_ENCODE = ["-crf", "20", "-preset", "veryfast", "-movflags", "+faststart"] as const;

/** Spread helpers — these arrays are `as const`, so copy before passing on. */
export const intermediateEncode = (): string[] => [...INTERMEDIATE_ENCODE];
export const deliveryEncode = (): string[] => [...DELIVERY_ENCODE];
