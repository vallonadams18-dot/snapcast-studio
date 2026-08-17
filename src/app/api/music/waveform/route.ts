import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/auth";

// Proxies Epidemic's waveform JSON. Fetching it directly from the browser
// would be a cross-origin request against a host we don't control, so this
// keeps the scrub UI working regardless of their CORS policy.
export async function GET(request: Request) {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const url = new URL(request.url).searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  // Only ever fetch from Epidemic's CDN — without this the endpoint is an
  // open proxy that could be pointed at internal addresses.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".epidemicsound.com")) {
    return NextResponse.json({ error: "unsupported host" }, { status: 400 });
  }

  const response = await fetch(parsed.toString());
  if (!response.ok) {
    return NextResponse.json({ error: "waveform unavailable" }, { status: 502 });
  }

  return NextResponse.json(await response.json());
}
