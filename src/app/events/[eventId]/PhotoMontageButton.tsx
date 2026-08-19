"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { ErrorState, SuccessBanner } from "@/components/States";
import { MONTAGE_STYLES } from "@/lib/montageStyles";
import { EVENT_IN_20_TEMPLATE } from "@/lib/socialTemplates";

export function PhotoMontageButton({
  eventId,
  readySourceCount,
  readyVideoCount,
  suggestedStyleId,
}: {
  eventId: string;
  readySourceCount: number;
  readyVideoCount: number;
  suggestedStyleId: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Non-fatal advisory: the render succeeded but has no soundtrack.
  const [notice, setNotice] = useState<string | null>(null);
  const [styleId, setStyleId] = useState(suggestedStyleId);
  const [templateId, setTemplateId] = useState<string | null>(EVENT_IN_20_TEMPLATE.id);

  async function generate() {
    setStatus("working");
    setError(null);
    setSuccess(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/events/${eventId}/create-montage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(templateId ? { templateId } : { styleId }),
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
      // A silent video is a usable video, but only if you know it's silent
      // before you post it. Shown as a warning, not an error — the render
      // succeeded.
      setNotice(typeof body.musicWarning === "string" ? body.musicWarning : null);
      router.refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Couldn't create the video.");
    }
  }

  const working = status === "working";
  const templateEligible = readySourceCount >= 2 || readyVideoCount > 0;
  const canGenerate = templateId === EVENT_IN_20_TEMPLATE.id ? templateEligible : readySourceCount >= 2;
  const sourcesNeeded = Math.max(0, 2 - readySourceCount);

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface p-4">
      <p className="text-sm font-medium text-foreground">Create a social video</p>
      <p className="mt-1 text-xs text-neutral-500">
        {canGenerate
          ? `Snapcast will turn your best ${Math.min(readySourceCount, 8)} photos and video moments into a vertical social video.`
          : `Add ${sourcesNeeded} more photo or video${sourcesNeeded === 1 ? "" : "s"} to create your first social video.`}
      </p>

      <div className="mt-3">
        <p className="mb-2 text-xs font-medium text-foreground">Featured template</p>
        <button
          type="button"
          onClick={() => setTemplateId(EVENT_IN_20_TEMPLATE.id)}
          disabled={working || !templateEligible}
          className={`tap-scale min-h-11 w-full rounded-xl border p-3 text-left disabled:opacity-60 ${
            templateId === EVENT_IN_20_TEMPLATE.id
              ? "border-primary-pink bg-gradient-to-r from-primary-purple/10 to-primary-pink/10"
              : "border-border bg-background hover:border-primary-pink/50"
          }`}
        >
          <span className="flex items-center justify-between gap-2 text-sm font-semibold text-foreground">
            {EVENT_IN_20_TEMPLATE.name}
            <span className="rounded-full bg-primary-pink/15 px-2 py-1 text-[10px] font-medium text-primary-pink">NEW</span>
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-neutral-500">
            {EVENT_IN_20_TEMPLATE.description} A long upload can supply several different scenes.
          </span>
          <span className="mt-2 block text-[10px] font-medium text-primary-pink">About 20 seconds · photos + video</span>
        </button>
      </div>

      <div className="mt-3">
        <p className="mb-2 text-xs font-medium text-foreground">Or pick a visual style</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MONTAGE_STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setTemplateId(null);
                setStyleId(s.id);
              }}
              disabled={working || readySourceCount < 2}
              className={`tap-scale min-h-11 rounded-lg border px-3 py-2 text-left disabled:opacity-60 ${
                templateId === null && styleId === s.id
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

      <Button onClick={generate} disabled={working || !canGenerate} className="mt-3 min-h-11 w-full">
        {working
          ? "Compiling video… (this takes a minute)"
          : canGenerate
            ? templateId
              ? `Use ${EVENT_IN_20_TEMPLATE.name}`
              : "Create video"
            : `Add ${sourcesNeeded} more to create`}
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
      {notice && (
        <p className="mt-2 rounded-lg bg-warning/15 px-3 py-2 text-xs text-warning">⚠ {notice}</p>
      )}
    </div>
  );
}
