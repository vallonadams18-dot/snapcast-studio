import { NextResponse } from "next/server";
import { getCurrentSession, createSession, destroySession } from "@/lib/auth";
import { logAdminAction } from "@/lib/audit";

export async function POST() {
  const session = await getCurrentSession();
  if (!session || !session.impersonatedByAccountId) {
    return NextResponse.json({ error: "not currently impersonating" }, { status: 400 });
  }

  const adminAccountId = session.impersonatedByAccountId;
  const impersonatedAccountId = session.accountId;

  await destroySession();
  await createSession(adminAccountId);
  await logAdminAction({
    actorAccountId: adminAccountId,
    targetAccountId: impersonatedAccountId,
    action: "impersonate_end",
  });

  return NextResponse.json({ ok: true });
}
