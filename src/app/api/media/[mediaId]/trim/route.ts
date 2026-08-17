import { NextResponse } from "next/server";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { getMediaBytes } from "@/lib/media";
import { getStorageAdapter, randomFileKey } from "@/lib/storage";
import { trimVideo, getVideoDurationSeconds } from "@/lib/video";
import { rateLimit } from "@/lib/rateLimit";

// Manual trim of a generated video. Deliberately does NOT re-run the AI:
// this is the client saying "the automatic cut was wrong, use this range
// instead", so re-analysing would just fight their decision — and it keeps
// the edit fast and free.
export async function POST(request: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  if (!rateLimit(`trim:${account.id}`, 20, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many edits at once. Wait a moment and try again." }, { status: 429 });
  }

  const { mediaId } = await params;
  const media = await prisma.media.findFirst({ where: { id: mediaId, accountId: account.id } });
  if (!media) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (media.mediaType !== "video") {
    return NextResponse.json({ error: "Only videos can be trimmed." }, { status: 400 });
  }

  const body = await request.json();
  const startSeconds = typeof body.startSeconds === "number" ? Math.max(0, body.startSeconds) : 0;
  const endSeconds = typeof body.endSeconds === "number" ? body.endSeconds : null;
  if (endSeconds === null || endSeconds - startSeconds < 0.5) {
    return NextResponse.json({ error: "Choose a range of at least half a second." }, { status: 400 });
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-trim-"));
  try {
    const sourcePath = path.join(tmpDir, "source.mp4");
    await writeFile(sourcePath, await getMediaBytes(media));

    // Clamp to the real duration — a start past the end yields a zero-length
    // file that ffmpeg reports as success.
    const actualDuration = await getVideoDurationSeconds(sourcePath).catch(() => null);
    if (actualDuration !== null && startSeconds >= actualDuration) {
      return NextResponse.json({ error: "Start point is past the end of the video." }, { status: 400 });
    }
    const safeEnd = actualDuration !== null ? Math.min(endSeconds, actualDuration) : endSeconds;

    const outputPath = path.join(tmpDir, "trimmed.mp4");
    await trimVideo({ sourcePath, startSeconds, endSeconds: safeEnd, outputPath });

    const trimmed = await readFile(outputPath);
    // New filename so the browser can't serve the previous cut from cache.
    const key = randomFileKey(media.eventId, `edit-${media.id}-${Date.now()}.mp4`);
    const saved = await getStorageAdapter().save(key, trimmed, "video/mp4");

    const updated = await prisma.media.update({
      where: { id: mediaId },
      data: {
        storagePath: saved.storageRef,
        sourceUrl: saved.url,
        // Keep the stored range meaningful for anything that derives a
        // duration from it (the music picker's selection window does).
        clipStartSeconds: 0,
        clipEndSeconds: safeEnd - startSeconds,
      },
    });

    return NextResponse.json({
      sourceUrl: updated.sourceUrl,
      durationSeconds: safeEnd - startSeconds,
    });
  } catch (err) {
    console.error("[trim] failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't trim that video. Try again." },
      { status: 500 },
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
