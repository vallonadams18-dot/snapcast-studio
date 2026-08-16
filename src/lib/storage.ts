import { randomUUID } from "node:crypto";

export interface SavedFile {
  /** Publicly-fetchable URL (relative for local disk, absolute for S3/R2) — stored as Media.sourceUrl. */
  url: string;
  /** How to read the bytes back later — a disk path for local, the same absolute URL for S3/R2 — stored as Media.storagePath. */
  storageRef: string;
}

export interface StorageAdapter {
  /** Saves a file under `key` (e.g. "<eventId>/<filename>"). */
  save(key: string, buffer: Buffer, contentType: string): Promise<SavedFile>;
}

// Local disk — writes into public/uploads and returns a same-origin URL that
// Next's static file server handles for free. This is today's default.
class LocalDiskAdapter implements StorageAdapter {
  async save(key: string, buffer: Buffer): Promise<SavedFile> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");

    const diskPath = path.join(process.cwd(), "public", "uploads", key);
    await mkdir(path.dirname(diskPath), { recursive: true });
    await writeFile(diskPath, buffer);
    return { url: `/uploads/${key}`, storageRef: diskPath };
  }
}

// S3-compatible — works for both Amazon S3 and Cloudflare R2 (R2 exposes an
// S3-compatible API; point STORAGE_S3_ENDPOINT at the R2 account endpoint
// and this needs no other changes). Activated by setting STORAGE_PROVIDER=s3
// plus the env vars below — inert (never constructed) until then.
class S3CompatibleAdapter implements StorageAdapter {
  async save(key: string, buffer: Buffer, contentType: string): Promise<SavedFile> {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");

    const bucket = process.env.STORAGE_S3_BUCKET;
    const publicBaseUrl = process.env.STORAGE_S3_PUBLIC_URL;
    if (!bucket || !publicBaseUrl) {
      throw new Error("STORAGE_S3_BUCKET and STORAGE_S3_PUBLIC_URL are required when STORAGE_PROVIDER=s3");
    }

    const client = new S3Client({
      region: process.env.STORAGE_S3_REGION || "auto",
      endpoint: process.env.STORAGE_S3_ENDPOINT, // omit for real AWS S3; set for R2
      credentials: {
        accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY ?? "",
      },
    });

    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }),
    );

    const url = `${publicBaseUrl.replace(/\/$/, "")}/${key}`;
    return { url, storageRef: url };
  }
}

let adapter: StorageAdapter | undefined;

export function getStorageAdapter(): StorageAdapter {
  if (!adapter) {
    adapter = process.env.STORAGE_PROVIDER === "s3" ? new S3CompatibleAdapter() : new LocalDiskAdapter();
  }
  return adapter;
}

export function randomFileKey(eventId: string, originalName: string): string {
  const safeName = originalName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return `${eventId}/${randomUUID()}-${safeName}`;
}
