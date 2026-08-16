import { NextResponse } from "next/server";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { getMediaBytes } from "@/lib/media";
import { getStorageAdapter, randomFileKey } from "@/lib/storage";
import { createPhotoMontage, DEFAULT_MONTAGE_SECONDS_PER_PHOTO } from "@/lib/video";
import { mixTrackIntoClip } from "@/lib/music";
import { suggestTrackForEventType } from "@/lib/musicCatalog";
import { analyzeClip, PLATFORMS } from "@/lib/ai";
import { rateLimit } from "@/lib/rateLimit";
import { logUsageEvent } from "@/lib/usage";
import { isFeatureEnabled } from "@/lib/featureFlags";

const MAX_PHOTOS = 8;
const MIN_PHOTOS = 2;
const SECONDS_PER_PHOTO = DEFAULT_MONTAGE_SECONDS_PER_PHOTO;

export async function POST(_request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  if (!(await isFeatureEnabled("photo_montage"))) {
    return NextResponse.json({ error: "Photo-to-video is temporarily unavailable." }, { status: 503 });
  }

  if (!rateLimit(`create-montage:${account.id}`, 6, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many videos generated at once. Wait a few minutes and try again." }, { status: 429 });
  }

  const { eventId } = await params;
  const event = await prisma.event.findFirst({ where: { id: eventId, accountId: account.id } });
  if (!event) return NextResponse.json({ error: "not found" }, { status: 404 });

  const candidates = await prisma.media.findMany({
    where: { eventId, accountId: account.id, mediaType: "photo", status: "ready" },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  if (candidates.length < MIN_PHOTOS) {
    return NextResponse.json({ error: `Need at least ${MIN_PHOTOS} photos to compile a video.` }, { status: 400 });
  }

  // Best-scored photos first (highest combined energy/quality/rarity);
  // unscored photos (no API key connected) fall back to most recent.
  const scored = [...candidates].sort((a, b) => {
    const scoreA = (a.energyScore ?? 0) + (a.visualQualityScore ?? 0) + (a.momentRarityScore ?? 0);
    const scoreB = (b.energyScore ?? 0) + (b.visualQualityScore ?? 0) + (b.momentRarityScore ?? 0);
    return scoreB - scoreA;
  });
  const selected = scored.slice(0, MAX_PHOTOS);

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-montage-req-"));
  try {
    const photoPaths: string[] = [];
    for (const [i, photo] of selected.entries()) {
      let photoPath = photo.storagePath;
      if (photo.storagePath.startsWith("http")) {
        photoPath = path.join(tmpDir, `photo-${i}.jpg`);
        await writeFile(photoPath, await getMediaBytes(photo));
      }
      photoPaths.push(photoPath);
    }

    const montagePath = path.join(tmpDir, "montage.mp4");
    await createPhotoMontage({ photoPaths, secondsPerPhoto: SECONDS_PER_PHOTO, outputPath: montagePath });

    let montageBuffer = await readFile(montagePath);
    const suggestedTrack = suggestTrackForEventType(event.eventType).id;
    const totalDuration = selected.length * SECONDS_PER_PHOTO;

    const mixed = await mixTrackIntoClip(montageBuffer, suggestedTrack, totalDuration);
    if (mixed) montageBuffer = mixed;

    // First (best-scored) photo doubles as the representative frame for
    // caption/score generation — no separate frame extraction needed.
    const representativeFrame = await getMediaBytes(selected[0]);
    const analysis = await analyzeClip(selected[0], event, account, representativeFrame);
    await logUsageEvent(account.id, "montage");

    const key = randomFileKey(eventId, `montage-${Date.now()}.mp4`);
    const saved = await getStorageAdapter().save(key, montageBuffer, "video/mp4");

    const montage = await prisma.media.create({
      data: {
        accountId: account.id,
        eventId,
        mediaType: "video",
        storagePath: saved.storageRef,
        sourceUrl: saved.url,
        status: "ready",
        compiledFromMediaIds: JSON.stringify(selected.map((m) => m.id)),
        musicTrack: suggestedTrack,
        ...analysis.scores,
      },
    });

    await prisma.draft.createMany({
      data: PLATFORMS.flatMap((platform) =>
        analysis.captions[platform].map((generatedCaption, variantIndex) => ({
          accountId: account.id,
          eventId,
          mediaId: montage.id,
          platform,
          variantIndex,
          generatedCaption,
        })),
      ),
    });

    return NextResponse.json({ montage, photoCount: selected.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't compile a video from your photos. Try again in a moment." },
      { status: 500 },
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
