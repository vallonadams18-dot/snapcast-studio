"use client";

import { useRef, useSyncExternalStore } from "react";
import { ButtonLabel } from "@/components/ui";
import { ErrorState, SuccessBanner } from "@/components/States";
import {
  enqueueUploads,
  retryFailedUploads,
  subscribeToUploads,
  getUploadState,
  getServerUploadState,
} from "@/lib/uploadManager";

// Thin view onto the app-wide upload manager (lib/uploadManager.ts). The
// actual queue lives at module scope so navigating away mid-upload doesn't
// kill it — the global UploadStatusBar keeps showing progress anywhere in
// the app, and this form shows the detailed per-file outcome when the user
// is on the event page.
export function UploadForm({ eventId }: { eventId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const state = useSyncExternalStore(subscribeToUploads, getUploadState, getServerUploadState);

  const uploading = state.status === "uploading";
  const statusLine =
    state.phase === "preparing"
      ? `Preparing ${state.current} of ${state.total}…`
      : state.phase === "processing"
        ? `Processing ${state.current} of ${state.total}…`
        : uploading
          ? `Uploading ${state.current} of ${state.total}${state.percent !== null ? ` — ${state.percent}%` : ""}`
          : null;

  const finishedWithFailures = !uploading && state.failed.length > 0;
  const finishedProblemsOnly = !uploading && state.failed.length === 0 && state.problems.length > 0;
  const problemSummary =
    state.problems.slice(0, 3).join(" ") + (state.problems.length > 3 ? ` (+${state.problems.length - 3} more)` : "");

  function handleFiles(files: FileList | null) {
    const all = files ? Array.from(files) : [];
    if (inputRef.current) inputRef.current.value = "";
    if (all.length > 0) enqueueUploads(eventId, all);
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
        {statusLine ?? "Upload photos or video"}
      </ButtonLabel>
      <p className="mt-2 text-xs text-neutral-500">
        {uploading
          ? "Adding more files queues them behind this batch. You can leave this page — uploads keep going."
          : "Select as many as you like — they upload one at a time. Drafts are generated automatically."}
      </p>
      {finishedWithFailures && (
        <div className="mt-3 text-left">
          <ErrorState
            message={`${state.failed.length} file${state.failed.length === 1 ? "" : "s"} didn't make it. ${problemSummary}`}
            onRetry={retryFailedUploads}
          />
        </div>
      )}
      {(uploading || finishedProblemsOnly) && state.problems.length > 0 && !finishedWithFailures && (
        <p className="mt-3 rounded-lg bg-warning/10 p-2 text-left text-[11px] text-warning">{problemSummary}</p>
      )}
      {!uploading && state.finished === "done" && state.uploadedCount > 0 && (
        <div className="mt-3 text-left">
          <SuccessBanner
            message={`${state.uploadedCount} file${state.uploadedCount === 1 ? "" : "s"} uploaded — drafts are ready to review.`}
          />
        </div>
      )}
    </div>
  );
}
