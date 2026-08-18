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
  hasVocals: boolean;
  vocalType: string | null;
  imageUrl: string | null;
  isExplicit: boolean;
};

type Facet = { id: string; name: string; count: number };
type SavedTrack = { trackId: string; title: string; artist: string | null };
type VocalMode = "any" | "vocals" | "instrumental";

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

const QUICK_SEARCHES = ["party", "wedding", "hip hop", "R&B", "dance", "luxury", "romantic", "upbeat"];

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
  /**
   * Receives what the server actually did, so the caller can refresh the
   * player in place and report honestly — `mixed: false` means the track
   * choice was recorded but the audio was left alone.
   */
  onApplied: (result: { sourceUrl: string; musicTrackTitle: string | null; mixed: boolean }) => void;
}) {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [moodFacets, setMoodFacets] = useState<Facet[]>([]);
  const [genreFacets, setGenreFacets] = useState<Facet[]>([]);
  const [mood, setMood] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | null>(null);
  const [vocals, setVocals] = useState<VocalMode>("any");
  const [saved, setSaved] = useState<SavedTrack[]>([]);
  // Starts true: the sheet kicks off a search on mount, so rendering
  // "not loading" for the first frame would flash an empty-results message.
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<LibraryTrack | null>(null);
  const [startSeconds, setStartSeconds] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSavedOnly, setShowSavedOnly] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopAtRef = useRef<number | null>(null);

  const runSearch = useCallback(
    async (term: string, opts: { mood?: string | null; genre?: string | null; vocals?: VocalMode } = {}) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ q: term });
      if (opts.mood) params.set("mood", opts.mood);
      if (opts.genre) params.set("genre", opts.genre);
      if (opts.vocals && opts.vocals !== "any") params.set("vocals", opts.vocals);
      try {
        const res = await fetch(`/api/music/search?${params}`);
        const body = await res.json().catch(() => ({}));
        // The route now returns the real reason instead of an empty list, so
        // an expired key no longer reads as "no matches".
        if (!res.ok) throw new Error(body.error ?? "Search failed.");
        setTracks(body.tracks ?? []);
        if (body.moods?.length) setMoodFacets(body.moods);
        if (body.genres?.length) setGenreFacets(body.genres);
      } catch (err) {
        setTracks([]);
        setError(err instanceof Error ? err.message : "Search failed.");
      }
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [searchRes, savedRes] = await Promise.all([
          fetch("/api/music/search?q=" + encodeURIComponent("event celebration")),
          fetch("/api/music/saved"),
        ]);
        if (cancelled) return;
        const searchBody = await searchRes.json().catch(() => ({}));
        if (searchRes.ok) {
          setTracks(searchBody.tracks ?? []);
          setMoodFacets(searchBody.moods ?? []);
          setGenreFacets(searchBody.genres ?? []);
        } else {
          setError(searchBody.error ?? "Couldn't load the music library.");
        }
        const savedBody = await savedRes.json().catch(() => ({}));
        if (!cancelled && savedRes.ok) setSaved(savedBody.saved ?? []);
      } catch {
        if (!cancelled) setError("Couldn't reach the music library. Check your connection.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      setPeaks(normalizeWaveform(json.data ?? [], 140));
    } catch {
      // Waveform is a nicety — the start slider still works without it.
    }
  }

  function pickTrack(track: LibraryTrack) {
    setSelected(track);
    setStartSeconds(0);
    loadWaveform(track);
  }

  /** Plays from `from`, stopping after `forSeconds` when given. */
  function playFrom(track: LibraryTrack, from = 0, forSeconds?: number) {
    const audio = audioRef.current;
    if (!audio) return;

    if (playingId === track.id && !audio.paused) {
      audio.pause();
      setPlayingId(null);
      return;
    }

    stopAtRef.current = forSeconds ? from + forSeconds : null;
    audio.src = `/api/music/${track.id}/preview`;
    setPlayingId(track.id);
    audio
      .play()
      .then(() => {
        if (from > 0) {
          const seek = () => {
            audio.currentTime = from;
            audio.removeEventListener("loadedmetadata", seek);
          };
          // Seeking before metadata loads is ignored, so jump once it's ready.
          if (audio.readyState >= 1) audio.currentTime = from;
          else audio.addEventListener("loadedmetadata", seek);
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
          // Always sent, so an explicit choice overrides the automatic
          // high-energy pick on the server.
          startSeconds,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't apply that track.");
      onApplied({
        sourceUrl: body.sourceUrl,
        musicTrackTitle: body.musicTrackTitle ?? null,
        mixed: Boolean(body.mixed),
      });
      // Closes this sheet only. The editor behind it stays open so the
      // updated video can be watched straight away.
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply that track.");
      setApplying(false);
    }
  }

  function applyFacet(next: { mood?: string | null; genre?: string | null; vocals?: VocalMode }) {
    const m = next.mood !== undefined ? next.mood : mood;
    const g = next.genre !== undefined ? next.genre : genre;
    const v = next.vocals !== undefined ? next.vocals : vocals;
    setMood(m);
    setGenre(g);
    setVocals(v);
    runSearch(query, { mood: m, genre: g, vocals: v });
  }

  const visible = showSavedOnly ? tracks.filter((t) => saved.some((s) => s.trackId === t.id)) : tracks;
  const maxStart = selected ? Math.max(0, selected.lengthSeconds - clipDurationSeconds) : 0;
  const endSeconds = startSeconds + clipDurationSeconds;

  return (
    // Bottom-anchored with a lighter scrim than before, so the video in the
    // player behind stays visible while a section is auditioned. A true
    // synced audio-over-video preview needs the plan-based preview player,
    // which is deliberately not in scope here.
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-2" onClick={onClose}>
      <div
        className="flex max-h-[72dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <audio
          ref={audioRef}
          onEnded={() => setPlayingId(null)}
          onTimeUpdate={(e) => {
            // Stops a section preview at the end of the selected window.
            const at = stopAtRef.current;
            if (at !== null && e.currentTarget.currentTime >= at) {
              e.currentTarget.pause();
              stopAtRef.current = null;
              setPlayingId(null);
            }
          }}
          className="hidden"
        />

        <div className="shrink-0 border-b border-border p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">Choose music</p>
            <button onClick={onClose} className="tap-scale min-h-11 px-2 text-xs text-neutral-500">
              Close
            </button>
          </div>
          {currentTrackTitle && (
            <p className="mt-0.5 truncate text-[11px] text-neutral-500">Now using: {currentTrackTitle}</p>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(query, { mood, genre, vocals });
            }}
            className="mt-2 flex gap-2"
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search songs, artists, styles…"
              className="flex-1 text-sm"
            />
            <Button type="submit" disabled={loading} className="min-h-11 whitespace-nowrap">
              {loading ? "…" : "Search"}
            </Button>
          </form>

          <div className="mt-2 flex flex-wrap gap-1">
            {QUICK_SEARCHES.map((q) => (
              <button
                key={q}
                onClick={() => {
                  setQuery(q);
                  runSearch(q, { mood, genre, vocals });
                }}
                className="tap-scale rounded-full border border-border px-2.5 py-1 text-[11px] text-neutral-500 hover:border-primary-pink hover:text-primary-pink"
              >
                {q}
              </button>
            ))}
          </div>

          {/* Vocals filter. Epidemic exposes hasVocals and vocalType, and the
              catalog skews heavily instrumental — typically only 8 of 20
              results have any vocals at all. */}
          <div className="mt-2 flex items-center gap-1">
            <span className="mr-1 text-[10px] uppercase tracking-wide text-neutral-500">Vocals</span>
            {(["any", "vocals", "instrumental"] as VocalMode[]).map((v) => (
              <button
                key={v}
                onClick={() => applyFacet({ vocals: v })}
                className={`tap-scale rounded-full px-2.5 py-1 text-[11px] capitalize ${
                  vocals === v ? "bg-primary-pink/15 font-medium text-primary-pink" : "text-neutral-500"
                }`}
              >
                {v === "any" ? "All" : v}
              </button>
            ))}
            <button
              onClick={() => setShowSavedOnly((s) => !s)}
              className={`tap-scale ml-auto rounded-full px-2.5 py-1 text-[11px] ${
                showSavedOnly ? "bg-primary-pink/15 font-medium text-primary-pink" : "text-neutral-500"
              }`}
            >
              ♥ Saved ({saved.length})
            </button>
          </div>

          {(genreFacets.length > 0 || moodFacets.length > 0) && (
            <div className="mt-2 flex gap-1 overflow-x-auto pb-1">
              {(mood || genre) && (
                <button
                  onClick={() => applyFacet({ mood: null, genre: null })}
                  className="tap-scale shrink-0 rounded-full bg-neutral-500/20 px-2.5 py-1 text-[11px] text-foreground"
                >
                  ✕ Clear
                </button>
              )}
              {genreFacets.slice(0, 8).map((f) => (
                <button
                  key={`g-${f.id}`}
                  onClick={() => applyFacet({ genre: genre === f.id ? null : f.id, mood: null })}
                  className={`tap-scale shrink-0 rounded-full border px-2.5 py-1 text-[11px] capitalize ${
                    genre === f.id
                      ? "border-primary-pink bg-primary-pink/10 text-primary-pink"
                      : "border-border text-neutral-500"
                  }`}
                >
                  {f.name}
                </button>
              ))}
              {moodFacets.slice(0, 8).map((f) => (
                <button
                  key={`m-${f.id}`}
                  onClick={() => applyFacet({ mood: mood === f.id ? null : f.id, genre: null })}
                  className={`tap-scale shrink-0 rounded-full border px-2.5 py-1 text-[11px] capitalize ${
                    mood === f.id
                      ? "border-primary-pink bg-primary-pink/10 text-primary-pink"
                      : "border-border text-neutral-500"
                  }`}
                >
                  {f.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && (
            <p className="mb-2 rounded-lg bg-error/15 px-3 py-2 text-xs text-error">{error}</p>
          )}
          {visible.length === 0 && !loading && !error && (
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
                    onClick={() => playFrom(track)}
                    className="tap-scale relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-r from-primary-purple to-primary-pink text-sm text-white"
                    aria-label={playingId === track.id ? "Pause" : "Play preview"}
                  >
                    {track.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={track.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                    )}
                    <span className="relative rounded-full bg-black/50 px-1.5 py-0.5">
                      {playingId === track.id ? "❚❚" : "▶"}
                    </span>
                  </button>

                  <button onClick={() => pickTrack(track)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {track.title}
                      {track.hasVocals && (
                        <span className="ml-1.5 rounded bg-primary-purple/15 px-1 py-0.5 text-[9px] font-medium uppercase text-primary-purple">
                          {track.vocalType === "LEAD" ? "vocals" : "backing"}
                        </span>
                      )}
                      {track.isExplicit && <span className="ml-1 text-[9px] text-neutral-500">E</span>}
                    </span>
                    <span className="block truncate text-[11px] text-neutral-500">
                      {track.artist} · {formatTime(track.lengthSeconds)}
                      {track.bpm ? ` · ${track.bpm} BPM` : ""}
                      {track.genres.length > 0 ? ` · ${track.genres[0]}` : ""}
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
                      Drag to pick the part of the song that plays in your video.
                    </p>

                    {peaks.length > 0 && (
                      <div className="relative mb-1 flex h-14 items-center gap-px overflow-hidden rounded-lg bg-background px-1">
                        {peaks.map((p, i) => {
                          const posSeconds = (i / peaks.length) * track.lengthSeconds;
                          const inWindow = posSeconds >= startSeconds && posSeconds <= endSeconds;
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
                      aria-label="Music start point"
                    />

                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-neutral-400">
                        <span className="font-medium text-foreground">{formatTime(startSeconds)}</span>
                        {" → "}
                        <span className="font-medium text-foreground">{formatTime(endSeconds)}</span>
                        <span className="ml-1 text-neutral-500">({clipDurationSeconds.toFixed(1)}s)</span>
                      </span>
                      <button
                        onClick={() => playFrom(track, startSeconds, clipDurationSeconds)}
                        className="tap-scale min-h-11 font-medium text-primary-pink underline"
                      >
                        ▶ Preview this section
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="shrink-0 border-t border-border p-3">
          <Button onClick={apply} disabled={!selected || applying} className="min-h-11 w-full">
            {applying
              ? "Mixing into your video…"
              : selected
                ? `Use this section of "${selected.title}"`
                : "Pick a track above"}
          </Button>
        </div>
      </div>
    </div>
  );
}
