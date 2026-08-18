import { NextResponse } from "next/server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { getTrackById } from "@/lib/musicCatalog";
import { mixTrackIntoClip } from "@/lib/music";
import { getMediaBytes } from "@/lib/media";
import { getStorageAdapter, randomFileKey } from "@/lib/storage";
import { rateLimit } from "@/lib/rateLimit";
import { getVideoDurationSeconds } from "@/lib/video";

export async function POST(request: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { mediaId } = await params;
  const media = await prisma.media.findFirst({ where: { id: mediaId, accountId: account.id } });
  if (!media) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await request.json();

  // Two ways to set music:
  //  - trackId: a broad catalog category (the quick-swap chips)
  //  - libraryTrackId: a specific Epidemic track the client picked from the
  //    library, optionally with a start point they dragged on the waveform
  const trackId = typeof body.trackId === "string" ? body.trackId : null;
  const libraryTrackId = typeof body.libraryTrackId === "string" ? body.libraryTrackId : null;
  const libraryTrackTitle = typeof body.libraryTrackTitle === "string" ? body.libraryTrackTitle : null;
  const startSeconds = typeof body.startSeconds === "number" && body.startSeconds >= 0 ? body.startSeconds : null;

  if (!libraryTrackId && (!trackId || !getTrackById(trackId))) {
    return NextResponse.json({ error: "unknown track" }, { status: 400 });
  }

  // Swapping tracks re-downloads + re-mixes audio when a licensed library is
  // connected — bound how often that can happen per account.
  if (!rateLimit(`music-mix:${account.id}`, 15, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many music swaps at once. Wait a few minutes and try again." }, { status: 429 });
  }

  let storagePath = media.storagePath;
  let sourceUrl = media.sourceUrl;
  let mixed = false;

  // Only GENERATED media gets its audio replaced: a cut clip (which carries a
  // time range) or a photo montage (which carries its source ids). A raw
  // upload is the client's own footage and is never overwritten — mixing a
  // track into it would re-encode and permanently replace their original.
  const isGenerated =
    media.mediaType === "video" &&
    ((media.clipStartSeconds !== null && media.clipEndSeconds !== null) || media.compiledFromMediaIds !== null);

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-music-swap-"));
  try {
    if (isGenerated) {
      // Everything from reading the bytes onward is inside this catch. A
      // missing or unreadable file must degrade to recording the client's
      // track choice, exactly as it did before — never a 500 that reads to
      // them as "the editor is broken".
      try {
        const original = await getMediaBytes(media);

        // Measure the file itself.
        //
        // This used to derive a duration from montage metadata — photo count
        // multiplied by the DEFAULT style's seconds-per-photo — which was
        // wrong for every style except cinematic and ignored transition
        // overlap entirely. An 8-photo "punchy" montage really runs ~11s but
        // was computed as 25.6s, so the swapped track kept playing for about
        // fourteen seconds after the picture had ended.
        //
        // The rendered file already knows its own length. Ask it.
        const probePath = path.join(tmpDir, "current.mp4");
        await writeFile(probePath, original);
        const duration = await getVideoDurationSeconds(probePath).catch(() => null);

        if (duration !== null && duration > 0) {
          const result = await mixTrackIntoClip(
            original,
            trackId ?? media.musicTrack ?? "cinematic",
            duration,
            libraryTrackId,
            startSeconds,
          );
          if (result) {
            // Cache-bust on the filename: the browser has the old mix cached
            // at the previous URL, and reusing it would play the old audio.
            const key = randomFileKey(media.eventId, `clip-${media.id}-${Date.now()}.mp4`);
            const saved = await getStorageAdapter().save(key, result, "video/mp4");
            storagePath = saved.storageRef;
            sourceUrl = saved.url;
            mixed = true;
          }
        } else {
          console.error("[music] Could not measure media duration, keeping tag-only", mediaId);
        }
      } catch (err) {
        console.error("[music] Track swap mix failed, keeping tag-only", err);
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const updated = await prisma.media.update({
    where: { id: mediaId },
    data: {
      ...(trackId ? { musicTrack: trackId } : {}),
      musicTrackId: libraryTrackId,
      musicTrackTitle: libraryTrackTitle,
      musicStartSeconds: startSeconds,
      storagePath,
      sourceUrl,
    },
  });

  return NextResponse.json({
    musicTrack: updated.musicTrack,
    musicTrackId: updated.musicTrackId,
    musicTrackTitle: updated.musicTrackTitle,
    sourceUrl: updated.sourceUrl,
    mixed,
  });
}
