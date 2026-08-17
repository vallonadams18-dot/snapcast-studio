import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";
import { reviseCaption, type Platform } from "@/lib/ai";
import { rateLimit } from "@/lib/rateLimit";
import { logUsageEvent } from "@/lib/usage";

export async function POST(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  if (!rateLimit(`revise:${account.id}`, 30, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many changes at once. Wait a moment and try again." }, { status: 429 });
  }

  const { draftId } = await params;
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { media: true, event: true },
  });
  if (!draft || draft.accountId !== account.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await request.json();
  const guidance = typeof body.guidance === "string" ? body.guidance.trim().slice(0, 500) : "";
  if (!guidance) {
    return NextResponse.json({ error: "Tell us what to change first." }, { status: 400 });
  }

  const current = draft.editedCaption ?? draft.generatedCaption;
  const revised = await reviseCaption(
    draft.media,
    draft.event,
    account,
    draft.platform as Platform,
    current,
    guidance,
  );

  if (!revised) {
    return NextResponse.json(
      { error: "Couldn't rewrite that caption right now. Try again in a moment." },
      { status: 502 },
    );
  }

  await logUsageEvent(account.id, "regenerate");

  // Write to generatedCaption so the draft stays "pending" and the revision
  // flows through the normal approve/edit/skip path — this is a new proposal
  // to review, not an accepted edit.
  const updated = await prisma.draft.update({
    where: { id: draftId },
    data: { generatedCaption: revised, editedCaption: null, status: "pending" },
  });

  return NextResponse.json(updated);
}
