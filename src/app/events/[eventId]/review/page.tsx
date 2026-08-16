import { redirect, notFound } from "next/navigation";
import { getCurrentAccount } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ReviewFeed } from "./ReviewFeed";

export default async function ReviewPage({ params }: { params: Promise<{ eventId: string }> }) {
  const account = await getCurrentAccount();
  if (!account) redirect("/login");

  const { eventId } = await params;
  const event = await prisma.event.findFirst({ where: { id: eventId, accountId: account.id } });
  if (!event) notFound();

  const drafts = await prisma.draft.findMany({
    where: { eventId, accountId: account.id, status: "pending" },
    include: { media: true },
    // Group by media+platform so caption variants for the same slot stay
    // adjacent, in a stable photo-by-photo order.
    orderBy: [{ mediaId: "asc" }, { platform: "asc" }, { variantIndex: "asc" }],
  });

  return (
    <div className="mx-auto w-full max-w-md p-6 lg:max-w-5xl">
      <a href={`/events/${eventId}`} className="tap-scale inline-flex min-h-11 items-center text-sm text-neutral-500 underline">
        ← {event.name}
      </a>
      <h1 className="mt-2 text-2xl font-bold text-foreground">Review drafts</h1>
      <p className="mb-6 text-sm text-neutral-500">
        AI-generated captions for each photo. Approve, edit, or skip — these only affect the caption below, never
        your uploaded photo or video, which is always safe in the event gallery.
      </p>
      <ReviewFeed
        initialDrafts={drafts.map((d) => ({
          id: d.id,
          mediaId: d.mediaId,
          platform: d.platform,
          variantIndex: d.variantIndex,
          generatedCaption: d.generatedCaption,
          mediaUrl: d.media.sourceUrl,
          mediaType: d.media.mediaType,
          energyScore: d.media.energyScore,
          visualQualityScore: d.media.visualQualityScore,
          momentRarityScore: d.media.momentRarityScore,
          scoreSummary: d.media.scoreSummary,
        }))}
      />
    </div>
  );
}
