"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { SuccessBanner } from "@/components/States";

const POSITIONS = [
  { id: "bottom-right", label: "Bottom right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "top-right", label: "Top right" },
  { id: "top-left", label: "Top left" },
];

function Toggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`tap-scale relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-40 ${
        on ? "bg-gradient-to-r from-primary-purple to-primary-pink" : "bg-border"
      }`}
      aria-pressed={on}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          on ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function BrandingPanel(props: {
  brandLogoUrl: string | null;
  introEnabled: boolean;
  outroEnabled: boolean;
  outroText: string | null;
  watermarkEnabled: boolean;
  watermarkPosition: string;
  watermarkOpacity: number;
}) {
  const [logoUrl, setLogoUrl] = useState(props.brandLogoUrl ?? "");
  const [intro, setIntro] = useState(props.introEnabled);
  const [outro, setOutro] = useState(props.outroEnabled);
  const [outroText, setOutroText] = useState(props.outroText ?? "");
  const [watermark, setWatermark] = useState(props.watermarkEnabled);
  const [position, setPosition] = useState(props.watermarkPosition);
  const [opacity, setOpacity] = useState(props.watermarkOpacity);
  const [saved, setSaved] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const hasLogo = logoUrl.trim().length > 0;

  async function save(patch: Record<string, unknown>, message: string) {
    setSaved(null);
    await fetch("/api/account/branding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSaved(message);
    setTimeout(() => setSaved(null), 2500);
  }

  return (
    <div className="mt-3 rounded-xl border border-border bg-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="tap-scale flex min-h-11 w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-medium text-foreground">
          Branding — logo intro, outro &amp; watermark
        </span>
        <span className="text-neutral-500">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="border-t border-border p-4">
          <label className="block text-xs text-neutral-500">
            Logo image URL
            <Input
              type="url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              onBlur={() => save({ brandLogoUrl: logoUrl }, "Logo saved.")}
              placeholder="https://yoursite.com/logo.png"
              className="mt-1 min-h-11 text-sm"
            />
            <span className="mt-1 block text-[10px] text-neutral-500">
              A PNG with a transparent background works best. Everything below needs this set.
            </span>
          </label>

          {hasLogo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt="Your logo"
              className="mt-2 h-16 w-auto rounded-lg border border-border bg-background object-contain p-1"
            />
          )}

          {!hasLogo && (
            <p className="mt-2 rounded-lg bg-warning/10 p-2 text-[11px] text-warning">
              Add a logo URL above to enable intro, outro, and watermark.
            </p>
          )}

          <div className="mt-4 flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Logo intro</p>
                <p className="text-[11px] text-neutral-500">
                  1.5s branded card before every generated video.
                </p>
              </div>
              <Toggle
                on={intro}
                disabled={!hasLogo}
                onChange={() => {
                  const next = !intro;
                  setIntro(next);
                  save({ introEnabled: next }, next ? "Intro on." : "Intro off.");
                }}
              />
            </div>

            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Outro card</p>
                <p className="text-[11px] text-neutral-500">
                  2s closing card with your logo and a call to action.
                </p>
              </div>
              <Toggle
                on={outro}
                disabled={!hasLogo}
                onChange={() => {
                  const next = !outro;
                  setOutro(next);
                  save({ outroEnabled: next }, next ? "Outro on." : "Outro off.");
                }}
              />
            </div>

            {outro && hasLogo && (
              <label className="block text-xs text-neutral-500">
                Outro text
                <Input
                  value={outroText}
                  onChange={(e) => setOutroText(e.target.value)}
                  onBlur={() => save({ outroText }, "Outro text saved.")}
                  placeholder="Book your next event @yourhandle"
                  className="mt-1 min-h-11 text-sm"
                />
              </label>
            )}

            <div className="flex items-start justify-between gap-3 border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium text-foreground">Watermark</p>
                <p className="text-[11px] text-neutral-500">
                  Burns your logo into generated videos so reposts stay credited.
                </p>
              </div>
              <Toggle
                on={watermark}
                disabled={!hasLogo}
                onChange={() => {
                  const next = !watermark;
                  setWatermark(next);
                  save({ watermarkEnabled: next }, next ? "Watermark on." : "Watermark off.");
                }}
              />
            </div>

            {watermark && hasLogo && (
              <>
                <div>
                  <p className="mb-2 text-xs font-medium text-foreground">Position</p>
                  <div className="grid grid-cols-2 gap-2">
                    {POSITIONS.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setPosition(p.id);
                          save({ watermarkPosition: p.id }, "Position saved.");
                        }}
                        className={`tap-scale min-h-11 rounded-lg border px-3 text-xs ${
                          position === p.id
                            ? "border-primary-pink bg-primary-pink/10 text-primary-pink"
                            : "border-border bg-background text-foreground"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="block text-xs text-neutral-500">
                  Opacity — {Math.round(opacity * 100)}%
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={Math.round(opacity * 100)}
                    onChange={(e) => setOpacity(Number(e.target.value) / 100)}
                    onMouseUp={() => save({ watermarkOpacity: opacity }, "Opacity saved.")}
                    onTouchEnd={() => save({ watermarkOpacity: opacity }, "Opacity saved.")}
                    className="mt-1 w-full accent-primary-pink"
                  />
                  <span className="block text-[10px] text-neutral-500">
                    Lower is subtler. A fully opaque logo over someone&apos;s face looks worse than none.
                  </span>
                </label>
              </>
            )}
          </div>

          {saved && (
            <div className="mt-3">
              <SuccessBanner message={saved} />
            </div>
          )}

          <p className="mt-3 text-[10px] text-neutral-500">
            These apply to videos generated from now on — existing videos keep whatever they were made with.
          </p>
        </div>
      )}
    </div>
  );
}
