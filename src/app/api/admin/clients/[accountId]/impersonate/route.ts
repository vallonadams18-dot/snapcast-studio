import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAdmin, createSession } from "@/lib/auth";
import { logAdminAction } from "@/lib/audit";

export async function POST(_request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { accountId } = await params;
  const target = await prisma.account.findFirst({ where: { id: accountId, role: "client" } });
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  await createSession(target.id, admin.id);
  await logAdminAction({
    actorAccountId: admin.id,
    targetAccountId: target.id,
    action: "impersonate_start",
    detail: `${admin.email} started viewing as ${target.email}`,
  });

  return NextResponse.json({ ok: true });
}
