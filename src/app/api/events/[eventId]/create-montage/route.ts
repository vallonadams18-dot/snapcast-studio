import { NextResponse } from "next/server";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { getMediaBytes } from "@/lib/media";
import { getStorageAdapter, randomFileKey } from "@/lib/storage";
import {
  createPhotoMontage,
  getVideoDurationSeconds,
  getVideoFrameRate,
  finalizeForDelivery,
} from "@/lib/video";
import { buildEditPlan, describeEditPlan, planDurationSeconds } from "@/lib/editPlan";
import { mixTrackIntoClip, resolveTrackForCategory } from "@/lib/music";
import { analyzeSectionEnergy } from "@/lib/audioEnergy";
import { suggestTrackForEventType } from "@/lib/musicCatalog";
import { getMontageStyle, suggestStyleForEventType, chooseAutoPreset } from "@/lib/montageStyles";
import { analyzeClip, PLATFORMS } from "@/lib/ai";
import { rateLimit } from "@/lib/rateLimit";
import { logUsageEvent } from "@/lib/usage";
import { isFeatureEnabled } from "@/lib/featureFlags";
import { addBrandBookends, applyWatermark } from "@/lib/branding";
import { selectPhotosForMontage, repositionPeak } from "@/lib/photoSelection";

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
  // What the client ASKED for. "auto" is resolved to a concrete preset only
  // after the track and energy analysis exist, because that is what it
  // chooses from — see below.
  const requestedStyle =
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
    let selection = await selectPhotosForMontage(candidates, MAX_PHOTOS, resolvePath);
    const selected = selection.selected.map((s) => s.candidate);

    if (selected.length < MIN_PHOTOS) {
      return NextResponse.json(
        { error: `Need at least ${MIN_PHOTOS} distinct photos to compile a video.` },
        { status: 400 },
      );
    }

    // Every selected photo already has a resolved path cached from hashing,
    // but re-resolving is what proves it is readable before it becomes a
    // segment.
    const pathsByMediaId = new Map<string, string>();
    for (const item of selection.selected) {
      const resolved = await resolvePath(item.candidate);
      if (resolved) pathsByMediaId.set(item.candidate.id, resolved);
    }

    const suggestedTrack = suggestTrackForEventType(event.eventType).id;

    // Resolve the ACTUAL track before planning, so its BPM can shape the
    // pacing. Auto-selection is randomised, so this same resolved track is
    // handed to the mixer below — searching a second time would score the
    // edit to one song and then play a different one.
    //
    // Failure here is not fatal. A missing key, an outage or a track with no
    // BPM simply leaves beatIntervalSeconds null, the plan falls back to
    // style-only pacing, and the mixer behaves exactly as it did before.
    const track = await resolveTrackForCategory(suggestedTrack).catch(() => null);
    const beatIntervalSeconds = track?.bpm ? 60 / track.bpm : null;

    // Resolve "auto" to ONE concrete preset BEFORE any music analysis: the
    // energy window is derived from the preset's real pacing, and Auto's
    // 2.8s placeholder analysed a section up to twice the montage's actual
    // length when Hype (1.4s/photo) was then chosen — the picked peak could
    // sit outside the audio that ends up in the video. The heuristic only
    // needs event type, BPM and the photo set, all of which exist here.
    let style = requestedStyle;
    if (requestedStyle.id === "auto") {
      const scores = selection.selected.map(
        (s) =>
          (s.candidate.energyScore ?? 0) +
          (s.candidate.visualQualityScore ?? 0) +
          (s.candidate.momentRarityScore ?? 0),
      );
      const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
      const scoreVariance = scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, scores.length);
      const auto = chooseAutoPreset({
        eventType: event.eventType,
        bpm: track?.bpm ?? null,
        energyPeakFraction: null,
        photoCount: selection.selected.length,
        scoreVariance,
      });
      style = auto.style;
      console.log(`[preset] AI Auto chose ${style.name} — ${auto.reason}`);
    }

    // Find where the music's energy peaks inside the section we'll use, so
    // the strongest VISUAL moment can sit on the strongest AUDIO moment.
    // Waveform-only — needs no audio download, so the 402 doesn't block it.
    // The window length now comes from the CONCRETE preset's pacing, never
    // the auto placeholder.
    const estimatedLength = selection.selected.length * style.secondsPerPhoto;
    const energy = await analyzeSectionEnergy({
      waveformUrl: track?.waveformUrl,
      trackLengthSeconds: track?.lengthSeconds,
      windowSeconds: estimatedLength,
      sectionStartSeconds: null,
    }).catch(() => null);

    if (energy) {
      // Same photos, same roles — only the peak's position moves. Hero stays
      // last by construction; analyzeSectionEnergy has already pushed a
      // final-20% maximum to an earlier region.
      selection = { ...selection, selected: repositionPeak(selection.selected, energy.peakFraction) };
      console.log(
        `[music] energy peak at +${energy.peakOffsetSeconds}s of section starting ${energy.sectionStartSeconds}s` +
          (energy.clampedFromEnd ? " (raw max was in the final 20% — clamped earlier)" : ""),
      );
    }

    // The creative decisions are all made here, and settled before ffmpeg is
    // touched. The renderer below only executes this.
    const plan = buildEditPlan({
      selection,
      style,
      pathsByMediaId,
      // startSeconds null means "let the high-energy picker choose at mix
      // time" — the behaviour Phase 1 shipped.
      music: {
        catalogId: suggestedTrack,
        trackId: track?.id ?? null,
        title: track?.title ?? null,
        // Pinned at plan time when analysis succeeded, so the section whose
        // energy shaped the visual peak is the section that actually plays.
        // Null falls back to the mixer's own picker, as before.
        startSeconds: energy?.sectionStartSeconds ?? null,
        bpm: track?.bpm ?? null,
        beatIntervalSeconds,
        energyPeakOffsetSeconds: energy?.peakOffsetSeconds ?? null,
      },
    });

    // Answers "why did Snapcast make this edit?" — roles, order, durations,
    // camera moves and transitions, with no storage paths.
    console.log(describeEditPlan(plan));

    const montagePath = path.join(tmpDir, "montage.mp4");
    await createPhotoMontage({ plan, outputPath: montagePath });

    let montageBuffer = await readFile(montagePath);

    const brandAssets = {
      logoUrl: account.brandLogoUrl,
      logoStorageRef: account.brandLogoAssetPath,
      brandColorsJson: account.brandColors,
      businessName: account.businessName,
    };

    // Bookends go on BEFORE the music so the track plays across the intro/
    // outro too, rather than starting abruptly after them. Uploaded Brand
    // Kit media wins; the legacy generated logo cards remain the fallback.
    const branded = await addBrandBookends(montageBuffer, brandAssets, {
      intro: account.introEnabled,
      outro: account.outroEnabled,
      outroText: account.outroText,
      introMedia: { kind: account.introKind, storageRef: account.introAssetPath },
      outroMedia: { kind: account.outroKind, storageRef: account.outroAssetPath },
    });
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
    // Rough bookend allowance for the probe-failure fallback only — the
    // probe below measures the real file, which is what actually ships.
    const predictedDuration =
      planDurationSeconds(plan.segments) +
      (branded
        ? (account.introKind !== "none" || account.introEnabled ? 2 : 0) +
          (account.outroKind !== "none" || account.outroEnabled ? 2.5 : 0)
        : 0);
    const totalDuration = await getVideoDurationSeconds(measuredPath).catch(() => predictedDuration);

    // The SAME track object whose BPM shaped the pacing above.
    // Frame-rate checkpoints. Every h264 stage is meant to deliver 30fps; a
    // wrong rate at the end says nothing about which stage caused it.
    const probeFps = async (label: string, buffer?: Buffer) => {
      let target = montagePath;
      if (buffer) {
        target = path.join(tmpDir, `fps-${label}.mp4`);
        await writeFile(target, buffer);
      }
      console.log(`[fps] ${label}: ${(await getVideoFrameRate(target).catch(() => null)) ?? "unknown"} fps`);
    };
    // The SAME track object whose BPM shaped the pacing above.
    const mixed = await mixTrackIntoClip(montageBuffer, suggestedTrack, totalDuration, null, plan.music?.startSeconds ?? null, track);
    // Whether the video actually has music, as opposed to whether we tried.
    // The mixer returns null for every failure — no provider configured, the
    // provider unreachable, or the licence not permitting a download — and
    // without surfacing that, a silent video is indistinguishable from one
    // the client simply didn't notice the music in.
    const musicMixed = Boolean(mixed);
    console.log(
      `[music] planned with track=${track?.id ?? "none"} bpm=${track?.bpm ?? "unknown"} ` +
        `beat=${beatIntervalSeconds ? `${beatIntervalSeconds.toFixed(3)}s` : "n/a"} | ` +
        `mixed track=${track?.id ?? "resolved-at-mix"}`,
    );
    if (mixed) montageBuffer = mixed;

    if (account.watermarkEnabled) {
      const marked = await applyWatermark(
        montageBuffer,
        brandAssets,
        { position: account.watermarkPosition, opacity: account.watermarkOpacity, scale: account.watermarkScale },
        "video",
      );
      if (marked) montageBuffer = marked;
    }
    await probeFps("4-finalDelivered", montageBuffer);

    // The opening shot doubles as the representative frame for caption and
    // score generation — no separate frame extraction needed. It is also the
    // right choice: the opener is the highest-energy photo, so the caption is
    // written about the moment the video actually leads with.
    const representativeFrame = await getMediaBytes(selected[0]);
    const analysis = await analyzeClip(selected[0], event, account, representativeFrame);
    await logUsageEvent(account.id, "montage");

    // Delivery encoding was only ever applied by OPTIONAL stages — the music
    // mix and the watermark. With no logo and the music provider returning
    // 402, every one of them skips and the file shipped as a raw intermediate
    // with no +faststart. This guarantees it regardless of the path taken.
    montageBuffer = await finalizeForDelivery(montageBuffer);

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
      // Non-fatal. The video is finished and usable either way; this only
      // says whether it has a soundtrack, so the client is told rather than
      // left to discover a silent video after posting it.
      musicMixed,
      musicWarning: musicMixed
        ? null
        : "Video created without music — licensed music is currently unavailable.",
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
