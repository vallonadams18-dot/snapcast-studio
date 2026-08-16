import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/auth";

const TONES = ["playful", "elegant", "professional"];

export async function POST(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await request.json();
  const brandTone = typeof body.brandTone === "string" && TONES.includes(body.brandTone) ? body.brandTone : "playful";
  const brandLogoUrl = typeof body.brandLogoUrl === "string" && body.brandLogoUrl.trim() ? body.brandLogoUrl.trim() : null;
  const brandColors = Array.isArray(body.brandColors)
    ? JSON.stringify(body.brandColors.filter((c: unknown) => typeof c === "string"))
    : "[]";

  await prisma.account.update({
    where: { id: account.id },
    data: { brandTone, brandLogoUrl, brandColors },
  });

  return NextResponse.json({ ok: true });
}
