import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";

export async function GET() {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const saved = await prisma.savedTrack.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ saved });
}

// Favorite / unfavorite. Idempotent in both directions so a double-tap on a
// flaky connection can't leave the heart out of sync with the database.
export async function POST(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await request.json();
  const trackId = typeof body.trackId === "string" ? body.trackId : null;
  if (!trackId) return NextResponse.json({ error: "trackId required" }, { status: 400 });

  if (body.saved === false) {
    await prisma.savedTrack.deleteMany({ where: { accountId: account.id, trackId } });
    return NextResponse.json({ saved: false });
  }

  await prisma.savedTrack.upsert({
    where: { accountId_trackId: { accountId: account.id, trackId } },
    create: {
      accountId: account.id,
      trackId,
      title: typeof body.title === "string" ? body.title : "Untitled",
      artist: typeof body.artist === "string" ? body.artist : null,
      lengthSeconds: typeof body.lengthSeconds === "number" ? Math.round(body.lengthSeconds) : null,
      waveformUrl: typeof body.waveformUrl === "string" ? body.waveformUrl : null,
    },
    update: {},
  });
  return NextResponse.json({ saved: true });
}
