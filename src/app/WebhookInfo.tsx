"use client";

import { useState } from "react";

export function WebhookInfo({ webhookUrl, secret }: { webhookUrl: string; secret: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"url" | "secret" | null>(null);

  async function copy(value: string, which: "url" | "secret") {
    await navigator.clipboard.writeText(value);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="mt-8 rounded-xl border border-border bg-surface p-4">
      <button onClick={() => setOpen((v) => !v)} className="tap-scale flex min-h-11 w-full items-center justify-between text-sm font-medium text-foreground">
        <span>Booth software integration — connect Snappic or similar automatically</span>
        <span className="text-neutral-500">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-neutral-500">
            Point your booth software&apos;s webhook at this URL, signing each request with the secret below as an
            HMAC-SHA256 <code className="rounded bg-background px-1">x-signature</code> header. New photos land as
            drafts automatically, just like a manual upload.
          </p>
          <div>
            <label className="mb-1 block text-xs text-neutral-500">Webhook URL</label>
            <div className="flex gap-2">
              <code className="flex flex-1 items-center truncate rounded-lg bg-background px-2 py-1.5 text-xs text-foreground">{webhookUrl}</code>
              <button onClick={() => copy(webhookUrl, "url")} className="tap-scale min-h-11 rounded-lg border border-border px-3 text-xs text-neutral-500">
                {copied === "url" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-500">Signing secret</label>
            <div className="flex gap-2">
              <code className="flex flex-1 items-center truncate rounded-lg bg-background px-2 py-1.5 text-xs text-foreground">{secret}</code>
              <button onClick={() => copy(secret, "secret")} className="tap-scale min-h-11 rounded-lg border border-border px-3 text-xs text-neutral-500">
                {copied === "secret" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
