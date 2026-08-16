"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

const EVENT_TYPES = ["wedding", "corporate", "birthday", "other"] as const;

export function NewEventForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number]>("other");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);

    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, eventType }),
    });

    if (response.ok) {
      const event = await response.json();
      router.push(`/events/${event.id}`);
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 sm:flex-row">
      <Input
        type="text"
        required
        placeholder="Event name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="flex-1 text-sm"
      />
      <select
        value={eventType}
        onChange={(e) => setEventType(e.target.value as (typeof EVENT_TYPES)[number])}
        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-primary-pink focus:outline-none"
      >
        {EVENT_TYPES.map((t) => (
          <option key={t} value={t}>
            {t[0].toUpperCase() + t.slice(1)}
          </option>
        ))}
      </select>
      <Button type="submit" disabled={submitting} className="whitespace-nowrap">
        {submitting ? "Creating…" : "New event"}
      </Button>
    </form>
  );
}
