import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { eventId } = await params;
  const event = await prisma.event.findFirst({
    where: { id: eventId, accountId: account.id },
    include: { media: { orderBy: { createdAt: "desc" } } },
  });
  if (!event) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json(event);
}
