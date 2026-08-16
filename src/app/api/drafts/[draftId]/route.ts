import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";

const STATUSES = ["approved", "edited", "skipped"];

// After this many clean (un-edited) approvals in a row, we offer Trust Mode
// — the client can skip manual review on future drafts. See spec: "20-30
// clean approvals."
export const TRUST_MODE_THRESHOLD = 20;

export async function PATCH(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { draftId } = await params;
  const draft = await prisma.draft.findUnique({ where: { id: draftId } });
  if (!draft || draft.accountId !== account.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await request.json();
  const status = typeof body.status === "string" && STATUSES.includes(body.status) ? body.status : null;
  if (!status) {
    return NextResponse.json({ error: "status must be one of approved, edited, skipped" }, { status: 400 });
  }
  const editedCaption = status === "edited" && typeof body.editedCaption === "string" ? body.editedCaption : undefined;

  const updated = await prisma.draft.update({
    where: { id: draftId },
    data: { status, ...(editedCaption !== undefined ? { editedCaption } : {}) },
  });

  // Each (media, platform) pair can have multiple caption options — once one
  // is resolved (approved/edited/skipped), the sibling options are moot.
  await prisma.draft.updateMany({
    where: { mediaId: draft.mediaId, platform: draft.platform, status: "pending", id: { not: draftId } },
    data: { status: "skipped" },
  });

  // Only an unmodified approval counts as "clean" — an edit means the draft
  // needed a human fix, which resets the streak just like a skip.
  const updatedAccount = await prisma.account.update({
    where: { id: account.id },
    data: { consecutiveApprovals: status === "approved" ? { increment: 1 } : 0 },
  });

  const justCrossedThreshold =
    !updatedAccount.trustModeEnabled && updatedAccount.consecutiveApprovals === TRUST_MODE_THRESHOLD;

  return NextResponse.json({
    ...updated,
    consecutiveApprovals: updatedAccount.consecutiveApprovals,
    trustModeOfferable: justCrossedThreshold,
  });
}
