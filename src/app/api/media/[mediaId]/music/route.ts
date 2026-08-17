import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { getTrackById } from "@/lib/musicCatalog";
import { mixTrackIntoClip } from "@/lib/music";
import { getMediaBytes } from "@/lib/media";
import { getStorageAdapter, randomFileKey } from "@/lib/storage";
import { rateLimit } from "@/lib/rateLimit";
import { getMontageStyle } from "@/lib/montageStyles";

// A clip has an explicit time range; a photo montage doesn't, so its
// duration is derived from how many source photos it was compiled from.
function resolveVideoDuration(media: {
  clipStartSeconds: number | null;
  clipEndSeconds: number | null;
  compiledFromMediaIds: string | null;
}): number | null {
  if (media.clipStartSeconds !== null && media.clipEndSeconds !== null) {
    return media.clipEndSeconds - media.clipStartSeconds;
  }
  if (media.compiledFromMediaIds) {
    try {
      const ids = JSON.parse(media.compiledFromMediaIds) as string[];
      return ids.length * getMontageStyle(null).secondsPerPhoto;
    } catch {
      return null;
    }
  }
  return null;
}

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

  // Only attempt a real mix when we can work out the video's duration
  // (clip or photo montage) and a licensed library is connected —
  // otherwise this just tags the choice, same as before.
  const duration = resolveVideoDuration(media);
  let mixed = false;
  if (duration !== null) {
    try {
      const original = await getMediaBytes(media);
      const result = await mixTrackIntoClip(
        original,
        trackId ?? media.musicTrack ?? "cinematic",
        duration,
        libraryTrackId,
        startSeconds,
      );
      if (result) {
        // Cache-bust on the filename: the browser has the old mix cached at
        // the previous URL, and reusing it would play the old audio.
        const key = randomFileKey(media.eventId, `clip-${media.id}-${Date.now()}.mp4`);
        const saved = await getStorageAdapter().save(key, result, "video/mp4");
        storagePath = saved.storageRef;
        sourceUrl = saved.url;
        mixed = true;
      }
    } catch (err) {
      console.error("[music] Track swap mix failed, keeping tag-only", err);
    }
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
