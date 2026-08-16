import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { getStorageAdapter, randomFileKey } from "@/lib/storage";
import { mediaTypeForFile } from "@/lib/media";
import { analyzeMedia, PLATFORMS } from "@/lib/ai";
import { logUsageEvent } from "@/lib/usage";

// Vendor-agnostic payload — accepts common field-name variants so different
// booth software (Snappic, PhotoBoothSupplyCo, etc.) can push without a
// per-vendor integration. Any sender that can POST JSON + an HMAC signature
// works here.
interface RawWebhookPayload {
  mediaUrl?: string;
  media_url?: string;
  url?: string;
  mediaType?: string;
  media_type?: string;
  type?: string;
  eventId?: string;
  event_id?: string;
}

function verifySignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signatureHeader.trim(), "utf8");

  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) return NextResponse.json({ error: "unknown account" }, { status: 404 });

  // Generous enough for booth bursts (multiple guests capturing back-to-back).
  if (!rateLimit(`webhook:${accountId}`, 120, 60 * 1000)) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  const rawBody = await request.text();
  if (!verifySignature(rawBody, request.headers.get("x-signature"), account.webhookSecret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let parsed: RawWebhookPayload;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const mediaUrl = parsed.mediaUrl ?? parsed.media_url ?? parsed.url;
  if (!mediaUrl) {
    return NextResponse.json({ error: "missing mediaUrl" }, { status: 400 });
  }
  const mediaTypeHint = parsed.mediaType ?? parsed.media_type ?? parsed.type;
  const requestedEventId = parsed.eventId ?? parsed.event_id;

  const event = requestedEventId
    ? await prisma.event.findFirst({ where: { id: requestedEventId, accountId } })
    : await prisma.event.findFirst({ where: { accountId, endedAt: null }, orderBy: { startedAt: "desc" } });

  if (!event) {
    return NextResponse.json({ error: "no active event found for this account" }, { status: 404 });
  }

  let fetched: Response;
  try {
    fetched = await fetch(mediaUrl);
    if (!fetched.ok) throw new Error();
  } catch {
    return NextResponse.json({ error: "could not download mediaUrl" }, { status: 502 });
  }

  const contentType = fetched.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await fetched.arrayBuffer());
  const filename = mediaUrl.split("/").pop() ?? "upload";
  const mediaType =
    mediaTypeHint === "video" || contentType.startsWith("video/")
      ? "video"
      : mediaTypeForFile(new File([], filename, { type: contentType }));

  const key = randomFileKey(event.id, filename);
  const saved = await getStorageAdapter().save(key, buffer, contentType);

  const media = await prisma.media.create({
    data: {
      accountId,
      eventId: event.id,
      mediaType,
      storagePath: saved.storageRef,
      sourceUrl: saved.url,
      status: "ready",
    },
  });

  // Same analysis path as a manual upload: scores land on the Media row and
  // each platform gets its full set of caption variants.
  const analysis = await analyzeMedia(media, event, account);
  await prisma.media.update({ where: { id: media.id }, data: analysis.scores });
  await logUsageEvent(accountId, "caption");
  await prisma.draft.createMany({
    data: PLATFORMS.flatMap((platform) =>
      analysis.captions[platform].map((generatedCaption, variantIndex) => ({
        accountId,
        eventId: event.id,
        mediaId: media.id,
        platform,
        variantIndex,
        generatedCaption,
      })),
    ),
  });

  return NextResponse.json({ ok: true, mediaId: media.id }, { status: 202 });
}
