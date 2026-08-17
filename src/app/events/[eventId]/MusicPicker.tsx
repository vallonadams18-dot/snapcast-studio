"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MUSIC_CATALOG } from "@/lib/musicCatalog";
import { MusicLibrary } from "./MusicLibrary";

export function MusicPicker({
  mediaId,
  currentTrackId,
  currentTrackTitle,
  clipDurationSeconds,
}: {
  mediaId: string;
  currentTrackId: string | null;
  currentTrackTitle: string | null;
  clipDurationSeconds: number;
}) {
  const router = useRouter();
  const [trackId, setTrackId] = useState(currentTrackId ?? MUSIC_CATALOG[0].id);
  const [open, setOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  async function pick(id: string) {
    setSaving(true);
    setTrackId(id);
    setOpen(false);
    try {
      await fetch(`/api/media/${mediaId}/music`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId: id }),
      });
      // The swap re-mixes real audio and changes the video URL — refresh so
      // the player picks up the new file rather than the cached old one.
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const current = MUSIC_CATALOG.find((t) => t.id === trackId) ?? MUSIC_CATALOG[0];
  // A specific library pick wins over the broad category label.
  const label = currentTrackTitle ?? current.name;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={saving}
        className="tap-scale flex min-h-11 w-full items-center justify-center truncate rounded-lg bg-black/70 px-1.5 text-[10px] font-medium text-white disabled:opacity-70"
      >
        {saving ? "Mixing licensed audio…" : `🎵 ${label} · tap to swap`}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-44 rounded-lg border border-border bg-surface p-1 shadow-2xl">
          <button
            onClick={() => {
              setOpen(false);
              setLibraryOpen(true);
            }}
            className="tap-scale mb-1 block min-h-11 w-full rounded-lg bg-gradient-to-r from-primary-purple to-primary-pink px-2 py-1.5 text-left text-[11px] font-semibold text-white"
          >
            Browse music library
            <span className="block text-[9px] font-normal opacity-90">Search, preview, pick your start point</span>
          </button>
          <p className="px-2 pb-1 pt-1 text-[9px] uppercase tracking-wide text-neutral-500">Quick picks</p>
          {MUSIC_CATALOG.map((t) => (
            <button
              key={t.id}
              onClick={() => pick(t.id)}
              className={`tap-scale block min-h-11 w-full rounded-lg px-2 py-1.5 text-left text-[11px] ${
                t.id === trackId && !currentTrackTitle
                  ? "bg-primary-pink/10 text-primary-pink"
                  : "text-foreground hover:bg-background"
              }`}
            >
              {t.name}
              <span className="block text-[9px] text-neutral-500">{t.mood}</span>
            </button>
          ))}
        </div>
      )}

      {libraryOpen && (
        <MusicLibrary
          mediaId={mediaId}
          clipDurationSeconds={clipDurationSeconds}
          currentTrackTitle={currentTrackTitle}
          onClose={() => setLibraryOpen(false)}
          onApplied={() => router.refresh()}
        />
      )}
    </div>
  );
}
