"use client";

import { useState } from "react";

export function GuestPortalToggle({ initialEnabled, claimCount }: { initialEnabled: boolean; claimCount: number }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    setSaving(true);
    const next = !enabled;
    setEnabled(next);
    await fetch("/api/account/guest-portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    setSaving(false);
  }

  return (
    <div className="mt-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">Guest photo-share portal</p>
          <p className="text-xs text-neutral-500">
            Let event guests browse and share photos themselves — the top way people discover you.
            {claimCount > 0 && ` ${claimCount} share${claimCount === 1 ? "" : "s"} so far.`}
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={saving}
          className={`tap-scale relative h-6 w-11 shrink-0 rounded-full transition ${enabled ? "bg-gradient-to-r from-primary-purple to-primary-pink" : "bg-border"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`}
          />
        </button>
      </div>
    </div>
  );
}
