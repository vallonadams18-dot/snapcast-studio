import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { regenerateCaption, type Platform } from "@/lib/ai";
import { rateLimit } from "@/lib/rateLimit";
import { logUsageEvent } from "@/lib/usage";

export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  if (!rateLimit(`regenerate:${account.id}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many regenerations at once. Wait a few minutes and try again." }, { status: 429 });
  }

  const { draftId } = await params;
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { media: true, event: true },
  });
  if (!draft || draft.accountId !== account.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const generatedCaption = await regenerateCaption(draft.media, draft.event, account, draft.platform as Platform);
    await logUsageEvent(account.id, "regenerate");
    const updated = await prisma.draft.update({
      where: { id: draftId },
      data: { generatedCaption, status: "pending", editedCaption: null },
    });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Couldn't generate a new draft right now. Try again in a moment." },
      { status: 500 },
    );
  }
}
