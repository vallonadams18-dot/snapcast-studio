import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSession, verifyPassword } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export async function POST(request: Request) {
  if (!rateLimit(`login:${clientIp(request)}`, 10, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many login attempts. Try again in a few minutes." }, { status: 429 });
  }

  const body = await request.json();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const account = await prisma.account.findUnique({ where: { email } });
  if (!account || !verifyPassword(password, account.passwordHash)) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  await createSession(account.id);
  return NextResponse.json({ ok: true });
}
