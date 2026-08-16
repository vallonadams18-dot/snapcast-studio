import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { GuestGallery } from "./GuestGallery";
import { isFeatureEnabled } from "@/lib/featureFlags";

export default async function GuestPortalPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;

  const [event, guestPortalGloballyEnabled] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      include: {
        account: true,
        media: { where: { status: "ready" }, orderBy: { createdAt: "desc" } },
      },
    }),
    isFeatureEnabled("guest_portal"),
  ]);

  if (!event || !event.account.guestPortalEnabled || !guestPortalGloballyEnabled) notFound();

  return (
    <div className="mx-auto w-full max-w-2xl p-6 lg:max-w-4xl">
      <div className="mb-6 text-center">
        {event.account.brandLogoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={event.account.brandLogoUrl} alt="" className="mx-auto mb-3 h-12 w-12 rounded-full object-cover" />
        )}
        <h1 className="text-2xl font-bold text-foreground">{event.name}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Your photos from tonight, courtesy of {event.account.businessName}. Tap any photo to save or share it.
        </p>
      </div>

      <GuestGallery
        eventId={event.id}
        businessName={event.account.businessName}
        media={event.media.map((m) => ({ id: m.id, sourceUrl: m.sourceUrl, mediaType: m.mediaType }))}
      />

      <p className="mt-8 text-center text-xs text-neutral-500">
        Powered by <span className="font-medium text-primary-pink">Snapcast Studio</span>
      </p>
    </div>
  );
}
