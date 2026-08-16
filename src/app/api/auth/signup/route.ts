import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSession, hashPassword } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export async function POST(request: Request) {
  if (!rateLimit(`signup:${clientIp(request)}`, 5, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many signup attempts. Try again later." }, { status: 429 });
  }

  const body = await request.json();
  const businessName = typeof body.businessName === "string" ? body.businessName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!businessName || !email || password.length < 8) {
    return NextResponse.json(
      { error: "Business name, email, and an 8+ character password are required." },
      { status: 400 },
    );
  }

  const existing = await prisma.account.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "An account with that email already exists." }, { status: 409 });
  }

  const account = await prisma.account.create({
    data: { businessName, email, passwordHash: hashPassword(password) },
  });

  await createSession(account.id);
  return NextResponse.json({ ok: true });
}
