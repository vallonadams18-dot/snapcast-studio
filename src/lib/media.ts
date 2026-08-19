import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Media } from "@/generated/prisma/client";
import { getStorageAdapter, randomFileKey } from "@/lib/storage";
import { MAX_SNIFF_BYTES } from "@/lib/webhooks/safeDownload";
import {
  MAX_UPLOAD_BYTES,
  validateEventUpload,
  keyNameWithDetectedExtension,
} from "@/lib/uploadValidation";
import { getVideoDurationSeconds } from "@/lib/video";

export { MAX_UPLOAD_BYTES };

export async function saveUploadedFile(eventId: string, file: File) {
  // Fast pre-buffer gate; the authoritative checks below run on real bytes.
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB).`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const verdict = validateEventUpload(buffer.subarray(0, MAX_SNIFF_BYTES), buffer.byteLength);
  if (!verdict.ok) throw new Error(verdict.error);
  const { detected } = verdict;

  // Magic bytes prove the container; for videos also prove ffmpeg can
  // actually read it, so a truncated or corrupt file is rejected HERE with
  // a clear message instead of becoming a "ready" Media row that fails
  // later inside the editor or a montage render. Header parse only — fast
  // even at the size cap. Runs before any storage write, so a rejected file
  // leaves nothing behind.
  if (detected.kind === "video") {
    const probeDir = await mkdtemp(path.join(tmpdir(), "snapcast-probe-"));
    try {
      const probePath = path.join(probeDir, `probe.${detected.extension}`);
      await writeFile(probePath, buffer);
      await getVideoDurationSeconds(probePath);
    } catch {
      throw new Error("That video appears to be corrupt or unreadable — try re-exporting it, then upload again.");
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Extension and content type both come from DETECTION, never the client.
  const key = randomFileKey(eventId, keyNameWithDetectedExtension(file.name, detected.extension));
  const saved = await getStorageAdapter().save(key, buffer, detected.contentType);

  return {
    storagePath: saved.storageRef,
    sourceUrl: saved.url,
    mediaType: detected.kind === "video" ? ("video" as const) : ("photo" as const),
  };
}

/** Reads a Media row's bytes back regardless of where it's actually stored. */
export async function getMediaBytes(media: Media): Promise<Buffer> {
  if (media.storagePath.startsWith("http")) {
    const response = await fetch(media.storagePath);
    if (!response.ok) throw new Error(`Failed to fetch media from storage: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  const { readFile } = await import("node:fs/promises");
  return readFile(media.storagePath);
}
