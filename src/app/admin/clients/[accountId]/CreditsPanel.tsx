"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const TIERS = [
  { key: "starter", label: "Starter", perMonth: 5 },
  { key: "growth", label: "Growth", perMonth: 15 },
  { key: "pro", label: "Pro", perMonth: 40 },
];

export function CreditsPanel({
  accountId,
  planEventsPerMonth,
  extraCredits,
  periodEventsUsed,
}: {
  accountId: string;
  planEventsPerMonth: number;
  extraCredits: number;
  periodEventsUsed: number;
}) {
  const router = useRouter();
  const [extraInput, setExtraInput] = useState("5");
  const [saving, setSaving] = useState(false);
  const remaining = planEventsPerMonth + extraCredits - periodEventsUsed;

  async function update(body: Record<string, unknown>) {
    setSaving(true);
    await fetch(`/api/admin/clients/${accountId}/credits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    router.refresh();
    setSaving(false);
  }

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <h2 className="mb-2 text-sm font-medium text-neutral-400">Credits & billing tier</h2>
      <p className={`text-2xl font-bold ${remaining <= 0 ? "text-error" : "text-white"}`}>
        {remaining} <span className="text-sm font-normal text-neutral-500">events remaining this period</span>
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        {periodEventsUsed} used of {planEventsPerMonth} plan + {extraCredits} extra
      </p>

      <div className="mt-3 flex gap-1">
        {TIERS.map((t) => (
          <button
            key={t.key}
            onClick={() => update({ tier: t.key })}
            disabled={saving}
            className={`tap-scale min-h-11 flex-1 rounded-lg border px-2 text-xs disabled:opacity-50 ${
              planEventsPerMonth === t.perMonth ? "border-neutral-400 text-white" : "border-neutral-700 text-neutral-400"
            }`}
          >
            {t.label}
            <span className="block text-[10px] text-neutral-500">{t.perMonth}/mo</span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          type="number"
          min={1}
          value={extraInput}
          onChange={(e) => setExtraInput(e.target.value)}
          className="w-20 rounded-lg border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-sm text-neutral-200"
        />
        <button
          onClick={() => update({ addExtraCredits: Number(extraInput) })}
          disabled={saving}
          className="tap-scale min-h-11 flex-1 rounded-lg border border-neutral-700 text-xs text-neutral-200 disabled:opacity-50"
        >
          Grant extra credits
        </button>
      </div>
    </div>
  );
}
