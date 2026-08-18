// Client-safe: plain data only, no Node built-ins (same rule as
// musicCatalog.ts — this is imported by the browser picker AND the server).
//
// PRESETS, not just parameter sets. Each entry is a complete visual
// language: a motion vocabulary, an easing family, a curated transition
// pool, a colour grade, and role-specific treatments for the opener, the
// peak and the hero. Cohesion comes from what a preset FORBIDS — one grade,
// one easing family, two or three transitions — which is what separates
// art direction from random transition soup.

export type PacingProfile = "wave" | "accelerate" | "alternating" | "steady-closer";

/** How motion progresses over a segment's frames. */
export type MotionEasing = "linear" | "ease-out" | "ease-in-out" | "punch" | "settle";

/** Concrete camera moves the renderer can execute. */
export type MotionKind =
  | "push-in"
  | "pull-out"
  | "pan-left"
  | "pan-right"
  | "pan-up"
  | "pan-down"
  | "zoom-punch"
  | "none";

export interface RoleTreatment {
  motion: MotionKind;
  magnitude: number;
  easing: MotionEasing;
}

/** One join between two segments. */
export interface TransitionSpec {
  /** xfade transition name, or "cut". Restricted to the ffmpeg 4.3 set. */
  kind: string;
  seconds: number;
}

export interface MontageStyle {
  id: string;
  name: string;
  description: string;
  /** AVERAGE seconds per photo — pacing profiles vary around this. */
  secondsPerPhoto: number;
  fit: "blurred" | "fill";
  pacing: PacingProfile;

  /** Default easing family for build/variety segments. */
  easing: MotionEasing;
  /**
   * Moves cycled through the build/variety middle, in order, starting at a
   * seeded offset. Systematic alternation, never random draws.
   */
  motionVocabulary: RoleTreatment[];
  opener: RoleTreatment;
  peak: RoleTreatment;
  /** Hero uses "settle" easing: motion completes early, final frame rests. */
  hero: RoleTreatment;

  /**
   * Two-layer parallax rates for blurred-fit: the foreground photo moves at
   * the role's magnitude while the blurred backdrop moves at bgMagnitude.
   * The rate DIFFERENCE is the depth cue. 0 = single-layer composite.
   */
  bgMagnitude: number;
  /** Party only: slow rotation drift across the segment, degrees. */
  rotateDriftDegrees: number;

  /** The join used for most cuts. */
  baseTransition: TransitionSpec;
  /** The decorated join, permitted ONLY entering peak and entering hero. */
  signatureTransition: TransitionSpec;
  /** Accent flashes (fadewhite into a segment). Hard budget per video. */
  accentBudget: number;

  /** One grade for the whole video — uniformity is the art direction. */
  look: { saturation: number; contrast: number; vignette: number; grain: number };
}

/** Longest join a plan may assign — the xfade-safety floor derives from it. */
export function maxTransitionSeconds(style: MontageStyle): number {
  return Math.max(style.baseTransition.seconds, style.signatureTransition.seconds);
}

