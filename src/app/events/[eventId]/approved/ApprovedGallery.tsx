"use client";

import { useState } from "react";

export type ApprovedCaption = {
  draftId: string;
  platform: string;
  text: string;
  wasEdited: boolean;
};

export type ApprovedItem = {
  mediaId: string;
  mediaUrl: string;
  mediaType: string;
  isClip: boolean;
  isMontage: boolean;
  captions: ApprovedCaption[];
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
};

export function ApprovedGallery({ items }: { items: ApprovedItem[] }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copyCaption(caption: ApprovedCaption) {
    await navigator.clipboard.writeText(caption.text);
    setCopiedId(caption.draftId);
    setTimeout(() => setCopiedId(null), 1500);
  }

  function labelFor(item: ApprovedItem): string | null {
    if (item.isMontage) return "Photo video";
    if (item.isClip) return "Clip";
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      {items.map((item) => {
        const badge = labelFor(item);
        // The stored filename already carries a UUID, so it's unique — but a
        // raw UUID is a miserable thing to find in a Downloads folder later.
        const downloadName = `snapcast-${item.mediaId}${item.mediaType === "video" ? ".mp4" : ".jpg"}`;

        return (
          <div
            key={item.mediaId}
            className="overflow-hidden rounded-xl border border-border bg-surface sm:flex"
          >
            <div className="relative aspect-square bg-black sm:w-48 sm:shrink-0">
              {item.mediaType === "photo" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.mediaUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <video src={item.mediaUrl} className="h-full w-full object-cover" muted controls />
              )}
              {badge && (
                <span className="absolute left-2 top-2 rounded-lg bg-primary-pink/90 px-2 py-0.5 text-[10px] font-medium text-white">
                  {badge}
                </span>
              )}
            </div>

            <div className="flex flex-1 flex-col p-4">
              <div className="flex flex-col gap-3">
                {item.captions.map((caption) => (
                  <div key={caption.draftId}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="rounded-lg bg-primary-pink/10 px-2 py-0.5 text-[11px] font-medium text-primary-pink">
                        {PLATFORM_LABELS[caption.platform] ?? caption.platform}
                      </span>
                      {caption.wasEdited && (
                        <span className="text-[10px] text-neutral-500">edited by you</span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-foreground">{caption.text}</p>
                    <button
                      onClick={() => copyCaption(caption)}
                      className="tap-scale mt-1 min-h-11 text-xs text-neutral-500 underline"
                    >
                      {copiedId === caption.draftId ? "Copied!" : "Copy caption"}
                    </button>
                  </div>
                ))}
              </div>

              <a
                href={item.mediaUrl}
                download={downloadName}
                className="tap-scale mt-4 inline-flex min-h-11 items-center justify-center rounded-lg bg-gradient-to-r from-primary-purple to-primary-pink px-4 text-sm font-semibold text-white"
              >
                Download {item.mediaType === "video" ? "video" : "photo"}
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}
