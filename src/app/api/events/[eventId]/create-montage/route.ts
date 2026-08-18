import { NextResponse } from "next/server";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { getMediaBytes } from "@/lib/media";
import { getStorageAdapter, randomFileKey } from "@/lib/storage";
import { createPhotoMontage, montageDurationSeconds, getVideoDurationSeconds } from "@/lib/video";
import { mixTrackIntoClip } from "@/lib/music";
import { suggestTrackForEventType } from "@/lib/musicCatalog";
import { getMontageStyle, suggestStyleForEventType } from "@/lib/montageStyles";
import { analyzeClip, PLATFORMS } from "@/lib/ai";
import { rateLimit } from "@/lib/rateLimit";
import { logUsageEvent } from "@/lib/usage";
import { isFeatureEnabled } from "@/lib/featureFlags";
import { addBrandBookends, applyWatermark } from "@/lib/branding";
import { selectPhotosForMontage } from "@/lib/photoSelection";

const MAX_PHOTOS = 8;
const MIN_PHOTOS = 2;

export async function POST(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
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

  // Body is optional — an omitted/!json body just means "pick for me".
  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const style =
    typeof body.styleId === "string"
      ? getMontageStyle(body.styleId)
      : suggestStyleForEventType(event.eventType);

  const candidates = await prisma.media.findMany({
    where: { eventId, accountId: account.id, mediaType: "photo", status: "ready" },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  if (candidates.length < MIN_PHOTOS) {
    return NextResponse.json({ error: `Need at least ${MIN_PHOTOS} photos to compile a video.` }, { status: 400 });
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-montage-req-"));
  try {
    // Local path for a photo, downloading first when storage is remote.
    // Cached: selection hashes each photo and the renderer then reads the
    // chosen ones, and a remote file should only ever be fetched once.
    const pathCache = new Map<string, string>();
    const resolvePath = async (photo: (typeof candidates)[number]): Promise<string | null> => {
      const cached = pathCache.get(photo.id);
      if (cached) return cached;
      let photoPath = photo.storagePath;
      if (photoPath.startsWith("http")) {
        photoPath = path.join(tmpDir, `photo-${photo.id}.jpg`);
        try {
          await writeFile(photoPath, await getMediaBytes(photo));
        } catch {
          return null;
        }
      }
      pathCache.set(photo.id, photoPath);
      return photoPath;
    };

    // Choose and sequence the photos.
    //
    // Replaces "sort by total score, take the top eight". That picked five
    // near-identical frames from a single booth session — they all score
    // alike, because scoring never compared one photo to another — and it
    // ordered them best-to-worst, so the weakest image was always the one
    // left on screen at the end, which is what a looping video rests on.
    const selection = await selectPhotosForMontage(candidates, MAX_PHOTOS, resolvePath);
    const selected = selection.selected.map((s) => s.candidate);

    if (selected.length < MIN_PHOTOS) {
      return NextResponse.json(
        { error: `Need at least ${MIN_PHOTOS} distinct photos to compile a video.` },
        { status: 400 },
      );
    }

    console.log(
      `[montage] ${selected.length} photos, ${selection.duplicatesFound} near-duplicates skipped — ` +
        selection.selected.map((s) => `${s.role}:${s.candidate.id.slice(-6)}`).join(" → "),
    );

    const photoPaths: string[] = [];
    for (const item of selection.selected) {
      const resolved = await resolvePath(item.candidate);
      if (resolved) photoPaths.push(resolved);
    }

    const montagePath = path.join(tmpDir, "montage.mp4");
    const segmentDurations = await createPhotoMontage({ photoPaths, style, outputPath: montagePath });

    let montageBuffer = await readFile(montagePath);
    const suggestedTrack = suggestTrackForEventType(event.eventType).id;

    // Bookends go on BEFORE the music so the track plays across the logo
    // cards too, rather than starting abruptly after the intro.
    const branded = await addBrandBookends(
      montageBuffer,
      { logoUrl: account.brandLogoUrl, brandColorsJson: account.brandColors, businessName: account.businessName },
      { intro: account.introEnabled, outro: account.outroEnabled, outroText: account.outroText },
    );
    if (branded) montageBuffer = branded;

    // Measure the video we are actually about to score, rather than
    // predicting a length from the style's metadata.
    //
    // A prediction cannot know whether the branded cards rendered, whether
    // xfade was available on this ffmpeg build (it silently drops to hard
    // cuts on < 4.3, which makes the montage LONGER than predicted), or how
    // the encoder rounded. Every one of those pushes the music's end away
    // from the picture's. Probing the finished file is the only figure that
    // is right in all of those cases.
    const measuredPath = path.join(tmpDir, "measured.mp4");
    await writeFile(measuredPath, montageBuffer);
    const predictedDuration =
      montageDurationSeconds(segmentDurations, style) +
      (branded ? (account.introEnabled ? 1.5 : 0) + (account.outroEnabled ? 2 : 0) : 0);
    const totalDuration = await getVideoDurationSeconds(measuredPath).catch(() => predictedDuration);

    const mixed = await mixTrackIntoClip(montageBuffer, suggestedTrack, totalDuration);
    if (mixed) montageBuffer = mixed;

    if (account.watermarkEnabled) {
      const marked = await applyWatermark(
        montageBuffer,
        { logoUrl: account.brandLogoUrl, brandColorsJson: account.brandColors, businessName: account.businessName },
        { position: account.watermarkPosition, opacity: account.watermarkOpacity },
        "video",
      );
      if (marked) montageBuffer = marked;
    }

    // The opening shot doubles as the representative frame for caption and
    // score generation — no separate frame extraction needed. It is also the
    // right choice: the opener is the highest-energy photo, so the caption is
    // written about the moment the video actually leads with.
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

    return NextResponse.json({
      montage,
      photoCount: selected.length,
      style: style.name,
      duplicatesSkipped: selection.duplicatesFound,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't compile a video from your photos. Try again in a moment." },
      { status: 500 },
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
