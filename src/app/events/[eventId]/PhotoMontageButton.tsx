"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { ErrorState } from "@/components/States";

export function PhotoMontageButton({ eventId, readyPhotoCount }: { eventId: string; readyPhotoCount: number }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  if (readyPhotoCount < 2) return null;

  async function generate() {
    setStatus("working");
    setError(null);
    try {
      const response = await fetch(`/api/events/${eventId}/create-montage`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Couldn't create the video.");
      }
      setStatus("idle");
      router.refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Couldn't create the video.");
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface p-4">
      <p className="text-sm font-medium text-foreground">Create video from photos</p>
      <p className="mt-1 text-xs text-neutral-500">
        Compiles your best {Math.min(readyPhotoCount, 8)} photos into a vertical video with music — like an
        Instagram or TikTok photo slideshow.
      </p>
      <Button onClick={generate} disabled={status === "working"} className="mt-3 min-h-11 w-full">
        {status === "working" ? "Compiling video…" : "Create video"}
      </Button>
      {error && (
        <div className="mt-2">
          <ErrorState message={error} onRetry={generate} />
        </div>
      )}
    </div>
  );
}
