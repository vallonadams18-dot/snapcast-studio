import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { eventId } = await params;
  const drafts = await prisma.draft.findMany({
    where: { eventId, accountId: account.id, status: "pending" },
    include: { media: true },
    orderBy: [{ mediaId: "asc" }, { createdAt: "asc" }],
  });

  return NextResponse.json(drafts);
}
