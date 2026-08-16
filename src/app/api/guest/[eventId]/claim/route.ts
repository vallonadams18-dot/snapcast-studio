import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientIp } from "@/lib/rateLimit";

export async function POST(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  if (!rateLimit(`guest-claim:${clientIp(request)}`, 30, 60 * 1000)) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  const { eventId } = await params;
  const event = await prisma.event.findUnique({ where: { id: eventId }, include: { account: true } });
  if (!event || !event.account.guestPortalEnabled) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await request.json();
  const mediaId = typeof body.mediaId === "string" ? body.mediaId : null;
  if (!mediaId) return NextResponse.json({ error: "mediaId is required" }, { status: 400 });

  const media = await prisma.media.findFirst({ where: { id: mediaId, eventId } });
  if (!media) return NextResponse.json({ error: "media not found" }, { status: 404 });

  const guestName = typeof body.guestName === "string" ? body.guestName.slice(0, 200) : null;
  const guestContact = typeof body.guestContact === "string" ? body.guestContact.slice(0, 200) : null;

  const claim = await prisma.guestClaim.create({
    data: { accountId: event.accountId, eventId, mediaId, guestName, guestContact },
  });

  return NextResponse.json({ ok: true, claimId: claim.id });
}
