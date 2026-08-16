import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAdmin } from "@/lib/auth";
import { logAdminAction } from "@/lib/audit";

const TIERS = { starter: 5, growth: 15, pro: 40 } as const;

export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { accountId } = await params;
  const target = await prisma.account.findFirst({ where: { id: accountId, role: "client" } });
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await request.json();
  const tier = typeof body.tier === "string" && body.tier in TIERS ? (body.tier as keyof typeof TIERS) : null;
  const addExtraCredits = typeof body.addExtraCredits === "number" && body.addExtraCredits > 0 ? Math.floor(body.addExtraCredits) : 0;

  if (!tier && !addExtraCredits) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const updated = await prisma.account.update({
    where: { id: accountId },
    data: {
      ...(tier ? { planEventsPerMonth: TIERS[tier] } : {}),
      ...(addExtraCredits ? { extraCredits: { increment: addExtraCredits } } : {}),
    },
  });

  await logAdminAction({
    actorAccountId: admin.id,
    targetAccountId: accountId,
    action: "credit_adjustment",
    detail: [tier ? `tier → ${tier} (${TIERS[tier]}/mo)` : null, addExtraCredits ? `+${addExtraCredits} extra credits` : null]
      .filter(Boolean)
      .join(", "),
  });

  return NextResponse.json(updated);
}
