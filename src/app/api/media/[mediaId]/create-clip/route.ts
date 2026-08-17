import { NextResponse } from "next/server";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { getMediaBytes } from "@/lib/media";
import { getStorageAdapter, randomFileKey } from "@/lib/storage";
import { getVideoDurationSeconds, detectHighlightWindow, createVerticalClip } from "@/lib/video";
import { analyzeClip, PLATFORMS } from "@/lib/ai";
import { suggestTrackForEventType } from "@/lib/musicCatalog";
import { mixTrackIntoClip } from "@/lib/music";
import { rateLimit } from "@/lib/rateLimit";
import { logUsageEvent } from "@/lib/usage";
import { addBrandBookends, applyWatermark } from "@/lib/branding";
import { isFeatureEnabled } from "@/lib/featureFlags";
import { resolveFfmpegPath } from "@/lib/ffmpegPaths";
import { spawn } from "node:child_process";

// Single frame grab for the clip's representative caption/scoring image.
async function grabFrame(sourcePath: string, atSeconds: number, outPath: string) {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), ["-ss", String(atSeconds), "-i", sourcePath, "-frames:v", "1", "-q:v", "3", "-y", outPath]);
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`frame grab failed (${code})`))));
  });
}

export async function POST(_request: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  if (!(await isFeatureEnabled("video_clips"))) {
    return NextResponse.json({ error: "Clip generation is temporarily unavailable." }, { status: 503 });
  }

  // Each clip is an ffmpeg job plus a vision call — the most expensive
  // single action in the app, so it gets the tightest limit.
  if (!rateLimit(`create-clip:${account.id}`, 10, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many clips generated at once. Wait a few minutes and try again." }, { status: 429 });
  }

  const { mediaId } = await params;
  const media = await prisma.media.findFirst({ where: { id: mediaId, accountId: account.id }, include: { event: true } });
  if (!media) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (media.mediaType !== "video") {
    return NextResponse.json({ error: "Clips can only be generated from video uploads." }, { status: 400 });
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "snapcast-clip-"));
  try {
    // Local ffmpeg needs a real file on disk — for local storage that's
    // media.storagePath already; for S3/R2 we pull the bytes down first.
    let sourcePath = media.storagePath;
    if (media.storagePath.startsWith("http")) {
      const { writeFile } = await import("node:fs/promises");
      sourcePath = path.join(tmpDir, "source.mp4");
      await writeFile(sourcePath, await getMediaBytes(media));
    }

    const duration = await getVideoDurationSeconds(sourcePath);
    const window = await detectHighlightWindow(sourcePath, duration);

    const framePath = path.join(tmpDir, "representative.jpg");
    await grabFrame(sourcePath, (window.startSeconds + window.endSeconds) / 2, framePath);
    const frameBuffer = await readFile(framePath);

    const analysis = await analyzeClip(media, media.event, account, frameBuffer);
    await logUsageEvent(account.id, "clip");

    const clipPath = path.join(tmpDir, "clip.mp4");
    await createVerticalClip({
      sourcePath,
      startSeconds: window.startSeconds,
      endSeconds: window.endSeconds,
      captionText: analysis.captions.tiktok[0],
      outputPath: clipPath,
    });

    let clipBuffer = await readFile(clipPath);
    const suggestedTrack = suggestTrackForEventType(media.event.eventType).id;
    let clipDuration = window.endSeconds - window.startSeconds;

    const brandAssets = {
      logoUrl: account.brandLogoUrl,
      brandColorsJson: account.brandColors,
      businessName: account.businessName,
    };

    // Bookends before music, so the track carries across the logo cards.
    const branded = await addBrandBookends(clipBuffer, brandAssets, {
      intro: account.introEnabled,
      outro: account.outroEnabled,
      outroText: account.outroText,
    });
    if (branded) {
      clipBuffer = branded;
      clipDuration += (account.introEnabled ? 1.5 : 0) + (account.outroEnabled ? 2 : 0);
    }

    // If a licensed library is connected, mix real audio in immediately
    // rather than leaving the first cut silent-of-music until someone
    // manually swaps the track.
    const mixed = await mixTrackIntoClip(clipBuffer, suggestedTrack, clipDuration);
    if (mixed) clipBuffer = mixed;

    if (account.watermarkEnabled) {
      const marked = await applyWatermark(
        clipBuffer,
        brandAssets,
        { position: account.watermarkPosition, opacity: account.watermarkOpacity },
        "video",
      );
      if (marked) clipBuffer = marked;
    }

    const key = randomFileKey(media.eventId, `clip-${media.id}.mp4`);
    const saved = await getStorageAdapter().save(key, clipBuffer, "video/mp4");

    const clip = await prisma.media.create({
      data: {
        accountId: account.id,
        eventId: media.eventId,
        mediaType: "video",
        storagePath: saved.storageRef,
        sourceUrl: saved.url,
        status: "ready",
        sourceMediaId: media.id,
        clipStartSeconds: window.startSeconds,
        clipEndSeconds: window.endSeconds,
        musicTrack: suggestedTrack,
        ...analysis.scores,
      },
    });

    await prisma.draft.createMany({
      data: PLATFORMS.flatMap((platform) =>
        analysis.captions[platform].map((generatedCaption, variantIndex) => ({
          accountId: account.id,
          eventId: media.eventId,
          mediaId: clip.id,
          platform,
          variantIndex,
          generatedCaption,
        })),
      ),
    });

    return NextResponse.json({ clip, highlightReason: window.reason });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Clip generation failed. Try again in a moment." },
      { status: 500 },
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
