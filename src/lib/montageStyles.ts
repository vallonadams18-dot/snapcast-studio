// Client-safe: plain data only, no Node built-ins (same rule as
// musicCatalog.ts — this is imported by the browser picker AND the server).

/**
 * How a style distributes time across its photos. Every profile is
 * deterministic — the same photo count and style always produce the same
 * cut pattern, so a montage can be reasoned about and reproduced.
 *
 * - "wave": breathes in and out. Elegant rather than driving.
 * - "accelerate": opens wide, tightens shot by shot, then lands on a hold.
 * - "alternating": long/short/long/short. Playful, deliberately uneven.
 * - "steady-closer": even throughout, with a longer final beat.
 */
export type PacingProfile = "wave" | "accelerate" | "alternating" | "steady-closer";

export interface MontageStyle {
  id: string;
  name: string;
  description: string;
  /**
   * AVERAGE seconds each photo is on screen. Individual photos run longer
   * or shorter than this (see photoDurations) — this is the value the
   * pattern is normalised around, not a literal per-photo duration.
   */
  secondsPerPhoto: number;
  /**
   * How the photo is fit to the 9:16 frame.
   * - "blurred": whole photo visible, blurred copy of itself fills the sides.
   *   This is what Reels/TikTok actually do, and it's the only mode that
   *   can't cut someone's head off.
   * - "fill": center-crop to fill the frame. Punchier, but crops hard —
   *   only safe when the subject is centered.
   */
  fit: "blurred" | "fill";
  /** Camera move applied across the photo's time on screen. */
  motion: "zoom-in" | "zoom-out" | "pan-right" | "alternate" | "none";
  /**
   * How far the camera actually travels, as a fraction of the frame.
   * 0.18 = an 18% push. For "pan-right" this is horizontal travel instead.
   *
   * This is a DESTINATION, not a ceiling: lib/video.ts derives the
   * per-frame step from this and the segment's real frame count, so the
   * move completes exactly as the photo leaves the screen. The previous
   * code used a fixed per-frame step against a cap it could never reach,
   * which is why the motion was invisible (~7% instead of the stated 14%).
   *
   * Ignored when motion is "none".
   */
  motionMagnitude: number;
  /** Transition into the next photo. Falls back to a hard cut on old ffmpeg. */
  transition: "fade" | "slideleft" | "smoothleft" | "circleopen" | "cut";
  /** Transition duration in seconds. */
  transitionSeconds: number;
  /** How time is distributed across the photos. */
  pacing: PacingProfile;
}

export const MONTAGE_STYLES: MontageStyle[] = [
  {
    id: "cinematic",
    name: "Cinematic",
    description: "Slow push in, soft crossfades. Wedding and elegant events.",
    secondsPerPhoto: 3.2,
    fit: "blurred",
    motion: "zoom-in",
    motionMagnitude: 0.18,
    transition: "fade",
    transitionSeconds: 0.7,
    pacing: "wave",
  },
  {
    id: "punchy",
    name: "Punchy",
    description: "Fast cuts with snap zooms. Reads as native TikTok.",
    secondsPerPhoto: 1.4,
    fit: "fill",
    motion: "alternate",
    motionMagnitude: 0.3,
    transition: "cut",
    transitionSeconds: 0,
    pacing: "accelerate",
  },
  {
    id: "smooth-slide",
    name: "Smooth Slide",
    description: "Photos glide in from the side. Clean and modern.",
    secondsPerPhoto: 2.4,
    fit: "blurred",
    motion: "pan-right",
    motionMagnitude: 0.2,
    transition: "smoothleft",
    transitionSeconds: 0.5,
    pacing: "steady-closer",
  },
  {
    id: "reveal",
    name: "Reveal",
    description: "Circular open between shots. Playful, good for birthdays.",
    secondsPerPhoto: 2.2,
    fit: "blurred",
    motion: "zoom-out",
    motionMagnitude: 0.22,
    transition: "circleopen",
    transitionSeconds: 0.6,
    pacing: "alternating",
  },
  {
    id: "classic",
    name: "Classic",
    description: "Steady hold, simple crossfade. Lets the photos speak.",
    secondsPerPhoto: 2.8,
    fit: "blurred",
    // Deliberately motionless — this style exists for clients who want the
    // photograph presented, not performed. Don't "fix" this.
    motion: "none",
    motionMagnitude: 0,
    transition: "fade",
    transitionSeconds: 0.5,
    pacing: "steady-closer",
  },
];

