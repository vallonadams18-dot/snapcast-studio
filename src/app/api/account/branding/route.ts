import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";

const POSITIONS = ["bottom-right", "bottom-left", "top-right", "top-left"];

export async function POST(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await request.json();

  // Only apply fields the client actually sent, so the branding panel can
  // PATCH one toggle without clobbering the others.
  const data: Record<string, unknown> = {};
  if (typeof body.introEnabled === "boolean") data.introEnabled = body.introEnabled;
  if (typeof body.outroEnabled === "boolean") data.outroEnabled = body.outroEnabled;
  if (typeof body.outroText === "string") data.outroText = body.outroText.trim().slice(0, 60) || null;
  if (typeof body.watermarkEnabled === "boolean") data.watermarkEnabled = body.watermarkEnabled;
  if (typeof body.watermarkPosition === "string" && POSITIONS.includes(body.watermarkPosition)) {
    data.watermarkPosition = body.watermarkPosition;
  }
  if (typeof body.watermarkOpacity === "number") {
    data.watermarkOpacity = Math.min(1, Math.max(0.05, body.watermarkOpacity));
  }
  if (typeof body.brandLogoUrl === "string") {
    data.brandLogoUrl = body.brandLogoUrl.trim() || null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const updated = await prisma.account.update({ where: { id: account.id }, data });

  return NextResponse.json({
    introEnabled: updated.introEnabled,
    outroEnabled: updated.outroEnabled,
    outroText: updated.outroText,
    watermarkEnabled: updated.watermarkEnabled,
    watermarkPosition: updated.watermarkPosition,
    watermarkOpacity: updated.watermarkOpacity,
    brandLogoUrl: updated.brandLogoUrl,
    // The UI needs to know a logo exists — every branding feature is inert
    // without one, and silently doing nothing is the confusing case.
    hasLogo: Boolean(updated.brandLogoUrl),
  });
}
