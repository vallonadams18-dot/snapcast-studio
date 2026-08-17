import { redirect, notFound } from "next/navigation";
import { getCurrentAccount } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { EmptyState } from "@/components/States";
import { ApprovedGallery, type ApprovedItem } from "./ApprovedGallery";

export default async function ApprovedPage({ params }: { params: Promise<{ eventId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) redirect("/login");

  const { eventId } = await params;
  const event = await prisma.event.findFirst({ where: { id: eventId, accountId: account.id } });
  if (!event) notFound();

  const drafts = await prisma.draft.findMany({
    where: { eventId, accountId: account.id, status: { in: ["approved", "edited"] } },
    include: { media: true },
    orderBy: [{ mediaId: "asc" }, { platform: "asc" }],
  });

  // One card per photo/clip, with every approved caption for it — matches how
  // you actually post: pick the asset, then grab the caption for whichever
  // platform you're posting to.
  const byMedia = new Map<string, ApprovedItem>();
  for (const draft of drafts) {
    let item = byMedia.get(draft.mediaId);
    if (!item) {
      item = {
        mediaId: draft.mediaId,
        mediaUrl: draft.media.sourceUrl,
        mediaType: draft.media.mediaType,
        isClip: Boolean(draft.media.sourceMediaId),
        isMontage: Boolean(draft.media.compiledFromMediaIds),
        captions: [],
      };
      byMedia.set(draft.mediaId, item);
    }
    item.captions.push({
      draftId: draft.id,
      platform: draft.platform,
      text: draft.editedCaption ?? draft.generatedCaption,
      wasEdited: draft.status === "edited",
    });
  }

  const items = [...byMedia.values()];

  return (
    <div className="mx-auto w-full max-w-2xl p-6 lg:max-w-4xl">
      <a
        href={`/events/${eventId}`}
        className="tap-scale inline-flex min-h-11 items-center text-sm text-neutral-500 underline"
      >
        ← {event.name}
      </a>
      <h1 className="mt-2 text-2xl font-bold text-foreground">Approved content</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Everything you&apos;ve approved for this event. Download the photo or video, copy the caption, and post.
      </p>

      {items.length === 0 ? (
        <EmptyState
          title="Nothing approved yet"
          description="Approved captions show up here with download links, so you can always find them again."
        />
      ) : (
        <ApprovedGallery items={items} />
      )}
    </div>
  );
}
