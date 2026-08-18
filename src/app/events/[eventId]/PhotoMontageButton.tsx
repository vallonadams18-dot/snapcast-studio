"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { ErrorState, SuccessBanner } from "@/components/States";
import { MONTAGE_STYLES } from "@/lib/montageStyles";

export function PhotoMontageButton({
  eventId,
  readyPhotoCount,
  suggestedStyleId,
}: {
  eventId: string;
  readyPhotoCount: number;
  suggestedStyleId: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [styleId, setStyleId] = useState(suggestedStyleId);

  if (readyPhotoCount < 2) return null;

  async function generate() {
    setStatus("working");
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/events/${eventId}/create-montage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Couldn't create the video.");

      setStatus("idle");
      // Say when duplicates were skipped. Otherwise "8 photos" from a 20-photo
      // event reads as the app ignoring most of the upload, when in fact it
      // dropped repeats of the same moment on purpose.
      const skipped = typeof body.duplicatesSkipped === "number" ? body.duplicatesSkipped : 0;
      setSuccess(
        `Video ready — ${body.photoCount} photos in the ${body.style ?? "chosen"} style` +
          (skipped > 0 ? `, skipping ${skipped} near-duplicate${skipped === 1 ? "" : "s"}` : "") +
          `. It's in your media below.`,
      );
      router.refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Couldn't create the video.");
    }
  }

  const working = status === "working";

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface p-4">
      <p className="text-sm font-medium text-foreground">Create video from photos</p>
      <p className="mt-1 text-xs text-neutral-500">
        Compiles your best {Math.min(readyPhotoCount, 8)} photos into a vertical video with music — like an
        Instagram or TikTok photo slideshow.
      </p>

      <div className="mt-3">
        <p className="mb-2 text-xs font-medium text-foreground">Pick a style</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MONTAGE_STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStyleId(s.id)}
              disabled={working}
              className={`tap-scale min-h-11 rounded-lg border px-3 py-2 text-left disabled:opacity-60 ${
                styleId === s.id
                  ? "border-primary-pink bg-primary-pink/10"
                  : "border-border bg-background hover:border-primary-pink/50"
              }`}
            >
              <span className="block text-xs font-medium text-foreground">
                {s.name}
                {s.id === suggestedStyleId && (
                  <span className="ml-1 text-[10px] font-normal text-primary-pink">suggested</span>
                )}
              </span>
              <span className="block text-[10px] leading-tight text-neutral-500">{s.description}</span>
            </button>
          ))}
        </div>
      </div>

      <Button onClick={generate} disabled={working} className="mt-3 min-h-11 w-full">
        {working ? "Compiling video… (this takes a minute)" : "Create video"}
      </Button>

      {error && (
        <div className="mt-2">
          <ErrorState message={error} onRetry={generate} />
        </div>
      )}
      {success && (
        <div className="mt-2">
          <SuccessBanner message={success} />
        </div>
      )}
    </div>
  );
}
