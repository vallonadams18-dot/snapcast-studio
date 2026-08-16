"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MUSIC_CATALOG } from "@/lib/musicCatalog";

export function MusicPicker({ mediaId, currentTrackId }: { mediaId: string; currentTrackId: string | null }) {
  const router = useRouter();
  const [trackId, setTrackId] = useState(currentTrackId ?? MUSIC_CATALOG[0].id);
  const [open, setOpen] = useState(false);
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
      // If a licensed library is connected, the swap re-mixes real audio
      // into the clip and changes its video URL — refresh to pick that up.
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const current = MUSIC_CATALOG.find((t) => t.id === trackId) ?? MUSIC_CATALOG[0];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={saving}
        className="tap-scale flex min-h-11 w-full items-center justify-center truncate rounded-lg bg-black/70 px-1.5 text-[10px] font-medium text-white disabled:opacity-70"
      >
        {saving ? "Mixing licensed audio…" : `🎵 ${current.name} · tap to swap`}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-40 rounded-lg border border-border bg-surface p-1 shadow-2xl">
          {MUSIC_CATALOG.map((t) => (
            <button
              key={t.id}
              onClick={() => pick(t.id)}
              className={`tap-scale block min-h-11 w-full rounded-lg px-2 py-1.5 text-left text-[11px] ${
                t.id === trackId ? "bg-primary-pink/10 text-primary-pink" : "text-foreground hover:bg-background"
              }`}
            >
              {t.name}
              <span className="block text-[9px] text-neutral-500">{t.mood}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
