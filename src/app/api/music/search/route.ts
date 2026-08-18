import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/auth";
import { searchLibrary, type LibrarySearchOptions } from "@/lib/music";
import { rateLimit } from "@/lib/rateLimit";

const VOCAL_MODES = ["any", "vocals", "instrumental"] as const;

export async function GET(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  // Default is VOCALS, not "any" — see searchLibrary.
  // Search is cheap but proxies a third-party API — keep one client from
  // hammering it with a keystroke-per-request UI bug.
  if (!rateLimit(`music-search:${account.id}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
  }

  const url = new URL(request.url);
  const term = url.searchParams.get("q") ?? "";
  const vocalsParam = url.searchParams.get("vocals");

  const options: LibrarySearchOptions = {
    mood: url.searchParams.get("mood"),
    genre: url.searchParams.get("genre"),
    // Defaults to VOCALS when unspecified. Event recaps are social videos;
    // "any" returned a wall of instrumentals because that is what the
    // catalog is mostly made of.
    vocals: (VOCAL_MODES as readonly string[]).includes(vocalsParam ?? "")
      ? (vocalsParam as LibrarySearchOptions["vocals"])
      : "vocals",
    limit: 40,
  };

  try {
    const { tracks, moods, genres } = await searchLibrary(term, options);
    // Facets come back with the results so the browse chips reflect what is
    // actually in the catalog for this query, rather than a hardcoded list
    // that can drift out of date.
    return NextResponse.json({ tracks, moods, genres });
  } catch (err) {
    // Surface the real reason. This used to swallow failures and return an
    // empty array, so an expired API key was indistinguishable from a search
    // that genuinely had no matches.
    const message = err instanceof Error ? err.message : "Couldn't reach the music library.";
    console.error("[music] search request failed", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
