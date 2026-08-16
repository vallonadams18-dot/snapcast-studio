import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSession, verifyPassword } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rateLimit";

export async function POST(request: Request) {
  if (!rateLimit(`admin-login:${clientIp(request)}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const body = await request.json();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const account = await prisma.account.findUnique({ where: { email } });
  // Same generic error whether the email doesn't exist, the password is
  // wrong, or the account simply isn't an admin — never confirm which.
  if (!account || account.role !== "admin" || !verifyPassword(password, account.passwordHash)) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  await createSession(account.id);
  return NextResponse.json({ ok: true });
}
