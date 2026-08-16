import type { Media } from "@/generated/prisma/client";
import { getStorageAdapter, randomFileKey } from "@/lib/storage";

export function mediaTypeForFile(file: File): "photo" | "video" {
  return file.type.startsWith("video/") ? "video" : "photo";
}

// Generous enough for phone-shot event photos/video clips, bounded enough
// that one upload can't exhaust memory/disk or kick off a runaway ffmpeg job.
export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

export async function saveUploadedFile(eventId: string, file: File) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB).`);
  }

  const key = randomFileKey(eventId, file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  const saved = await getStorageAdapter().save(key, buffer, file.type || "application/octet-stream");

  return {
    storagePath: saved.storageRef,
    sourceUrl: saved.url,
    mediaType: mediaTypeForFile(file),
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
