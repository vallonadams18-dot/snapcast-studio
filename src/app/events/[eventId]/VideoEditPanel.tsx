"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { MusicLibrary } from "./MusicLibrary";

// Manual editing for a generated video: trim the range and swap the music.
// Lives inside the lightbox because that's where someone already is when
// they decide they don't like the automatic cut.
export function VideoEditPanel({
  mediaId,
  sourceUrl,
  currentTrackTitle,
  onChanged,
}: {
  mediaId: string;
  sourceUrl: string;
  currentTrackTitle: string | null;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [duration, setDuration] = useState<number | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [musicOpen, setMusicOpen] = useState(false);
  const [mode, setMode] = useState<"closed" | "trim">("closed");
  const probeRef = useRef<HTMLVideoElement | null>(null);

  // Read the real duration from the file rather than trusting a stored
  // value — a video that's already been trimmed or had bookends added no
  // longer matches whatever range the database recorded at creation.
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

  async function applyTrim() {
    if (duration === null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/media/${mediaId}/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startSeconds: start, endSeconds: end }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Couldn't trim the video.");
      onChanged();
      router.refresh();
      setMode("closed");
    } catch (err) {
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
          second copy of the video next to the lightbox player. */}
      <video ref={probeRef} src={sourceUrl} preload="metadata" className="hidden" />

      <div className="flex gap-2">
        <Button
          variant="secondary"
          onClick={() => setMode(mode === "trim" ? "closed" : "trim")}
          className="min-h-11 flex-1 text-xs"
        >
          {mode === "trim" ? "Cancel trim" : "✂ Trim video"}
        </Button>
        <Button variant="secondary" onClick={() => setMusicOpen(true)} className="min-h-11 flex-1 text-xs">
          🎵 Change music
        </Button>
      </div>

      {currentTrackTitle && (
        <p className="mt-2 truncate text-[10px] text-neutral-500">Music: {currentTrackTitle}</p>
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

              {error && <p className="mt-2 text-[11px] text-error">{error}</p>}

              <Button onClick={applyTrim} disabled={saving || trimmedLength < 0.5} className="mt-3 min-h-11 w-full text-xs">
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
          onApplied={() => {
            onChanged();
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
