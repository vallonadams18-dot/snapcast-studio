"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function VideoClipButton({ mediaId }: { mediaId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function generateClip() {
    setStatus("working");
    setError(null);
    try {
      const response = await fetch(`/api/media/${mediaId}/create-clip`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Clip generation failed.");
      }
      setStatus("idle");
      router.refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Clip generation failed.");
    }
  }

  return (
    <div className="absolute inset-x-0 bottom-0 bg-black/70 p-1">
      <button
        onClick={generateClip}
        disabled={status === "working"}
        className="tap-scale min-h-11 w-full rounded-lg bg-gradient-to-r from-primary-purple to-primary-pink text-[10px] font-semibold text-white disabled:opacity-60"
      >
        {status === "working" ? "Cutting clip…" : "Generate clip"}
      </button>
      {error && <p className="mt-1 text-center text-[10px] text-error">{error}</p>}
    </div>
  );
}
