import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";

const SESSION_COOKIE = "snapcast_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// A `Secure` cookie is silently DISCARDED by the browser when the page is
// served over plain http — the login "succeeds", the session row is written,
// and the user lands back on the login screen with no error to explain it.
//
// So key this off the request's actual protocol rather than NODE_ENV: a
// production box on http (no domain/cert yet) still works, and the flag
// turns itself on the moment HTTPS is put in front, with nothing to
// remember to flip. nginx supplies x-forwarded-proto (see
// deploy/nginx-snapcast.conf).
async function isHttpsRequest(): Promise<boolean> {
  const headerList = await headers();
  const proto = headerList.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  // No proxy header — only trust NODE_ENV if we're plausibly behind one.
  return process.env.NODE_ENV === "production" && process.env.ASSUME_HTTPS === "true";
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;

  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export async function createSession(accountId: string, impersonatedByAccountId?: string) {
  const session = await prisma.session.create({
    data: { accountId, expiresAt: new Date(Date.now() + SESSION_TTL_MS), impersonatedByAccountId },
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: await isHttpsRequest(),
    path: "/",
    expires: session.expiresAt,
  });

  return session;
}

export async function destroySession() {
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE)?.value;
  if (sessionId) {
    await prisma.session.deleteMany({ where: { id: sessionId } });
  }
  store.delete(SESSION_COOKIE);
}

export async function getCurrentSession() {
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { account: true },
  });
  if (!session || session.expiresAt < new Date()) return null;

  return session;
}

export async function getCurrentAccount() {
  const session = await getCurrentSession();
  return session?.account ?? null;
}

// Gates /admin — returns null for any non-admin account, including a
// perfectly valid client session, so client and admin access never overlap.
export async function getCurrentAdmin() {
  const account = await getCurrentAccount();
  return account?.role === "admin" ? account : null;
}
