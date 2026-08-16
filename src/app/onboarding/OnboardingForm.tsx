"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

const TONES = [
  { value: "playful", label: "Playful", description: "Fun, energetic, lots of personality" },
  { value: "elegant", label: "Elegant", description: "Refined, sophisticated, understated" },
  { value: "professional", label: "Professional", description: "Clean, polished, straightforward" },
] as const;

const DEFAULT_COLORS = ["#7B2FF7", "#FF5C8A"];

export function OnboardingForm({
  initialTone,
  initialLogoUrl,
}: {
  initialTone: string;
  initialLogoUrl: string;
}) {
  const router = useRouter();
  const [brandTone, setBrandTone] = useState(initialTone);
  const [brandLogoUrl, setBrandLogoUrl] = useState(initialLogoUrl);
  const [colors, setColors] = useState<string[]>(DEFAULT_COLORS);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);

    await fetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandTone, brandLogoUrl, brandColors: colors }),
    });

    router.push("/");
    router.refresh();
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center bg-background p-6">
      <h1 className="mb-1 bg-gradient-to-r from-primary-purple to-primary-pink bg-clip-text text-2xl font-bold text-transparent">
        Set up your brand
      </h1>
      <p className="mb-6 text-sm text-neutral-500">
        A few quick questions so drafts sound like you from day one.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-foreground">Tone of voice</legend>
          <div className="flex flex-col gap-2">
            {TONES.map((tone) => (
              <label
                key={tone.value}
                className={`tap-scale flex min-h-11 cursor-pointer flex-col rounded-lg border px-4 py-3 ${
                  brandTone === tone.value ? "border-primary-pink bg-primary-pink/10" : "border-border bg-surface"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="tone"
                    value={tone.value}
                    checked={brandTone === tone.value}
                    onChange={() => setBrandTone(tone.value)}
                  />
                  <span className="font-medium text-foreground">{tone.label}</span>
                </span>
                <span className="ml-6 text-xs text-neutral-500">{tone.description}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="text-sm text-foreground">
          Logo URL (optional)
          <Input
            type="url"
            value={brandLogoUrl}
            onChange={(e) => setBrandLogoUrl(e.target.value)}
            placeholder="https://..."
            className="mt-1 min-h-11"
          />
        </label>

        <div>
          <span className="mb-2 block text-sm font-medium text-foreground">Color palette</span>
          <div className="flex gap-3">
            {colors.map((color, i) => (
              <input
                key={i}
                type="color"
                value={color}
                onChange={(e) => {
                  const next = [...colors];
                  next[i] = e.target.value;
                  setColors(next);
                }}
                className="tap-scale h-11 w-11 cursor-pointer rounded-lg border border-border bg-surface"
              />
            ))}
          </div>
        </div>

        <Button type="submit" disabled={submitting} className="min-h-11 w-full">
          {submitting ? "Saving…" : "Save and continue"}
        </Button>
      </form>
    </div>
  );
}
