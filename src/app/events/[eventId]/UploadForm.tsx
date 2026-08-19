"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ButtonLabel } from "@/components/ui";
import { ErrorState, SuccessBanner } from "@/components/States";

// Mirrors MAX_UPLOAD_BYTES in lib/uploadValidation.ts — this is just a fast
// client-side check for instant feedback; the server enforces the real limit.
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

export function UploadForm({ eventId }: { eventId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // "Uploading 3 of 11 — 47%" / "Processing 3 of 11…" while work is in flight.
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Only the files that FAILED, so retry never re-uploads what already landed.
  const [failedFiles, setFailedFiles] = useState<File[]>([]);

  // XHR instead of fetch purely for upload.onprogress: a multi-minute video
  // upload with no moving number is indistinguishable from a hang.
  function uploadOne(
    file: File,
    onProgress: (percent: number | null) => void,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/events/${eventId}/media`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      };
      // All bytes sent — the server is now validating and generating drafts.
      xhr.upload.onload = () => onProgress(null);
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
      const formData = new FormData();
      formData.append("files", file);
      xhr.send(formData);
    });
  }

  // Files upload ONE PER REQUEST, sequentially. A whole camera-roll
  // selection in a single request used to blow through the server's
  // per-request body cap and stall with no error — clients select a dozen
  // rough videos at once, and that must just work. Sequential also means
  // one broken file costs only itself, and progress can say which file
  // it's on instead of a meaningless combined percentage.
  async function handleFiles(files: FileList | File[] | null) {
    // Guard against double submission: picking more files while an upload
    // is running would fire a second concurrent request.
    if (uploading) return;
    const all = files ? Array.from(files) : [];
    if (all.length === 0) return;
    setError(null);
    setWarning(null);
    setSuccess(null);
    setFailedFiles([]);

    // Oversized files are SKIPPED, not batch-blocking: one huge screen
    // recording shouldn't hold ten good clips hostage.
    const skipped = all.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const queue = all.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    const problems: string[] = skipped.map(
      (f) => `${f.name} is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB) — skipped.`,
    );
    if (queue.length === 0) {
      setError(problems.join(" "));
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    setUploading(true);
    const failed: File[] = [];
    let uploadedCount = 0;

    for (let i = 0; i < queue.length; i++) {
      const file = queue[i];
      const label = `${i + 1} of ${queue.length}`;
      setStatusLine(`Uploading ${label} — 0%`);
      try {
        const { status, body } = await uploadOne(file, (percent) =>
          setStatusLine(percent === null ? `Processing ${label}…` : `Uploading ${label} — ${percent}%`),
        );
        if (status >= 200 && status < 300) {
          uploadedCount += Array.isArray(body.media) ? body.media.length : 1;
          if (typeof body.warning === "string") problems.push(body.warning);
        } else {
          failed.push(file);
          // Server messages usually already name the file — don't say it twice.
          const msg = typeof body.error === "string" ? body.error : "upload failed.";
          problems.push(msg.includes(file.name) ? msg : `${file.name}: ${msg}`);
        }
      } catch {
        failed.push(file);
        problems.push(`${file.name}: connection dropped.`);
      }
    }

    setUploading(false);
    setStatusLine(null);
    setFailedFiles(failed);
    if (inputRef.current) inputRef.current.value = "";

    if (uploadedCount > 0) {
      setSuccess(`${uploadedCount} file${uploadedCount === 1 ? "" : "s"} uploaded — drafts are ready to review.`);
    }
    if (failed.length > 0) {
      setError(
        `${failed.length} file${failed.length === 1 ? "" : "s"} didn't make it. ` +
          problems.slice(0, 3).join(" ") +
          (problems.length > 3 ? ` (+${problems.length - 3} more)` : ""),
      );
    } else if (problems.length > 0) {
      // Non-fatal notes only (skipped-oversized, per-file server warnings).
      setWarning(problems.slice(0, 3).join(" ") + (problems.length > 3 ? ` (+${problems.length - 3} more)` : ""));
    }
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
        {uploading ? (statusLine ?? "Uploading…") : "Upload photos or video"}
      </ButtonLabel>
      <p className="mt-2 text-xs text-neutral-500">
        Select as many as you like — they upload one at a time. Drafts are generated automatically.
      </p>
      {error && (
        <div className="mt-3 text-left">
          <ErrorState
            message={error}
            onRetry={failedFiles.length > 0 ? () => handleFiles(failedFiles) : undefined}
          />
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
