"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { MusicLibrary } from "./MusicLibrary";

/** What changed about the media, handed up so the player can swap in place. */
export interface MediaUpdate {
  sourceUrl: string;
  musicTrackTitle?: string | null;
}

// Manual editing for a generated video: trim the range and swap the music.
// Lives inside the lightbox because that's where someone already is when
// they decide they don't like the automatic cut.
//
// After a successful edit this panel STAYS OPEN and the player reloads the
// new file in place. It used to close the whole lightbox and drop you back
// on the grid, which — after fifteen seconds of "Mixing into your video…" —
// was indistinguishable from the edit having silently failed.
export function VideoEditPanel({
  mediaId,
  sourceUrl,
  currentTrackTitle,
  isGenerated,
  onUpdated,
}: {
  mediaId: string;
  sourceUrl: string;
  currentTrackTitle: string | null;
  /**
   * True for a cut clip or a photo montage. Music can only be swapped on
   * generated video — the server refuses to re-encode a client's own
   * uploaded footage — so offering the button on a raw upload would be a
   * control that silently does nothing.
   */
  isGenerated: boolean;
  onUpdated: (update: MediaUpdate) => void;
}) {
  const router = useRouter();
  const [duration, setDuration] = useState<number | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [musicOpen, setMusicOpen] = useState(false);
  const [mode, setMode] = useState<"closed" | "trim">("closed");
  const probeRef = useRef<HTMLVideoElement | null>(null);

  // Read the real duration from the file rather than trusting a stored
  // value — a video that's already been trimmed or had bookends added no
  // longer matches whatever range the database recorded at creation.
  //
  // Re-runs whenever sourceUrl changes, so the sliders re-scale to the new
  // length the moment a trim lands.
  useEffect(() => {
    if (mode !== "trim") return;
    const video = probeRef.current;
    if (!video) return;

    const onMeta = () => {
      if (!Number.isFinite(video.duration)) return;
      setDuration(video.duration);
      setStart(0);
      setEnd(video.duration);
    };
    if (video.readyState >= 1) onMeta();
    else video.addEventListener("loadedmetadata", onMeta);
    return () => video.removeEventListener("loadedmetadata", onMeta);
  }, [mode, sourceUrl]);

  // Success messages shouldn't outlive the moment. Errors stay until the
  // next attempt, because they need acting on.
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  async function applyTrim() {
    if (duration === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/media/${mediaId}/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startSeconds: start, endSeconds: end }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Couldn't trim the video.");

      setNotice("Trim saved");
      // Hand the new URL up. The player swaps it in and re-renders this
      // panel with the new sourceUrl, which re-probes the duration above.
      // Deliberately does NOT close anything.
      onUpdated({ sourceUrl: body.sourceUrl });
      router.refresh();
    } catch (err) {
      // Stay open on failure — closing would throw away the range they set.
      setError(err instanceof Error ? err.message : "Couldn't trim the video.");
    }
    setSaving(false);
  }

  function fmt(s: number) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  const trimmedLength = Math.max(0, end - start);

  return (
    <div className="mt-3 rounded-xl border border-neutral-700 bg-neutral-900 p-3">
      {/* Hidden probe element: reads duration metadata without showing a
          second copy of the video next to the lightbox player. Keyed on the
          URL so a new file gets a FRESH element — reusing it can report the
          previous file's duration, because readyState does not reset in step
          with the src attribute. */}
      <video key={sourceUrl} ref={probeRef} src={sourceUrl} preload="metadata" className="hidden" />

      <div className="flex gap-2">
        <Button
          variant="secondary"
          onClick={() => setMode(mode === "trim" ? "closed" : "trim")}
          className="min-h-11 flex-1 text-xs"
        >
          {mode === "trim" ? "Cancel trim" : "✂ Trim video"}
        </Button>
        {isGenerated && (
          <Button variant="secondary" onClick={() => setMusicOpen(true)} className="min-h-11 flex-1 text-xs">
            🎵 Change music
          </Button>
        )}
      </div>

      {currentTrackTitle && (
        <p className="mt-2 truncate text-[10px] text-neutral-500">Music: {currentTrackTitle}</p>
      )}

      {notice && (
        <p className="mt-2 rounded-lg bg-success/15 px-2 py-1.5 text-[11px] font-medium text-success">
          ✓ {notice}
        </p>
      )}

      {error && (
        <div className="mt-2 rounded-lg bg-error/15 px-2 py-1.5">
          <p className="text-[11px] text-error">{error}</p>
          <button
            onClick={() => (mode === "trim" ? applyTrim() : setError(null))}
            className="tap-scale mt-1 min-h-11 text-[11px] font-medium text-error underline"
          >
            {mode === "trim" ? "Retry" : "Dismiss"}
          </button>
        </div>
      )}

      {mode === "trim" && (
        <div className="mt-3 border-t border-neutral-700 pt-3">
          {duration === null ? (
            <p className="text-xs text-neutral-500">Reading video…</p>
          ) : (
            <>
              <p className="mb-2 text-[11px] text-neutral-400">
                Keeping {fmt(start)} – {fmt(end)}{" "}
                <span className="text-neutral-500">({trimmedLength.toFixed(1)}s)</span>
                <span className="ml-1 text-neutral-600">of {duration.toFixed(1)}s</span>
              </p>

              <label className="block text-[10px] text-neutral-500">
                Start
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, duration - 0.5)}
                  step={0.1}
                  value={start}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setStart(v);
                    // Keep at least half a second between the handles so the
                    // range can never invert.
                    if (v > end - 0.5) setEnd(Math.min(duration, v + 0.5));
                  }}
                  className="w-full accent-primary-pink"
                />
              </label>

              <label className="mt-2 block text-[10px] text-neutral-500">
                End
                <input
                  type="range"
                  min={0.5}
                  max={duration}
                  step={0.1}
                  value={end}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setEnd(v);
                    if (v < start + 0.5) setStart(Math.max(0, v - 0.5));
                  }}
                  className="w-full accent-primary-pink"
                />
              </label>

              <Button
                onClick={applyTrim}
                disabled={saving || trimmedLength < 0.5}
                className="mt-3 min-h-11 w-full text-xs"
              >
                {saving ? "Trimming…" : `Save trimmed video (${trimmedLength.toFixed(1)}s)`}
              </Button>
              <p className="mt-1 text-[10px] text-neutral-500">
                This replaces the video. Your original uploads are untouched.
              </p>
            </>
          )}
        </div>
      )}

      {musicOpen && (
        <MusicLibrary
          mediaId={mediaId}
          clipDurationSeconds={duration ?? 15}
          currentTrackTitle={currentTrackTitle}
          onClose={() => setMusicOpen(false)}
          onApplied={(result) => {
            // Be honest about what happened: the server keeps the client's
            // track choice even when it couldn't re-mix the audio.
            setNotice(result.mixed ? "Music updated" : "Track saved — audio unchanged");
            onUpdated({ sourceUrl: result.sourceUrl, musicTrackTitle: result.musicTrackTitle });
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
