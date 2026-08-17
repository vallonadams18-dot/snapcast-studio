import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/auth";
import { getTrackAudioUrl } from "@/lib/music";

// Redirects to a short-lived signed audio URL so the browser's <audio> tag
// can play it. Deliberately a redirect rather than streaming the bytes
// through us: the signed URL is already time-limited, and proxying multi-MB
// audio through Node for every preview tap would be wasteful.
//
// The Epidemic API key never reaches the browser — only the signed URL does.
export async function GET(_request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { trackId } = await params;
  const url = await getTrackAudioUrl(trackId);
  if (!url) {
    return NextResponse.json({ error: "Preview unavailable for this track." }, { status: 502 });
  }

  return NextResponse.redirect(url);
}
