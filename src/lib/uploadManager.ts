// App-wide upload manager. Lives at MODULE scope on the client, so the
// queue keeps uploading while the user navigates between pages — the event
// page's form and the global status bar are both just views onto this one
// store (React's useSyncExternalStore contract: subscribe + getSnapshot).
//
// Honest platform limit, by design: this survives navigation INSIDE the
// app. A full page reload, or iOS suspending the browser after the phone
// locks or the user switches apps for a while, still interrupts uploads —
// no web page can override that. Resumable chunked uploads are the later
// answer if that ever matters at real client scale.

export interface UploadEntry {
  file: File;
  eventId: string;
}

export interface UploadState {
  status: "idle" | "uploading";
  /** 1-based position of the file currently in flight. */
  current: number;
  total: number;
  /** 0-100 while bytes move; null while the server processes the file. */
  percent: number | null;
  phase: "preparing" | "uploading" | "processing" | null;
  uploadedCount: number;
  /** Skips, per-file warnings, and failure messages for the current batch. */
  problems: string[];
  /** Files that failed, kept so a retry re-uploads only those. */
  failed: UploadEntry[];
  /** Set when a batch finishes: "done" | "cancelled". Cleared on next enqueue. */
  finished: "done" | "cancelled" | null;
}

const IDLE: UploadState = {
  status: "idle",
  current: 0,
  total: 0,
  percent: null,
  phase: null,
  uploadedCount: 0,
  problems: [],
  failed: [],
  finished: null,
};

// Mirrors MAX_UPLOAD_BYTES in lib/uploadValidation.ts — client-side gate for
// instant feedback; the server enforces the real limit.
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

let state: UploadState = IDLE;
const listeners = new Set<() => void>();
const queue: UploadEntry[] = [];
let activeXhr: XMLHttpRequest | null = null;
let cancelled = false;
let running = false;
/** Called after each successful file and at batch end — the app shell wires
 *  this to router.refresh() so whatever page is open picks up new media. */
let onSettled: (() => void) | null = null;

function emit(patch: Partial<UploadState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribeToUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUploadState(): UploadState {
  return state;
}

/** Stable server/first-render snapshot so hydration never mismatches. */
export function getServerUploadState(): UploadState {
  return IDLE;
}

export function setUploadSettledCallback(cb: (() => void) | null) {
  onSettled = cb;
}

export function cancelUploads() {
  if (state.status !== "uploading") return;
  cancelled = true;
  queue.length = 0;
  activeXhr?.abort();
}

/** Clear the finished banner (e.g. after the user dismisses it). */
export function acknowledgeFinished() {
  if (state.status === "idle") emit({ ...IDLE });
}

// Phone photos arrive at 10-20MB but the reel renders at 1080x1920 — shrink
// JPEGs on-device before they travel. Fall back to the original on any
// hiccup; the server validates real bytes either way.
const COMPRESS_OVER_BYTES = 3 * 1024 * 1024;
const MAX_EDGE = 2160;
async function compressPhoto(file: File): Promise<File> {
  if (!file.type.startsWith("image/jpeg") || file.size <= COMPRESS_OVER_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]*$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function uploadOne(entry: UploadEntry): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeXhr = xhr;
    xhr.open("POST", `/api/events/${entry.eventId}/media`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        emit({ phase: "uploading", percent: Math.min(100, Math.round((e.loaded / e.total) * 100)) });
      }
    };
    xhr.upload.onload = () => emit({ phase: "processing", percent: null });
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
    xhr.onabort = () => reject(new Error("aborted"));
    const formData = new FormData();
    formData.append("files", entry.file);
    xhr.send(formData);
  });
}

async function runQueue() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      if (cancelled) break;
      const entry = queue.shift()!;
      emit({
        current: state.current + 1,
        phase: "preparing",
        percent: null,
      });
      const prepared: UploadEntry = { file: await compressPhoto(entry.file), eventId: entry.eventId };
      if (cancelled) break;
      emit({ phase: "uploading", percent: 0 });
      try {
        const { status, body } = await uploadOne(prepared);
        if (status >= 200 && status < 300) {
          const added = Array.isArray(body.media) ? body.media.length : 1;
          const problems = [...state.problems];
          if (typeof body.warning === "string") problems.push(body.warning);
          emit({ uploadedCount: state.uploadedCount + added, problems });
          onSettled?.();
        } else {
          const msg = typeof body.error === "string" ? body.error : "upload failed.";
          emit({
            failed: [...state.failed, entry],
            problems: [...state.problems, msg.includes(entry.file.name) ? msg : `${entry.file.name}: ${msg}`],
          });
        }
      } catch (err) {
        if (err instanceof Error && err.message === "aborted") break;
        emit({
          failed: [...state.failed, entry],
          problems: [...state.problems, `${entry.file.name}: connection dropped.`],
        });
      } finally {
        activeXhr = null;
      }
    }
  } finally {
    running = false;
    const wasCancelled = cancelled;
    cancelled = false;
    emit({
      status: "idle",
      phase: null,
      percent: null,
      finished: wasCancelled ? "cancelled" : "done",
    });
    onSettled?.();
  }
}

/**
 * Add files to the upload queue. Safe to call while a batch is running —
 * the new files join the end of the queue and the totals grow. Oversized
 * files are skipped with a note instead of blocking the rest.
 */
export function enqueueUploads(eventId: string, files: File[]) {
  if (files.length === 0) return;
  const skipped = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  const accepted = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
  const skipNotes = skipped.map(
    (f) => `${f.name} is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB) — skipped.`,
  );

  for (const file of accepted) queue.push({ file, eventId });
  if (state.status === "idle") {
    // Fresh batch: reset counters and start clean.
    emit({
      ...IDLE,
      status: accepted.length > 0 ? "uploading" : "idle",
      total: accepted.length,
      problems: skipNotes,
    });
  } else {
    // Files added while a batch runs simply extend it.
    emit({
      total: state.total + accepted.length,
      problems: [...state.problems, ...skipNotes],
    });
  }

  if (accepted.length > 0) void runQueue();
}

/** Re-upload exactly the entries that failed in the previous batch. */
export function retryFailedUploads() {
  const failed = state.failed;
  if (failed.length === 0) return;
  emit({ ...IDLE, status: "uploading" });
  for (const entry of failed) queue.push(entry);
  emit({ total: failed.length });
  void runQueue();
}
