import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAdmin } from "@/lib/auth";
import { logAdminAction } from "@/lib/audit";

export async function POST(request: Request) {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await request.json();
  const key = typeof body.key === "string" ? body.key : null;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
  if (!key || enabled === null) return NextResponse.json({ error: "key and enabled are required" }, { status: 400 });

  const flag = await prisma.featureFlag.upsert({
    where: { key },
    create: { key, enabled },
    update: { enabled },
  });

  await logAdminAction({
    actorAccountId: admin.id,
    action: "feature_flag_toggle",
    detail: `${key} → ${enabled ? "on" : "off"}`,
  });

  return NextResponse.json(flag);
}
