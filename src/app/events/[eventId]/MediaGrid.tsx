"use client";

import { useMemo, useState } from "react";
import { MusicPicker } from "./MusicPicker";
import { VideoClipButton } from "./VideoClipButton";
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

export function MediaGrid({ media }: { media: GridMedia[] }) {
  const [filter, setFilter] = useState<Filter>("all");

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

  const tabs: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: "All", count: counts.all },
    { id: "photos", label: "Photos", count: counts.photos },
    { id: "videos", label: "Videos", count: counts.videos },
  ];

  if (media.length === 0) {
    return (
      <EmptyState
        title="No uploads yet"
        description="Upload photos or video above to generate your first drafts."
      />
    );
  }

  return (
    <div>
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
                {m.mediaType === "photo" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.sourceUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <video src={m.sourceUrl} className="h-full w-full object-cover" muted />
                )}

                {isGenerated && (
                  <>
                    <span className="absolute left-1 top-1 rounded-lg bg-primary-pink/90 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      {m.compiledFromMediaIds ? "Photo video" : "Clip"}
                    </span>
                    <div className="absolute inset-x-0 bottom-0 p-1">
                      <MusicPicker
                        mediaId={m.id}
                        currentTrackId={m.musicTrack}
                        currentTrackTitle={m.musicTrackTitle}
                        clipDurationSeconds={m.durationSeconds}
                      />
                    </div>
                  </>
                )}

                {m.mediaType === "video" && !isGenerated && <VideoClipButton mediaId={m.id} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
