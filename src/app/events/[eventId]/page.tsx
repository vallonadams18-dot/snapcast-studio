import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { getCurrentAccount } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { UploadForm } from "./UploadForm";
import { GuestLinkInfo } from "./GuestLinkInfo";
import { BlogPostSection } from "./BlogPostSection";
import { PhotoMontageButton } from "./PhotoMontageButton";
import { MediaGrid } from "./MediaGrid";
import { suggestStyleForEventType, getMontageStyle } from "@/lib/montageStyles";

// How long a generated video runs — the music picker needs this to show the
// right selection window on the waveform. Clips carry an explicit range;
// montages are derived from photo count and the style's pacing.
function mediaDurationSeconds(m: {
  clipStartSeconds: number | null;
  clipEndSeconds: number | null;
  compiledFromMediaIds: string | null;
}): number {
  if (m.clipStartSeconds !== null && m.clipEndSeconds !== null) {
    return m.clipEndSeconds - m.clipStartSeconds;
  }
  if (m.compiledFromMediaIds) {
    try {
      const ids = JSON.parse(m.compiledFromMediaIds) as string[];
      return ids.length * getMontageStyle(null).secondsPerPhoto;
    } catch {
      return 15;
    }
  }
  return 15;
}

export default async function EventPage({ params }: { params: Promise<{ eventId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) redirect("/login");

  const { eventId } = await params;
  const event = await prisma.event.findFirst({
    where: { id: eventId, accountId: account.id },
    include: { media: { orderBy: { createdAt: "desc" } }, blogPost: true },
  });
  if (!event) notFound();

  const pendingCount = await prisma.draft.count({ where: { eventId, status: "pending" } });
  const approvedCount = await prisma.draft.count({
    where: { eventId, status: { in: ["approved", "edited"] } },
  });
  const readyPhotoCount = event.media.filter((m) => m.mediaType === "photo" && m.status === "ready").length;

  const headerList = await headers();
  const origin = `${headerList.get("x-forwarded-proto") ?? "http"}://${headerList.get("host")}`;

  return (
    <div className="mx-auto w-full max-w-2xl p-6 lg:max-w-4xl">
      <Link href="/" className="tap-scale inline-flex min-h-11 items-center text-sm text-neutral-500 underline">
        ← All events
      </Link>
      <h1 className="mb-1 mt-2 text-2xl font-bold text-foreground">{event.name}</h1>
      <p className="mb-6 text-sm capitalize text-neutral-500">{event.eventType} event</p>

      <UploadForm eventId={event.id} />

      {account.guestPortalEnabled && <GuestLinkInfo guestUrl={`${origin}/guest/${event.id}`} />}

      <BlogPostSection eventId={event.id} initialPost={event.blogPost} />

      <PhotoMontageButton
        eventId={event.id}
        readyPhotoCount={readyPhotoCount}
        suggestedStyleId={suggestStyleForEventType(event.eventType).id}
      />

      {pendingCount > 0 && (
        <a
          href={`/events/${event.id}/review`}
          className="tap-scale mt-4 block rounded-lg bg-gradient-to-r from-primary-purple to-primary-pink px-4 py-3 text-center font-semibold text-white shadow-md shadow-primary-pink/20"
        >
          Review drafts ({pendingCount} waiting)
        </a>
      )}

      {approvedCount > 0 && (
        <a
          href={`/events/${event.id}/approved`}
          className="tap-scale mt-2 block rounded-lg border border-border bg-surface px-4 py-3 text-center font-medium text-foreground hover:border-primary-pink"
        >
          Approved content ({approvedCount}) — download &amp; post
        </a>
      )}

      <h2 className="mb-3 mt-8 text-sm font-medium text-neutral-500">Media</h2>
      <MediaGrid
        media={event.media.map((m) => ({
          id: m.id,
          sourceUrl: m.sourceUrl,
          mediaType: m.mediaType,
          sourceMediaId: m.sourceMediaId,
          compiledFromMediaIds: m.compiledFromMediaIds,
          musicTrack: m.musicTrack,
          musicTrackTitle: m.musicTrackTitle,
          durationSeconds: mediaDurationSeconds(m),
        }))}
      />
    </div>
  );
}

