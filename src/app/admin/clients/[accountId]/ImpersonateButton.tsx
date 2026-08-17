"use client";

import { useState } from "react";

export function ImpersonateButton({ accountId }: { accountId: string }) {
  const [loading, setLoading] = useState(false);

  async function impersonate() {
    setLoading(true);
    const response = await fetch(`/api/admin/clients/${accountId}/impersonate`, { method: "POST" });
    if (response.ok) {
      // Deliberately a full page load, not router.push(). This swaps the
      // session to a different account, and router navigation preserves the
      // React tree — admin-side state could otherwise linger into the
      // impersonated view. A hard reload starts the client clean.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/";
    } else {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={impersonate}
      disabled={loading}
      className="tap-scale min-h-11 rounded-lg border border-neutral-700 px-4 text-sm text-neutral-200 hover:border-neutral-500 disabled:opacity-50"
    >
      {loading ? "Switching…" : "View as this client"}
    </button>
  );
}
