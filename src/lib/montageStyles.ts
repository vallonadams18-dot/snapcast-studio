// Client-safe: plain data only, no Node built-ins (same rule as
// musicCatalog.ts — this is imported by the browser picker AND the server).

export interface MontageStyle {
  id: string;
  name: string;
  description: string;
  /** Seconds each photo is on screen. Shorter = punchier. */
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
  /** Transition into the next photo. Falls back to a hard cut on old ffmpeg. */
  transition: "fade" | "slideleft" | "smoothleft" | "circleopen" | "cut";
  /** Transition duration in seconds. */
  transitionSeconds: number;
}

export const MONTAGE_STYLES: MontageStyle[] = [
  {
    id: "cinematic",
    name: "Cinematic",
    description: "Slow push in, soft crossfades. Wedding and elegant events.",
    secondsPerPhoto: 3.2,
    fit: "blurred",
    motion: "zoom-in",
    transition: "fade",
    transitionSeconds: 0.7,
  },
  {
    id: "punchy",
    name: "Punchy",
    description: "Fast cuts with snap zooms. Reads as native TikTok.",
    secondsPerPhoto: 1.4,
    fit: "fill",
    motion: "alternate",
    transition: "cut",
    transitionSeconds: 0,
  },
  {
    id: "smooth-slide",
    name: "Smooth Slide",
    description: "Photos glide in from the side. Clean and modern.",
    secondsPerPhoto: 2.4,
    fit: "blurred",
    motion: "pan-right",
    transition: "smoothleft",
    transitionSeconds: 0.5,
  },
  {
    id: "reveal",
    name: "Reveal",
    description: "Circular open between shots. Playful, good for birthdays.",
    secondsPerPhoto: 2.2,
    fit: "blurred",
    motion: "zoom-out",
    transition: "circleopen",
    transitionSeconds: 0.6,
  },
  {
    id: "classic",
    name: "Classic",
    description: "Steady hold, simple crossfade. Lets the photos speak.",
    secondsPerPhoto: 2.8,
    fit: "blurred",
    motion: "none",
    transition: "fade",
    transitionSeconds: 0.5,
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
