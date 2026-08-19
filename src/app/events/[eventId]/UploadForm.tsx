"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ButtonLabel } from "@/components/ui";
import { ErrorState, SuccessBanner } from "@/components/States";

// Mirrors MAX_UPLOAD_BYTES in lib/uploadValidation.ts — this is just a fast
// client-side check for instant feedback; the server enforces the real limit.
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

export function UploadForm({ eventId }: { eventId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // 0-100 while bytes are in flight; null once the server is processing.
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [lastFiles, setLastFiles] = useState<FileList | null>(null);

  // XHR instead of fetch purely for upload.onprogress: a multi-minute video
  // upload with no moving number is indistinguishable from a hang.
  function uploadWithProgress(formData: FormData): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/events/${eventId}/media`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      };
      // All bytes sent — the server is now validating and generating drafts.
      xhr.upload.onload = () => setProgress(null);
      xhr.onload = () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // Non-JSON error page (e.g. a proxy 413) — keep the empty body.
        }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject(new Error("network"));
      xhr.send(formData);
    });
  }

  async function handleFiles(files: FileList | null) {
    // Guard against double submission: picking more files while an upload
    // is running would fire a second concurrent request.
    if (uploading) return;
    if (!files || files.length === 0) return;
    setLastFiles(files);
    setError(null);
    setWarning(null);
    setSuccess(null);

    const oversized = Array.from(files).find((f) => f.size > MAX_UPLOAD_BYTES);
    if (oversized) {
      setError(`${oversized.name} is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB).`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    setUploading(true);
    setProgress(0);
    const formData = new FormData();
    for (const file of Array.from(files)) formData.append("files", file);

    try {
      const { status, body } = await uploadWithProgress(formData);

      if (status < 200 || status >= 300) {
        setError(
          typeof body.error === "string"
            ? body.error
            : "We couldn't upload that — check your connection and try again.",
        );
      } else {
        const count = Array.isArray(body.media) ? body.media.length : files.length;
        setSuccess(`${count} file${count === 1 ? "" : "s"} uploaded — drafts are ready to review.`);
        // Partial failures (one bad file in a batch) arrive as a warning
        // beside the successes — surface them or the client never learns.
        if (typeof body.warning === "string") setWarning(body.warning);
      }
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
    }

    setUploading(false);
    setProgress(null);
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
        disabled={uploading}
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
        id="media-upload"
      />
      <ButtonLabel
        htmlFor="media-upload"
        className={uploading ? "pointer-events-none opacity-60" : ""}
        aria-disabled={uploading}
      >
        {uploading
          ? progress !== null
            ? `Uploading… ${progress}%`
            : "Processing & generating drafts…"
          : "Upload photos or video"}
      </ButtonLabel>
      <p className="mt-2 text-xs text-neutral-500">Drafts are generated automatically after upload.</p>
      {error && (
        <div className="mt-3 text-left">
          <ErrorState message={error} onRetry={() => handleFiles(lastFiles)} />
        </div>
      )}
      {warning && (
        <p className="mt-3 rounded-lg bg-warning/10 p-2 text-left text-[11px] text-warning">{warning}</p>
      )}
      {success && (
        <div className="mt-3 text-left">
          <SuccessBanner message={success} />
        </div>
      )}
    </div>
  );
}
