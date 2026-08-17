"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MusicPicker } from "./MusicPicker";
import { VideoClipButton } from "./VideoClipButton";
import { VideoEditPanel } from "./VideoEditPanel";
import { EmptyState } from "@/components/States";

export type GridMedia = {
  id: string;
  sourceUrl: string;
  mediaType: string;
  sourceMediaId: string | null;
  compiledFromMediaIds: string | null;
  musicTrack: string | null;
  musicTrackTitle: string | null;
  durationSeconds: number;
};

type Filter = "all" | "photos" | "videos";

const AUTO_REFRESH_MS = 10_000;

export function MediaGrid({ media }: { media: GridMedia[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [lightbox, setLightbox] = useState<GridMedia | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const lightboxVideoRef = useRef<HTMLVideoElement | null>(null);

  const counts = useMemo(
    () => ({
      all: media.length,
      // "Videos" means anything that plays — uploaded footage, cut clips, and
      // photo montages alike. Someone looking for "the videos" wants all of
      // those, not just the ones that arrived as video files.
      photos: media.filter((m) => m.mediaType === "photo").length,
      videos: media.filter((m) => m.mediaType === "video").length,
    }),
    [media],
  );

  const visible = useMemo(() => {
    if (filter === "photos") return media.filter((m) => m.mediaType === "photo");
    if (filter === "videos") return media.filter((m) => m.mediaType === "video");
    return media;
  }, [media, filter]);

  // Poll for new uploads. Skipped while the tab is hidden — a booth laptop
  // left open all night shouldn't hammer the server, and there's nothing to
  // show anyone who isn't looking. Also paused while the lightbox is open,
  // since a refresh mid-playback would interrupt it.
  useEffect(() => {
    if (!autoRefresh) return;

    const tick = () => {
      if (document.visibilityState !== "visible" || lightbox) return;
      setRefreshing(true);
      router.refresh();
      // router.refresh() gives no completion signal, so clear the indicator
      // on a short timer rather than leaving it spinning forever.
      setTimeout(() => {
        setRefreshing(false);
        setLastRefresh(Date.now());
      }, 800);
    };

    const id = setInterval(tick, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, lightbox, router]);

  // Close the lightbox on Escape — expected of anything full-screen.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  function manualRefresh() {
    setRefreshing(true);
    router.refresh();
    setTimeout(() => {
      setRefreshing(false);
      setLastRefresh(Date.now());
    }, 800);
  }

  const tabs: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: "All", count: counts.all },
    { id: "photos", label: "Photos", count: counts.photos },
    { id: "videos", label: "Videos", count: counts.videos },
  ];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <button
          onClick={manualRefresh}
          disabled={refreshing}
          className="tap-scale min-h-11 rounded-lg border border-border bg-surface px-3 text-xs text-neutral-500 disabled:opacity-60"
        >
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </button>

        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="accent-primary-pink"
          />
          Auto-refresh
          {autoRefresh && (
            <span className="text-[10px] text-primary-pink">
              every {AUTO_REFRESH_MS / 1000}s
              {lastRefresh ? ` · updated ${new Date(lastRefresh).toLocaleTimeString()}` : ""}
            </span>
          )}
        </label>
      </div>

      {media.length === 0 ? (
        <EmptyState
          title="No uploads yet"
          description="Upload photos or video above to generate your first drafts."
        />
      ) : (
        <>
          <div className="mb-3 flex gap-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={`tap-scale min-h-11 flex-1 rounded-lg border px-3 text-xs font-medium ${
                  filter === tab.id
                    ? "border-primary-pink bg-primary-pink/10 text-primary-pink"
                    : "border-border bg-surface text-neutral-500"
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-neutral-500">
              {filter === "videos"
                ? "No videos yet — generate one from your photos above."
                : "No photos yet."}
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {visible.map((m) => {
                const isGenerated = Boolean(m.sourceMediaId || m.compiledFromMediaIds);
                return (
                  <div
                    key={m.id}
                    className="relative aspect-square overflow-hidden rounded-xl border border-border bg-surface"
                  >
                    {/* The whole tile opens the player. Inline <video controls>
                        on a third-of-a-screen thumbnail is unusable, and the
                        music picker sits over exactly where the controls
                        would render. */}
                    <button
                      onClick={() => setLightbox(m)}
                      className="tap-scale block h-full w-full"
                      aria-label={m.mediaType === "video" ? "Play video" : "View photo"}
                    >
                      {m.mediaType === "photo" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.sourceUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <>
                          <video
                            src={m.sourceUrl}
                            className="h-full w-full object-cover"
                            muted
                            preload="metadata"
                          />
                          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-sm text-white">
                              ▶
                            </span>
                          </span>
                        </>
                      )}
                    </button>

                    {isGenerated && (
                      <>
                        <span className="pointer-events-none absolute left-1 top-1 rounded-lg bg-primary-pink/90 px-1.5 py-0.5 text-[10px] font-medium text-white">
                          {m.compiledFromMediaIds ? "Photo video" : "Clip"}
                        </span>
                        <div className="absolute inset-x-0 bottom-0 p-1" onClick={(e) => e.stopPropagation()}>
                          <MusicPicker
                            mediaId={m.id}
                            currentTrackId={m.musicTrack}
                            currentTrackTitle={m.musicTrackTitle}
                            clipDurationSeconds={m.durationSeconds}
                          />
                        </div>
                      </>
                    )}

                    {m.mediaType === "video" && !isGenerated && (
                      <div onClick={(e) => e.stopPropagation()}>
                        <VideoClipButton mediaId={m.id} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setLightbox(null)}
        >
          <div className="flex max-h-full w-full max-w-md flex-col" onClick={(e) => e.stopPropagation()}>
            {lightbox.mediaType === "video" ? (
              <video
                ref={lightboxVideoRef}
                src={lightbox.sourceUrl}
                className="max-h-[80vh] w-full rounded-xl bg-black"
                controls
                autoPlay
                playsInline
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={lightbox.sourceUrl}
                alt=""
                className="max-h-[80vh] w-full rounded-xl object-contain"
              />
            )}

            <div className="mt-3 flex gap-2">
              <a
                href={lightbox.sourceUrl}
                download
                className="tap-scale flex min-h-11 flex-1 items-center justify-center rounded-lg bg-gradient-to-r from-primary-purple to-primary-pink px-4 text-sm font-semibold text-white"
              >
                Download
              </a>
              <button
                onClick={() => setLightbox(null)}
                className="tap-scale min-h-11 rounded-lg border border-neutral-700 px-4 text-sm text-neutral-300"
              >
                Close
              </button>
            </div>

            {/* Editing tools live here rather than on the thumbnail: this is
                where someone already is when they decide the automatic cut
                or track was wrong. */}
            {lightbox.mediaType === "video" && (
              <VideoEditPanel
                mediaId={lightbox.id}
                sourceUrl={lightbox.sourceUrl}
                currentTrackTitle={lightbox.musicTrackTitle}
                onChanged={() => setLightbox(null)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
