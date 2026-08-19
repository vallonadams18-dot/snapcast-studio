"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  subscribeToUploads,
  getUploadState,
  getServerUploadState,
  setUploadSettledCallback,
  cancelUploads,
  acknowledgeFinished,
} from "@/lib/uploadManager";

// Floating app-wide upload status. Rendered from the root layout so the
// client can leave the event page mid-upload, browse anywhere in the app,
// and still see (and cancel) the batch that's running.
export function UploadStatusBar() {
  const router = useRouter();
  const state = useSyncExternalStore(subscribeToUploads, getUploadState, getServerUploadState);

  // Whatever page is open refreshes as files land, so media grids and
  // draft counts fill in without the user doing anything.
  useEffect(() => {
    setUploadSettledCallback(() => router.refresh());
    return () => setUploadSettledCallback(null);
  }, [router]);

  // A finished clean batch lingers briefly, then clears itself.
  useEffect(() => {
    if (state.status === "idle" && state.finished === "done" && state.failed.length === 0 && state.uploadedCount > 0) {
      const t = setTimeout(() => acknowledgeFinished(), 6000);
      return () => clearTimeout(t);
    }
  }, [state.status, state.finished, state.failed.length, state.uploadedCount]);

  if (state.status === "uploading") {
    const label =
      state.phase === "preparing"
        ? `Preparing ${state.current} of ${state.total}…`
        : state.phase === "processing"
          ? `Processing ${state.current} of ${state.total}…`
          : `Uploading ${state.current} of ${state.total}${state.percent !== null ? ` — ${state.percent}%` : ""}`;
    return (
      <div className="fixed inset-x-0 bottom-0 z-50 px-4 pb-4">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-lg">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{label}</p>
            <p className="text-[11px] text-neutral-500">
              You can keep using the app — uploads continue in the background.
            </p>
          </div>
          <button
            onClick={cancelUploads}
            className="tap-scale min-h-11 shrink-0 rounded-lg border border-border bg-background px-4 text-xs font-medium text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state.finished && (state.uploadedCount > 0 || state.failed.length > 0)) {
    const summary =
      state.finished === "cancelled"
        ? `Upload cancelled — ${state.uploadedCount} file${state.uploadedCount === 1 ? "" : "s"} made it in first.`
        : state.failed.length > 0
          ? `${state.uploadedCount} uploaded, ${state.failed.length} failed — details on the event page.`
          : `${state.uploadedCount} file${state.uploadedCount === 1 ? "" : "s"} uploaded.`;
    return (
      <div className="fixed inset-x-0 bottom-0 z-50 px-4 pb-4">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-lg">
          <p className="min-w-0 truncate text-sm text-foreground">{summary}</p>
          <button
            onClick={acknowledgeFinished}
            className="tap-scale min-h-11 shrink-0 rounded-lg px-3 text-xs text-neutral-500"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return null;
}