export const DEFAULT_MONTAGE_STYLE = "cinematic";

export function getMontageStyle(id: string | null | undefined): MontageStyle {
  return MONTAGE_STYLES.find((s) => s.id === id) ?? MONTAGE_STYLES[0];
}

// Which style suits an event type when the client hasn't picked one.
export function suggestStyleForEventType(eventType: string): MontageStyle {
  switch (eventType) {
    case "wedding":
      return getMontageStyle("cinematic");
    case "birthday":
      return getMontageStyle("reveal");
    case "corporate":
      return getMontageStyle("smooth-slide");
    default:
      return getMontageStyle("cinematic");
  }
}

/** Raw, un-normalised time multipliers for a profile. Mean is fixed up later. */
function pacingMultipliers(count: number, profile: PacingProfile): number[] {
  const out: number[] = [];

  for (let i = 0; i < count; i++) {
    switch (profile) {
      case "accelerate": {
        // Opens wide and tightens shot by shot. `count - 1` guard keeps a
        // single-photo montage from dividing by zero.
        const t = count > 1 ? i / (count - 1) : 0;
        out.push(1.45 - t * 0.85);
        break;
      }
      case "wave": {
        // A repeating 4-beat breath, so it reads as phrasing rather than
        // random. Starts slightly long to let the opening shot land.
        const cycle = [1.15, 0.85, 0.95, 1.05];
        out.push(i === 0 ? 1.2 : cycle[i % cycle.length]);
        break;
      }
      case "alternating":
        out.push(i % 2 === 0 ? 1.3 : 0.8);
        break;
      case "steady-closer":
        out.push(1);
        break;
    }
  }

  // Hold the last shot longer in every profile. Short-form videos are judged
  // on how they end — that final frame is what plays as the loop restarts,
  // and cutting away from it at speed reads as the video running out rather
  // than finishing.
  if (count > 1) {
    out[count - 1] = profile === "accelerate" ? 1.5 : profile === "alternating" ? 1.4 : 1.35;
  }

  return out;
}

/**
 * Per-photo screen time, in display order.
 *
 * Replaces one constant applied to every photo. Even spacing is what made
 * the output read as a slideshow: an 8-photo cinematic montage cut at
 * exactly 3.2s, 6.4s, 9.6s... which is a metronome, not an edit.
 *
 * Multipliers are normalised to a mean of 1.0, so total runtime stays close
 * to count * secondsPerPhoto and render cost doesn't jump.
 */
export function photoDurations(count: number, style: MontageStyle): number[] {
  if (count <= 0) return [];
  if (count === 1) return [style.secondsPerPhoto];

  const raw = pacingMultipliers(count, style.pacing);
  const sum = raw.reduce((a, b) => a + b, 0);
  // Normalise so the pattern redistributes time rather than adding it.
  const scale = count / sum;

  // A cross-fade cannot be longer than the segments it joins — ffmpeg's
  // xfade fails outright, and the whole montage would drop to hard cuts.
  // Pacing must never push a segment below its own transition, so this
  // floor is a correctness bound, not a taste one.
  const floor = Math.max(0.8, style.transitionSeconds + 0.35);
  const ceiling = style.secondsPerPhoto * 1.8;

  return raw.map((m) => {
    const seconds = style.secondsPerPhoto * m * scale;
    return Math.round(Math.min(ceiling, Math.max(floor, seconds)) * 1000) / 1000;
  });
}
