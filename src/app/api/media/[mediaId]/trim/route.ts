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

    // Measure what actually came out. The requested range and the rendered
    // file differ slightly — a re-encode lands on whole frames — and this
    // value is what the music picker's selection window is drawn from, so a
    // guess here shows the client the wrong slice of the track.
    const requestedDuration = safeEnd - startSeconds;
    const renderedDuration = await getVideoDurationSeconds(outputPath).catch(() => requestedDuration);

    // New filename so the browser can't serve the previous cut from cache.
    const key = randomFileKey(media.eventId, `edit-${media.id}-${Date.now()}.mp4`);
    const saved = await getStorageAdapter().save(key, trimmed, "video/mp4");

    // A RAW upload — not cut from anything, not compiled from photos — is
    // the customer's own footage, and the UI promises "your original uploads
    // are untouched". Trimming one must therefore CREATE a derivative row
    // rather than update in place: the old behaviour overwrote the raw row's
    // storage reference, structurally losing the original, and stamped clip
    // fields onto it — which then fooled the music route's raw-upload guard
    // into treating the original as a mixable clip.
    //
    // Generated videos (clips, montages, previous trims) keep the documented
    // replace-in-place behaviour; they are already derivatives.
    const isRawUpload = !media.sourceMediaId && !media.compiledFromMediaIds;

    if (isRawUpload) {
      const derivative = await prisma.media.create({
        data: {
          accountId: account.id,
          eventId: media.eventId,
          mediaType: "video",
          storagePath: saved.storageRef,
          sourceUrl: saved.url,
          status: "ready",
          sourceMediaId: media.id,
          clipStartSeconds: 0,
          clipEndSeconds: renderedDuration,
        },
      });
      return NextResponse.json({
        mediaId: derivative.id,
        sourceMediaId: media.id,
        sourceUrl: derivative.sourceUrl,
        durationSeconds: renderedDuration,
        isNewClip: true,
      });
    }

    const updated = await prisma.media.update({
      where: { id: mediaId },
      data: {
        storagePath: saved.storageRef,
        sourceUrl: saved.url,
        // Keep the stored range meaningful for anything that derives a
        // duration from it (the music picker's selection window does).
        clipStartSeconds: 0,
        clipEndSeconds: renderedDuration,
      },
    });

    return NextResponse.json({
      mediaId: updated.id,
      sourceUrl: updated.sourceUrl,
      durationSeconds: renderedDuration,
      isNewClip: false,
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
