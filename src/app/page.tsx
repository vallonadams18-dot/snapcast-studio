import { redirect } from "next/navigation";
import { getCurrentAccount } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NewEventForm } from "./NewEventForm";
import { EmptyState } from "@/components/States";

export default async function DashboardPage() {
  const account = await getCurrentAccount();
  if (!account) redirect("/login");

  const events = await prisma.event.findMany({
    where: { accountId: account.id },
    orderBy: { startedAt: "desc" },
    include: { _count: { select: { media: true, drafts: true } } },
  });

  return (
    <div className="mx-auto w-full max-w-2xl p-6 lg:max-w-4xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="bg-gradient-to-r from-primary-purple to-primary-pink bg-clip-text text-2xl font-bold text-transparent">
            Snapcast Studio
          </h1>
          <p className="text-sm text-neutral-500">{account.businessName}</p>
        </div>
        <div className="flex items-center gap-4">
          <a href="/settings" className="tap-scale text-sm text-neutral-500 underline">
            Settings
          </a>
          <form
            action={async () => {
              "use server";
              const { destroySession } = await import("@/lib/auth");
              await destroySession();
              redirect("/login");
            }}
          >
            <button type="submit" className="tap-scale text-sm text-neutral-500 underline">
              Log out
            </button>
          </form>
        </div>
      </div>

      <NewEventForm />

      <h2 className="mb-3 mt-8 text-sm font-medium text-neutral-500">Your events</h2>
      {events.length === 0 ? (
        <EmptyState
          title="No events yet"
          description="Create your first event above, then upload photos to generate drafts."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {events.map((event) => (
            <li key={event.id}>
              <a
                href={`/events/${event.id}`}
                className="tap-scale flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 hover:border-primary-pink"
              >
                <span>
                  <span className="block font-medium text-foreground">{event.name}</span>
                  <span className="text-xs capitalize text-neutral-500">{event.eventType}</span>
                </span>
                <span className="text-xs text-neutral-500">
                  {event._count.media} media · {event._count.drafts} drafts
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
