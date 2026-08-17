import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import { getCurrentAccount } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { UploadForm } from "./UploadForm";
import { EmptyState } from "@/components/States";
import { GuestLinkInfo } from "./GuestLinkInfo";
import { VideoClipButton } from "./VideoClipButton";
import { MusicPicker } from "./MusicPicker";
import { BlogPostSection } from "./BlogPostSection";
import { PhotoMontageButton } from "./PhotoMontageButton";
import { suggestStyleForEventType } from "@/lib/montageStyles";

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
      <a href="/" className="tap-scale inline-flex min-h-11 items-center text-sm text-neutral-500 underline">
        ← All events
      </a>
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

      <h2 className="mb-3 mt-8 text-sm font-medium text-neutral-500">Uploaded media</h2>
      {event.media.length === 0 ? (
        <EmptyState
          title="No uploads yet"
          description="Upload photos or video above to generate your first drafts."
        />
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {event.media.map((m) => (
            <div key={m.id} className="relative aspect-square overflow-hidden rounded-xl border border-border bg-surface">
              {m.mediaType === "photo" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.sourceUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <video src={m.sourceUrl} className="h-full w-full object-cover" muted />
              )}
              {(m.sourceMediaId || m.compiledFromMediaIds) && (
                <>
                  <span className="absolute left-1 top-1 rounded-lg bg-primary-pink/90 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    {m.compiledFromMediaIds ? "Photo video" : "Clip"}
                  </span>
                  <div className="absolute inset-x-0 bottom-0 p-1">
                    <MusicPicker mediaId={m.id} currentTrackId={m.musicTrack} />
                  </div>
                </>
              )}
              {m.mediaType === "video" && !m.sourceMediaId && !m.compiledFromMediaIds && <VideoClipButton mediaId={m.id} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
