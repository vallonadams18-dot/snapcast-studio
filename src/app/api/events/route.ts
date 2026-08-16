import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { consumeEventCredit } from "@/lib/usage";

const EVENT_TYPES = ["wedding", "corporate", "birthday", "other"];

export async function GET() {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const events = await prisma.event.findMany({
    where: { accountId: account.id },
    orderBy: { startedAt: "desc" },
    include: { _count: { select: { media: true, drafts: true } } },
  });
  return NextResponse.json(events);
}

export async function POST(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await request.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const eventType = typeof body.eventType === "string" && EVENT_TYPES.includes(body.eventType) ? body.eventType : "other";

  if (!name) {
    return NextResponse.json({ error: "Event name is required." }, { status: 400 });
  }

  try {
    await consumeEventCredit(account.id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Out of credits." }, { status: 402 });
  }

  const event = await prisma.event.create({
    data: { accountId: account.id, name, eventType },
  });

  return NextResponse.json(event);
}
