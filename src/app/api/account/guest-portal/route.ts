import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";

export async function POST(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await request.json();
  const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
  if (enabled === null) return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });

  const updated = await prisma.account.update({
    where: { id: account.id },
    data: { guestPortalEnabled: enabled },
  });

  return NextResponse.json({ guestPortalEnabled: updated.guestPortalEnabled });
}
