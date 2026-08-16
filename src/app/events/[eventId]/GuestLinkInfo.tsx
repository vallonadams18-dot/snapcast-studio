"use client";

import { useState } from "react";

export function GuestLinkInfo({ guestUrl }: { guestUrl: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(guestUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface p-4">
      <p className="text-sm font-medium text-foreground">Guest photo link</p>
      <p className="mt-1 text-xs text-neutral-500">
        Share this at the event — guests can browse and share their own photos.
      </p>
      <div className="mt-2 flex gap-2">
        <code className="flex flex-1 items-center truncate rounded-lg bg-background px-2 py-1.5 text-xs text-foreground">{guestUrl}</code>
        <button onClick={copy} className="tap-scale min-h-11 rounded-lg border border-border px-3 text-xs text-neutral-500">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
