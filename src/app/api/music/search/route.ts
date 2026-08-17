import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/auth";
import { searchLibrary } from "@/lib/music";
import { rateLimit } from "@/lib/rateLimit";

export async function GET(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  // Search is cheap but proxies a third-party API — keep one client from
  // hammering it with a keystroke-per-request UI bug.
  if (!rateLimit(`music-search:${account.id}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
  }

  const term = new URL(request.url).searchParams.get("q") ?? "";
  const tracks = await searchLibrary(term);
  return NextResponse.json({ tracks });
}
