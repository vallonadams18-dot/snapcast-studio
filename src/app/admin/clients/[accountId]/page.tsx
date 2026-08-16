import { redirect, notFound } from "next/navigation";
import { getCurrentAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ImpersonateButton } from "./ImpersonateButton";
import { NotesPanel } from "./NotesPanel";
import { CreditsPanel } from "./CreditsPanel";

export default async function AdminClientDetail({ params }: { params: Promise<{ accountId: string }> }) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/admin/login");

  const { accountId } = await params;
  const client = await prisma.account.findFirst({ where: { id: accountId, role: "client" } });
  if (!client) notFound();

  const [events, usage, notes, auditLog] = await Promise.all([
    prisma.event.findMany({ where: { accountId }, include: { _count: { select: { media: true, drafts: true } } } }),
    prisma.usageEvent.groupBy({ by: ["kind"], where: { accountId }, _sum: { estimatedCostCents: true }, _count: true }),
    prisma.adminNote.findMany({ where: { accountId }, orderBy: { createdAt: "desc" } }),
    prisma.auditLog.findMany({ where: { targetAccountId: accountId }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);

  const totalMedia = events.reduce((sum, e) => sum + e._count.media, 0);
  const totalApproved = await prisma.draft.count({ where: { accountId, status: { in: ["approved", "edited"] } } });

  // Derived live from real state, not a manually-checked-off list — always
  // reflects what the client has actually done.
  const checklist = [
    { label: "Brand profile set", done: client.brandTone !== "playful" || client.brandColors !== "[]" },
    { label: "First event created", done: events.length > 0 },
    { label: "First media uploaded", done: totalMedia > 0 },
    { label: "First draft approved", done: totalApproved > 0 },
    { label: "Guest portal enabled", done: client.guestPortalEnabled },
  ];

  const totalCostCents = usage.reduce((sum, u) => sum + (u._sum.estimatedCostCents ?? 0), 0);

  return (
    <div className="mx-auto w-full max-w-3xl p-6 text-neutral-200">
      <a href="/admin" className="tap-scale text-sm text-neutral-500 underline">
        ← All clients
      </a>
      <div className="mt-2 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">{client.businessName}</h1>
          <p className="text-sm text-neutral-500">{client.email}</p>
        </div>
        <ImpersonateButton accountId={client.id} />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <CreditsPanel
          accountId={client.id}
          planEventsPerMonth={client.planEventsPerMonth}
          extraCredits={client.extraCredits}
          periodEventsUsed={client.periodEventsUsed}
        />

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <h2 className="mb-2 text-sm font-medium text-neutral-400">Usage & est. cost</h2>
          <p className="text-2xl font-bold text-white">${(totalCostCents / 100).toFixed(2)}</p>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-neutral-500">
            {usage.map((u) => (
              <li key={u.kind}>
                {u.kind}: {u._count} calls · ${((u._sum.estimatedCostCents ?? 0) / 100).toFixed(2)}
              </li>
            ))}
            {usage.length === 0 && <li>No usage yet.</li>}
          </ul>
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-400">Onboarding checklist</h2>
        <ul className="flex flex-col gap-1.5">
          {checklist.map((item) => (
            <li key={item.label} className="flex items-center gap-2 text-sm">
              <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${item.done ? "bg-success text-black" : "border border-neutral-700 text-neutral-700"}`}>
                {item.done ? "✓" : ""}
              </span>
              <span className={item.done ? "text-neutral-300" : "text-neutral-500"}>{item.label}</span>
            </li>
          ))}
        </ul>
      </div>

      <NotesPanel accountId={client.id} initialNotes={notes.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt.toISOString() }))} />

      <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-400">Audit log</h2>
        {auditLog.length === 0 ? (
          <p className="text-sm text-neutral-500">No admin actions on this account yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {auditLog.map((entry) => (
              <li key={entry.id} className="border-b border-neutral-800 pb-2 text-neutral-400 last:border-0">
                <span className="font-medium text-neutral-200">{entry.action}</span>
                {entry.detail && <span> — {entry.detail}</span>}
                <span className="block text-neutral-600">{entry.createdAt.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
