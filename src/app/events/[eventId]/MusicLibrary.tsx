"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input } from "@/components/ui";

type LibraryTrack = {
  id: string;
  title: string;
  artist: string;
  bpm: number | null;
  lengthSeconds: number;
  moods: string[];
  genres: string[];
  waveformUrl: string | null;
};

type SavedTrack = { trackId: string; title: string; artist: string | null };

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Epidemic's waveform JSON is interleaved min/max pairs of 8-bit samples.
// Collapse each pair to a single 0..1 magnitude so we can draw one bar per
// pixel column regardless of how many samples the track actually has.
function normalizeWaveform(data: number[], buckets: number): number[] {
  const pairs = Math.floor(data.length / 2);
  if (pairs === 0) return [];
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * pairs) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * pairs) / buckets));
    let peak = 0;
    for (let i = start; i < end && i < pairs; i++) {
      peak = Math.max(peak, Math.abs(data[i * 2]), Math.abs(data[i * 2 + 1]));
    }
    out.push(Math.min(1, peak / 128));
  }
  return out;
}

export function MusicLibrary({
  mediaId,
  clipDurationSeconds,
  currentTrackTitle,
  onClose,
  onApplied,
}: {
  mediaId: string;
  clipDurationSeconds: number;
  currentTrackTitle: string | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [saved, setSaved] = useState<SavedTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<LibraryTrack | null>(null);
  const [startSeconds, setStartSeconds] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSavedOnly, setShowSavedOnly] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const search = useCallback(async (term: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/music/search?q=${encodeURIComponent(term)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Search failed.");
      setTracks(body.tracks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    search("event celebration");
    fetch("/api/music/saved")
      .then((r) => r.json())
      .then((b) => setSaved(b.saved ?? []))
      .catch(() => {});
  }, [search]);

  // Stop audio when the sheet closes — otherwise the preview keeps playing
  // over the rest of the app.
  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      audio?.pause();
    };
  }, []);

  async function loadWaveform(track: LibraryTrack) {
    setPeaks([]);
    if (!track.waveformUrl) return;
    try {
      const res = await fetch(`/api/music/waveform?url=${encodeURIComponent(track.waveformUrl)}`);
      if (!res.ok) return;
      const json = (await res.json()) as { data: number[] };
      setPeaks(normalizeWaveform(json.data ?? [], 120));
    } catch {
      // Waveform is a nicety — the start slider still works without it.
    }
  }

  function pickTrack(track: LibraryTrack) {
    setSelected(track);
    setStartSeconds(0);
    loadWaveform(track);
  }

  function togglePreview(track: LibraryTrack, fromSeconds = 0) {
    if (!audioRef.current) return;
    const audio = audioRef.current;

    if (playingId === track.id && !audio.paused) {
      audio.pause();
      setPlayingId(null);
      return;
    }

    audio.src = `/api/music/${track.id}/preview`;
    audio.currentTime = 0;
    setPlayingId(track.id);
    audio
      .play()
      .then(() => {
        // Seeking before metadata loads is ignored, so jump once it's ready.
        if (fromSeconds > 0) {
          const seek = () => {
            audio.currentTime = fromSeconds;
            audio.removeEventListener("loadedmetadata", seek);
          };
          audio.addEventListener("loadedmetadata", seek);
        }
      })
      .catch(() => {
        setPlayingId(null);
        setError("Couldn't play a preview of that track.");
      });
  }

  async function toggleSaved(track: LibraryTrack) {
    const isSaved = saved.some((s) => s.trackId === track.id);
    setSaved((prev) =>
      isSaved
        ? prev.filter((s) => s.trackId !== track.id)
        : [...prev, { trackId: track.id, title: track.title, artist: track.artist }],
    );
    await fetch("/api/music/saved", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trackId: track.id,
        saved: !isSaved,
        title: track.title,
        artist: track.artist,
        lengthSeconds: track.lengthSeconds,
        waveformUrl: track.waveformUrl,
      }),
    }).catch(() => {});
  }

  async function apply() {
    if (!selected) return;
    setApplying(true);
    setError(null);
    audioRef.current?.pause();
    setPlayingId(null);
    try {
      const res = await fetch(`/api/media/${mediaId}/music`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          libraryTrackId: selected.id,
          libraryTrackTitle: `${selected.title} — ${selected.artist}`,
          startSeconds,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't apply that track.");
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply that track.");
      setApplying(false);
    }
  }

  const visible = showSavedOnly ? tracks.filter((t) => saved.some((s) => s.trackId === t.id)) : tracks;
  const maxStart = selected ? Math.max(0, selected.lengthSeconds - clipDurationSeconds) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-t-xl border border-border bg-surface sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <audio ref={audioRef} onEnded={() => setPlayingId(null)} className="hidden" />

        <div className="border-b border-border p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">Choose music</p>
            <button onClick={onClose} className="tap-scale min-h-11 px-2 text-xs text-neutral-500">
              Close
            </button>
          </div>
          {currentTrackTitle && (
            <p className="mt-1 text-[11px] text-neutral-500">Currently: {currentTrackTitle}</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              search(query);
            }}
            className="mt-3 flex gap-2"
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search — e.g. upbeat wedding, chill hip hop"
              className="flex-1 text-sm"
            />
            <Button type="submit" disabled={loading} className="min-h-11 whitespace-nowrap">
              {loading ? "…" : "Search"}
            </Button>
          </form>
          <button
            onClick={() => setShowSavedOnly((v) => !v)}
            className={`tap-scale mt-2 min-h-11 rounded-lg px-3 text-xs ${
              showSavedOnly ? "bg-primary-pink/10 text-primary-pink" : "text-neutral-500"
            }`}
          >
            ♥ Saved only ({saved.length})
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {visible.length === 0 && !loading && (
            <p className="p-4 text-center text-sm text-neutral-500">
              {showSavedOnly ? "No saved tracks yet — tap ♥ on a track to save it." : "No tracks found. Try another search."}
            </p>
          )}
          {visible.map((track) => {
            const isSelected = selected?.id === track.id;
            const isSaved = saved.some((s) => s.trackId === track.id);
            return (
              <div
                key={track.id}
                className={`mb-1 rounded-lg border p-2 ${
                  isSelected ? "border-primary-pink bg-primary-pink/5" : "border-transparent hover:bg-background"
                }`}
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => togglePreview(track)}
                    className="tap-scale flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-primary-purple to-primary-pink text-sm text-white"
                    aria-label={playingId === track.id ? "Pause" : "Play"}
                  >
                    {playingId === track.id ? "❚❚" : "▶"}
                  </button>
                  <button onClick={() => pickTrack(track)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium text-foreground">{track.title}</span>
                    <span className="block truncate text-[11px] text-neutral-500">
                      {track.artist} · {formatTime(track.lengthSeconds)}
                      {track.bpm ? ` · ${track.bpm} BPM` : ""}
                      {track.moods.length > 0 ? ` · ${track.moods.slice(0, 2).join(", ")}` : ""}
                    </span>
                  </button>
                  <button
                    onClick={() => toggleSaved(track)}
                    className={`tap-scale h-11 w-11 shrink-0 text-lg ${isSaved ? "text-primary-pink" : "text-neutral-600"}`}
                    aria-label={isSaved ? "Remove from saved" : "Save track"}
                  >
                    {isSaved ? "♥" : "♡"}
                  </button>
                </div>

                {isSelected && (
                  <div className="mt-2 border-t border-border pt-2">
                    <p className="mb-1 text-[11px] text-neutral-500">
                      Pick where the music starts — drag to find the part you want.
                    </p>

                    {peaks.length > 0 && (
                      <div className="relative mb-1 flex h-12 items-center gap-px overflow-hidden rounded-lg bg-background px-1">
                        {peaks.map((p, i) => {
                          const posSeconds = (i / peaks.length) * track.lengthSeconds;
                          const inWindow =
                            posSeconds >= startSeconds && posSeconds <= startSeconds + clipDurationSeconds;
                          return (
                            <span
                              key={i}
                              className={`flex-1 rounded-sm ${inWindow ? "bg-primary-pink" : "bg-neutral-700"}`}
                              style={{ height: `${Math.max(6, p * 100)}%` }}
                            />
                          );
                        })}
                      </div>
                    )}

                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, Math.floor(maxStart))}
                      value={Math.min(startSeconds, maxStart)}
                      onChange={(e) => setStartSeconds(Number(e.target.value))}
                      className="w-full accent-primary-pink"
                    />
                    <div className="flex items-center justify-between text-[11px] text-neutral-500">
                      <span>
                        {formatTime(startSeconds)} – {formatTime(startSeconds + clipDurationSeconds)}
                      </span>
                      <button
                        onClick={() => togglePreview(track, startSeconds)}
                        className="tap-scale min-h-11 underline"
                      >
                        Preview from here
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-border p-4">
          {error && <p className="mb-2 text-xs text-error">{error}</p>}
          <Button onClick={apply} disabled={!selected || applying} className="min-h-11 w-full">
            {applying
              ? "Mixing into your video…"
              : selected
                ? `Use "${selected.title}"`
                : "Pick a track above"}
          </Button>
        </div>
      </div>
    </div>
  );
}
