// Client-safe: plain data only, no Node built-ins. Imported by both the
// browser (MusicPicker) and the server (lib/music.ts). Keep it that way —
// anything requiring node:child_process or fetch-to-a-secret-API-key
// belongs in lib/music.ts instead, or this file becomes unbundleable for
// client components that import it.
export interface MusicTrack {
  id: string;
  name: string;
  mood: string;
  // "wedding" | "corporate" | "birthday" | "other" — which event types this suits by default.
  eventTypes: string[];
}

export const MUSIC_CATALOG: MusicTrack[] = [
  { id: "upbeat-pop", name: "Bright Horizon", mood: "Upbeat Pop", eventTypes: ["birthday", "other"] },
  { id: "emotional-piano", name: "Golden Hour", mood: "Emotional Piano", eventTypes: ["wedding"] },
  { id: "warm-acoustic", name: "First Dance", mood: "Warm Acoustic", eventTypes: ["wedding"] },
  { id: "corporate-clean", name: "Forward Motion", mood: "Clean Corporate", eventTypes: ["corporate"] },
  { id: "high-energy-edm", name: "Night Pulse", mood: "High-Energy EDM", eventTypes: ["birthday", "other"] },
  { id: "feel-good-indie", name: "Sunlit Room", mood: "Feel-Good Indie", eventTypes: ["birthday", "corporate", "other"] },
];

export function suggestTrackForEventType(eventType: string): MusicTrack {
  const match = MUSIC_CATALOG.find((t) => t.eventTypes.includes(eventType));
  return match ?? MUSIC_CATALOG[0];
}

export function getTrackById(id: string): MusicTrack | undefined {
  return MUSIC_CATALOG.find((t) => t.id === id);
}