export const MONTAGE_STYLES: MontageStyle[] = [
  {
    id: "auto",
    name: "AI Auto",
    description: "Snapcast reads the music and photos and picks the best-fitting style.",
    // Placeholder pacing values so duration estimators work before the
    // real preset is chosen; never used for rendering — the route resolves
    // "auto" to a concrete preset before any plan is built.
    secondsPerPhoto: 2.8,
    fit: "blurred",
    pacing: "wave",
    easing: "ease-out",
    motionVocabulary: [{ motion: "push-in", magnitude: 0.18, easing: "ease-out" }],
    opener: { motion: "push-in", magnitude: 0.2, easing: "ease-out" },
    peak: { motion: "push-in", magnitude: 0.24, easing: "ease-out" },
    hero: { motion: "push-in", magnitude: 0.16, easing: "settle" },
    bgMagnitude: 0.08,
    rotateDriftDegrees: 0,
    baseTransition: { kind: "fade", seconds: 0.6 },
    signatureTransition: { kind: "circleopen", seconds: 0.6 },
    accentBudget: 1,
    look: { saturation: 1.06, contrast: 1.05, vignette: 0.2, grain: 0.03 },
  },
  {
    id: "cinematic",
    name: "Cinematic",
    description: "Slow eased push-ins with real depth. Weddings and elegant events.",
    secondsPerPhoto: 3.2,
    fit: "blurred",
    pacing: "wave",
    easing: "ease-out",
    motionVocabulary: [
      { motion: "push-in", magnitude: 0.2, easing: "ease-out" },
      { motion: "pull-out", magnitude: 0.18, easing: "ease-out" },
      { motion: "pan-right", magnitude: 0.16, easing: "ease-in-out" },
      { motion: "push-in", magnitude: 0.22, easing: "ease-out" },
      { motion: "pan-left", magnitude: 0.16, easing: "ease-in-out" },
    ],
    opener: { motion: "push-in", magnitude: 0.24, easing: "ease-out" },
    peak: { motion: "push-in", magnitude: 0.28, easing: "ease-in-out" },
    hero: { motion: "push-in", magnitude: 0.18, easing: "settle" },
    bgMagnitude: 0.08,
    rotateDriftDegrees: 0,
    baseTransition: { kind: "fade", seconds: 0.7 },
    signatureTransition: { kind: "circleopen", seconds: 0.7 },
    accentBudget: 0,
    look: { saturation: 1.05, contrast: 1.06, vignette: 0.25, grain: 0.04 },
  },
  {
    id: "hype",
    name: "Hype",
    description: "Fast cuts, zoom punches, a flash on the drop. Reads as native TikTok.",
    secondsPerPhoto: 1.4,
    fit: "fill",
    pacing: "accelerate",
    easing: "punch",
    motionVocabulary: [
      { motion: "zoom-punch", magnitude: 0.3, easing: "punch" },
      { motion: "pull-out", magnitude: 0.26, easing: "ease-out" },
      { motion: "pan-right", magnitude: 0.22, easing: "ease-out" },
      { motion: "zoom-punch", magnitude: 0.32, easing: "punch" },
      { motion: "pan-left", magnitude: 0.22, easing: "ease-out" },
    ],
    opener: { motion: "zoom-punch", magnitude: 0.32, easing: "punch" },
    peak: { motion: "zoom-punch", magnitude: 0.36, easing: "punch" },
    hero: { motion: "push-in", magnitude: 0.2, easing: "settle" },
    bgMagnitude: 0,
    rotateDriftDegrees: 0,
    baseTransition: { kind: "cut", seconds: 0 },
    signatureTransition: { kind: "slideleft", seconds: 0.15 },
    accentBudget: 2,
    look: { saturation: 1.18, contrast: 1.12, vignette: 0.1, grain: 0.02 },
  },
  {
    id: "luxury",
    name: "Clean Luxury",
    description: "Near-still frames, long fades, restrained and premium.",
    secondsPerPhoto: 3.0,
    fit: "blurred",
    pacing: "steady-closer",
    easing: "ease-in-out",
    motionVocabulary: [
      { motion: "push-in", magnitude: 0.07, easing: "ease-in-out" },
      { motion: "pull-out", magnitude: 0.06, easing: "ease-in-out" },
      { motion: "pan-up", magnitude: 0.06, easing: "ease-in-out" },
    ],
    opener: { motion: "pull-out", magnitude: 0.08, easing: "ease-in-out" },
    peak: { motion: "push-in", magnitude: 0.1, easing: "ease-in-out" },
    hero: { motion: "push-in", magnitude: 0.07, easing: "settle" },
    bgMagnitude: 0.03,
    rotateDriftDegrees: 0,
    baseTransition: { kind: "fade", seconds: 0.9 },
    signatureTransition: { kind: "fadeblack", seconds: 0.9 },
    accentBudget: 0,
    look: { saturation: 0.95, contrast: 1.06, vignette: 0.3, grain: 0.01 },
  },
  {
    id: "party",
    name: "Fun Party",
    description: "Playful motion, a little spin, bright and celebratory.",
    secondsPerPhoto: 2.0,
    fit: "blurred",
    pacing: "alternating",
    easing: "ease-out",
    motionVocabulary: [
      { motion: "zoom-punch", magnitude: 0.26, easing: "punch" },
      { motion: "pan-up", magnitude: 0.2, easing: "ease-out" },
      { motion: "pull-out", magnitude: 0.22, easing: "ease-out" },
      { motion: "pan-down", magnitude: 0.2, easing: "ease-out" },
    ],
    opener: { motion: "zoom-punch", magnitude: 0.28, easing: "punch" },
    peak: { motion: "zoom-punch", magnitude: 0.32, easing: "punch" },
    hero: { motion: "push-in", magnitude: 0.18, easing: "settle" },
    bgMagnitude: 0.07,
    rotateDriftDegrees: 2.5,
    baseTransition: { kind: "slideleft", seconds: 0.3 },
    signatureTransition: { kind: "circleopen", seconds: 0.45 },
    accentBudget: 2,
    look: { saturation: 1.22, contrast: 1.08, vignette: 0.12, grain: 0.02 },
  },
];

