"use client";

import { useState } from "react";

export function ImpersonationBanner({ clientName }: { clientName: string }) {
  const [returning, setReturning] = useState(false);

  async function returnToAdmin() {
    setReturning(true);
    await fetch("/api/admin/return-to-admin", { method: "POST" });
    // Deliberately a full page load, not router.push(). This swaps which
    // account the session belongs to, and router navigation keeps the
    // existing React tree — any client component still holding the
    // impersonated client's data would survive the transition. A hard
    // reload guarantees nothing from that identity is left in memory.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/admin";
  }

  return (
    <div className="flex min-h-11 items-center justify-center gap-3 bg-warning px-4 py-2 text-center text-xs font-medium text-black">
      <span>Viewing as {clientName} (admin impersonation)</span>
      <button onClick={returnToAdmin} disabled={returning} className="tap-scale underline disabled:opacity-60">
        {returning ? "Returning…" : "Return to admin"}
      </button>
    </div>
  );
}
