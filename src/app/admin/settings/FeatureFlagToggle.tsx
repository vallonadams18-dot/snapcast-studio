"use client";

import { useState } from "react";

export function FeatureFlagToggle({
  flagKey,
  description,
  initialEnabled,
}: {
  flagKey: string;
  description: string;
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    setSaving(true);
    const next = !enabled;
    setEnabled(next);
    await fetch("/api/admin/feature-flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: flagKey, enabled: next }),
    });
    setSaving(false);
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div>
        <p className="text-sm font-medium text-white">{flagKey}</p>
        <p className="text-xs text-neutral-500">{description}</p>
      </div>
      <button
        onClick={toggle}
        disabled={saving}
        className={`tap-scale relative h-6 w-11 shrink-0 rounded-full transition ${enabled ? "bg-success" : "bg-neutral-700"}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`}
        />
      </button>
    </div>
  );
}