export const DEFAULT_MONTAGE_STYLE = "auto";

/** Pre-2D style ids map to their nearest preset so old links keep working. */
const LEGACY_IDS: Record<string, string> = {
  punchy: "hype",
  "smooth-slide": "luxury",
  reveal: "party",
  classic: "luxury",
};

export function getMontageStyle(id: string | null | undefined): MontageStyle {
  const resolved = id && LEGACY_IDS[id] ? LEGACY_IDS[id] : id;
  return MONTAGE_STYLES.find((s) => s.id === resolved) ?? MONTAGE_STYLES.find((s) => s.id === "cinematic")!;
}

// Which preset suits an event type when the client hasn't picked one.
export function suggestStyleForEventType(eventType: string): MontageStyle {
  switch (eventType) {
    case "wedding":
      return getMontageStyle("cinematic");
    case "birthday":
      return getMontageStyle("party");
    case "corporate":
      return getMontageStyle("luxury");
    default:
      return getMontageStyle("auto");
  }
}

export interface AutoPresetSignals {
  eventType: string;
  bpm: number | null;
  /** 0..1 fraction into the section where the music peaks, if analysed. */
  energyPeakFraction: number | null;
  photoCount: number;
  /** Spread of the photos' AI scores — a flat set reads staged/posed. */
  scoreVariance: number;
}

/**
 * AI Auto: ONE coherent preset chosen from the signals the pipeline already
 * produced — event type, the resolved track's BPM, the waveform's energy
 * shape, and the photo set itself. A rules engine over AI-derived data, and
 * deliberately so: it must never blend visual languages, only pick one.
 */
export function chooseAutoPreset(signals: AutoPresetSignals): { style: MontageStyle; reason: string } {
  const { eventType, bpm, photoCount } = signals;

  if (eventType === "wedding") {
    return { style: getMontageStyle("cinematic"), reason: "wedding event — cinematic treatment" };
  }
  if (eventType === "corporate") {
    return { style: getMontageStyle("luxury"), reason: "corporate event — clean, restrained treatment" };
  }
  // Event type outranks tempo — a 130 BPM birthday is still a birthday, the
  // same way wedding and corporate override the track above.
  if (eventType === "birthday") {
    return { style: getMontageStyle("party"), reason: "birthday event — playful treatment" };
  }
  if (bpm !== null && bpm >= 118) {
    return { style: getMontageStyle("hype"), reason: `fast track (${bpm} BPM) — high-energy treatment` };
  }
  if (bpm !== null && bpm >= 100) {
    return {
      style: getMontageStyle("party"),
      reason: bpm !== null ? `upbeat track (${bpm} BPM) — playful treatment` : "birthday event — playful treatment",
    };
  }
  if (photoCount <= 3) {
    // Few photos = long holds; restraint wears better than energy.
    return { style: getMontageStyle("luxury"), reason: `only ${photoCount} photos — long, premium holds` };
  }
  return { style: getMontageStyle("cinematic"), reason: "default — cinematic wears best across content" };
}

/** Raw, un-normalised time multipliers for a profile. Mean is fixed up later. */
function pacingMultipliers(count: number, profile: PacingProfile): number[] {
  const out: number[] = [];

  for (let i = 0; i < count; i++) {
    switch (profile) {
      case "accelerate": {
        const t = count > 1 ? i / (count - 1) : 0;
        out.push(1.45 - t * 0.85);
        break;
      }
      case "wave": {
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

  // Hold the last shot longer in every profile: the final frame is what a
  // looping social video rests on.
  if (count > 1) {
    out[count - 1] = profile === "accelerate" ? 1.5 : profile === "alternating" ? 1.4 : 1.35;
  }

  return out;
}

/**
 * Per-photo screen time, in display order. Normalised to a mean of 1.0 so
 * the pattern redistributes time rather than adding it.
 */
export function photoDurations(count: number, style: MontageStyle): number[] {
  if (count <= 0) return [];
  if (count === 1) return [style.secondsPerPhoto];

  const raw = pacingMultipliers(count, style.pacing);
  const sum = raw.reduce((a, b) => a + b, 0);
  const scale = count / sum;

  // A cross-fade cannot outlast the segments it joins — floor derives from
  // the LONGEST join this preset can assign (signature, not just base).
  const floor = Math.max(0.8, maxTransitionSeconds(style) + 0.35);
  const ceiling = style.secondsPerPhoto * 1.8;

  return raw.map((m) => {
    const seconds = style.secondsPerPhoto * m * scale;
    return Math.round(Math.min(ceiling, Math.max(floor, seconds)) * 1000) / 1000;
  });
}
