"use client";

import { useState } from "react";

export function ImpersonationBanner({ clientName }: { clientName: string }) {
  const [returning, setReturning] = useState(false);

  async function returnToAdmin() {
    setReturning(true);
    await fetch("/api/admin/return-to-admin", { method: "POST" });
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
