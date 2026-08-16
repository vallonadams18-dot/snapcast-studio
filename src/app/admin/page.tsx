import { redirect } from "next/navigation";
import { existsSync } from "node:fs";
import { getCurrentAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFfmpegPath } from "@/lib/ffmpegPaths";

export default async function AdminDashboard() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/admin/login");

  const clients = await prisma.account.findMany({
    where: { role: "client" },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { events: true } } },
  });

  const usageByAccount = await prisma.usageEvent.groupBy({
    by: ["accountId"],
    _sum: { estimatedCostCents: true },
    _count: true,
  });
  const usageMap = new Map(usageByAccount.map((u) => [u.accountId, u]));

  const health = {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    epidemicSound: Boolean(process.env.EPIDEMIC_SOUND_API_KEY),
    storageProvider: process.env.STORAGE_PROVIDER || "local",
    ffmpeg: existsSync(resolveFfmpegPath()),
    database: "sqlite (dev)",
  };

  return (
    <div className="mx-auto w-full max-w-4xl p-6 text-neutral-200">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Admin — Snapcast Studio</h1>
          <p className="text-sm text-neutral-500">Signed in as {admin.email}. Internal only.</p>
        </div>
        <div className="flex gap-4 text-sm">
          <a href="/admin/settings" className="tap-scale text-neutral-400 underline">
            Settings
          </a>
          <form
            action={async () => {
              "use server";
              const { destroySession } = await import("@/lib/auth");
              await destroySession();
              redirect("/admin/login");
            }}
          >
            <button type="submit" className="tap-scale text-neutral-400 underline">
              Log out
            </button>
          </form>
        </div>
      </div>

      <h2 className="mb-2 text-sm font-medium text-neutral-400">System health</h2>
      <div className="mb-8 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          { label: "Claude API", ok: health.anthropic },
          { label: "Epidemic Sound", ok: health.epidemicSound },
          { label: "Storage", ok: true, detail: health.storageProvider },
          { label: "ffmpeg", ok: health.ffmpeg },
          { label: "Database", ok: true, detail: health.database },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
            <span className={`block h-2 w-2 rounded-full ${item.ok ? "bg-success" : "bg-error"}`} />
            <p className="mt-2 text-xs font-medium text-neutral-200">{item.label}</p>
            <p className="text-[10px] text-neutral-500">{item.detail ?? (item.ok ? "connected" : "not configured")}</p>
          </div>
        ))}
      </div>

      <h2 className="mb-2 text-sm font-medium text-neutral-400">Client accounts ({clients.length})</h2>
      {clients.length === 0 ? (
        <p className="text-sm text-neutral-500">No client accounts yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {clients.map((client) => {
            const usage = usageMap.get(client.id);
            const remaining = client.planEventsPerMonth + client.extraCredits - client.periodEventsUsed;
            return (
              <a
                key={client.id}
                href={`/admin/clients/${client.id}`}
                className="tap-scale flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 hover:border-neutral-600"
              >
                <span>
                  <span className="block font-medium text-white">{client.businessName}</span>
                  <span className="text-xs text-neutral-500">{client.email}</span>
                </span>
                <span className="text-right text-xs text-neutral-500">
                  <span className={`block ${remaining <= 0 ? "text-error" : ""}`}>
                    {remaining <= 0 ? "Out of credits" : `${remaining} events left`}
                  </span>
                  <span>{client._count.events} events · ${((usage?._sum.estimatedCostCents ?? 0) / 100).toFixed(2)} est. cost</span>
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
