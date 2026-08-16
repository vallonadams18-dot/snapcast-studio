"use client";

import { useState } from "react";
import { EmptyState } from "@/components/States";

type GuestMedia = { id: string; sourceUrl: string; mediaType: string };

export function GuestGallery({
  eventId,
  businessName,
  media,
}: {
  eventId: string;
  businessName: string;
  media: GuestMedia[];
}) {
  const [selected, setSelected] = useState<GuestMedia | null>(null);
  const [name, setName] = useState("");
  const [claimed, setClaimed] = useState(false);

  async function claimAndShare(item: GuestMedia) {
    const shareText = `📸 via ${businessName}`;
    const shareUrl = `${window.location.origin}${item.sourceUrl}`;

    try {
      await fetch(`/api/guest/${eventId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: item.id, guestName: name || undefined }),
      });
    } catch {
      // Claim logging is best-effort — never block the guest's share/download.
    }
    setClaimed(true);

    if (navigator.share) {
      try {
        await navigator.share({ text: shareText, url: shareUrl });
        return;
      } catch {
        // User canceled the native share sheet — fall through to a direct link.
      }
    }
    window.open(shareUrl, "_blank");
  }

  if (media.length === 0) {
    return <EmptyState title="No photos yet" description="Check back once the event gets going." />;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {media.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              setSelected(item);
              setClaimed(false);
            }}
            className="tap-scale aspect-square overflow-hidden rounded-xl border border-border bg-surface"
          >
            {item.mediaType === "photo" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.sourceUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <video src={item.sourceUrl} className="h-full w-full object-cover" muted />
            )}
          </button>
        ))}
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center" onClick={() => setSelected(null)}>
          <div
            className="card-enter w-full max-w-sm overflow-hidden rounded-xl border border-border bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="aspect-square bg-black">
              {selected.mediaType === "photo" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={selected.sourceUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <video src={selected.sourceUrl} className="h-full w-full object-cover" controls autoPlay muted />
              )}
            </div>
            <div className="p-4">
              {!claimed ? (
                <>
                  <label className="mb-3 block text-xs text-neutral-500">
                    Your name (optional)
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="So the host knows who shared it"
                      className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary-pink focus:outline-none"
                    />
                  </label>
                  <button
                    onClick={() => claimAndShare(selected)}
                    className="tap-scale min-h-11 w-full rounded-lg bg-gradient-to-r from-primary-purple to-primary-pink px-4 py-2.5 text-sm font-semibold text-white"
                  >
                    Share this photo
                  </button>
                </>
              ) : (
                <p className="text-center text-sm text-success">Shared! Thanks for spreading the word 🎉</p>
              )}
              <button onClick={() => setSelected(null)} className="tap-scale mt-2 min-h-11 w-full text-xs text-neutral-500">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
