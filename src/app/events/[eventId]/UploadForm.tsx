"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ButtonLabel } from "@/components/ui";
import { ErrorState, SuccessBanner } from "@/components/States";

// Mirrors MAX_UPLOAD_BYTES in lib/media.ts — this is just a fast client-side
// check for instant feedback; the server enforces the real limit.
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

export function UploadForm({ eventId }: { eventId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [lastFiles, setLastFiles] = useState<FileList | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setLastFiles(files);
    setError(null);
    setSuccess(null);

    const oversized = Array.from(files).find((f) => f.size > MAX_UPLOAD_BYTES);
    if (oversized) {
      setError(`${oversized.name} is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB).`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    setUploading(true);
    const formData = new FormData();
    for (const file of Array.from(files)) formData.append("files", file);

    try {
      const response = await fetch(`/api/events/${eventId}/media`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "We couldn't upload that — check your connection and try again.");
      } else {
        const count = files.length;
        setSuccess(`${count} file${count === 1 ? "" : "s"} uploaded — drafts are ready to review.`);
      }
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
    }

    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-dashed border-border bg-surface p-6 text-center">
      <p className="mb-3 text-sm font-medium text-foreground">
        Upload photos & video — add content from this event here
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
        id="media-upload"
      />
      <ButtonLabel htmlFor="media-upload">
        {uploading ? "Uploading & generating drafts…" : "Upload photos or video"}
      </ButtonLabel>
      <p className="mt-2 text-xs text-neutral-500">Drafts are generated automatically after upload.</p>
      {error && (
        <div className="mt-3 text-left">
          <ErrorState message={error} onRetry={() => handleFiles(lastFiles)} />
        </div>
      )}
      {success && (
        <div className="mt-3 text-left">
          <SuccessBanner message={success} />
        </div>
      )}
    </div>
  );
}
