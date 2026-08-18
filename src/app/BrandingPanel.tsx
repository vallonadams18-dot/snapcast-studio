"use client";

import { useRef, useState } from "react";
import { Input } from "@/components/ui";
import { SuccessBanner } from "@/components/States";

const POSITIONS = [
  { id: "bottom-right", label: "Bottom right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "top-right", label: "Top right" },
  { id: "top-left", label: "Top left" },
];

const WATERMARK_SIZES = [
  { value: 0.14, label: "Small" },
  { value: 0.22, label: "Medium" },
  { value: 0.3, label: "Large" },
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

type Slot = "logo" | "intro" | "outro";

interface BrandKitSnapshot {
  logoPreviewUrl: string | null;
  hasLogo: boolean;
  introKind: string;
  introPreviewUrl: string | null;
  outroKind: string;
  outroPreviewUrl: string | null;
}

// Preview + Upload/Replace/Remove for one Brand Kit asset. The file input is
// hidden behind a styled label so phones open the photo library / Files
// sheet directly. No storage URLs are ever shown as text — previews only.
function AssetRow({
  slot,
  title,
  hint,
  accept,
  kind,
  previewUrl,
  busy,
  onUpload,
  onRemove,
}: {
  slot: Slot;
  title: string;
  hint: string;
  accept: string;
  kind: "image" | "video" | null;
  previewUrl: string | null;
  busy: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasAsset = Boolean(previewUrl);

  return (
    <div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-[11px] text-neutral-500">{hint}</p>

      {hasAsset && (
        <div className="mt-2">
          {kind === "video" ? (
            <video
              src={previewUrl ?? undefined}
              muted
              playsInline
              loop
              autoPlay
              className="h-24 w-auto rounded-lg border border-border bg-background object-contain"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl ?? undefined}
              alt={`Your ${title.toLowerCase()}`}
              className="h-16 w-auto rounded-lg border border-border bg-background object-contain p-1"
            />
          )}
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset so picking the same file again still fires onChange.
            e.target.value = "";
            if (file) onUpload(file);
          }}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="tap-scale min-h-11 flex-1 rounded-lg border border-primary-pink bg-primary-pink/10 px-3 text-xs font-medium text-primary-pink disabled:opacity-50"
        >
          {busy ? "Uploading…" : hasAsset ? "Replace" : `Upload ${slot}`}
        </button>
        {hasAsset && (
          <button
            onClick={onRemove}
            disabled={busy}
            className="tap-scale min-h-11 rounded-lg border border-border bg-background px-3 text-xs text-neutral-500 disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

export function BrandingPanel(props: {
  brandLogoUrl: string | null;
  brandLogoAssetUrl: string | null;
  introKind: string;
  introAssetUrl: string | null;
  outroKind: string;
  outroAssetUrl: string | null;
  introEnabled: boolean;
  outroEnabled: boolean;
  outroText: string | null;
  watermarkEnabled: boolean;
  watermarkPosition: string;
  watermarkOpacity: number;
  watermarkScale: number;
}) {
  const [kit, setKit] = useState<BrandKitSnapshot>({
    logoPreviewUrl: props.brandLogoAssetUrl ?? props.brandLogoUrl,
    hasLogo: Boolean(props.brandLogoAssetUrl || props.brandLogoUrl),
    introKind: props.introKind,
    introPreviewUrl: props.introAssetUrl,
    outroKind: props.outroKind,
    outroPreviewUrl: props.outroAssetUrl,
  });
  const [intro, setIntro] = useState(props.introEnabled);
  const [outro, setOutro] = useState(props.outroEnabled);
  const [outroText, setOutroText] = useState(props.outroText ?? "");
  const [watermark, setWatermark] = useState(props.watermarkEnabled);
  const [position, setPosition] = useState(props.watermarkPosition);
  const [opacity, setOpacity] = useState(props.watermarkOpacity);
  const [wmScale, setWmScale] = useState(props.watermarkScale);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<Slot | null>(null);
  const [open, setOpen] = useState(false);

  const hasLogo = kit.hasLogo;
  const hasIntroMedia = kit.introKind !== "none" && Boolean(kit.introPreviewUrl);
  const hasOutroMedia = kit.outroKind !== "none" && Boolean(kit.outroPreviewUrl);

  function flash(message: string) {
    setError(null);
    setSaved(message);
    setTimeout(() => setSaved(null), 2500);
  }

  async function save(patch: Record<string, unknown>, message: string) {
    setSaved(null);
    await fetch("/api/account/branding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    flash(message);
  }

  async function upload(slot: Slot, file: File) {
    setBusySlot(slot);
    setError(null);
    setSaved(null);
    try {
      const form = new FormData();
      form.set("slot", slot);
      form.set("file", file);
      const res = await fetch("/api/account/brand-asset", { method: "POST", body: form });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof json?.error === "string" ? json.error : "Upload failed — try again.");
        return;
      }
      setKit(json as BrandKitSnapshot);
      flash(slot === "logo" ? "Logo saved." : slot === "intro" ? "Intro saved." : "Outro saved.");
    } catch {
      setError("Upload failed — check your connection and try again.");
    } finally {
      setBusySlot(null);
    }
  }

  async function removeAsset(slot: Slot) {
    setBusySlot(slot);
    setError(null);
    try {
      const res = await fetch("/api/account/brand-asset", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json) setKit(json as BrandKitSnapshot);
      flash("Removed.");
    } finally {
      setBusySlot(null);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-border bg-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="tap-scale flex min-h-11 w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-medium text-foreground">
          Brand Kit — logo, intro, outro &amp; watermark
        </span>
        <span className="text-neutral-500">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="border-t border-border p-4">
          <div className="flex flex-col gap-5">
            <AssetRow
              slot="logo"
              title="Logo"
              hint="Used for the watermark and logo cards. A PNG with a transparent background works best."
              accept="image/*"
              kind="image"
              previewUrl={kit.logoPreviewUrl}
              busy={busySlot === "logo"}
              onUpload={(f) => upload("logo", f)}
              onRemove={() => removeAsset("logo")}
            />

            <div className="border-t border-border pt-4">
              <AssetRow
                slot="intro"
                title="Intro"
                hint="A photo or short video played before every generated video. Photos get a subtle motion; videos play up to 6 seconds."
                accept="image/*,video/*"
                kind={kit.introKind === "video" ? "video" : "image"}
                previewUrl={kit.introPreviewUrl}
                busy={busySlot === "intro"}
                onUpload={(f) => upload("intro", f)}
                onRemove={() => removeAsset("intro")}
              />

              {!hasIntroMedia && (
                <div className="mt-3 flex items-start justify-between gap-3">
                  <p className="text-[11px] text-neutral-500">
                    No intro uploaded — use a simple logo card instead?
                    {!hasLogo && " (Needs a logo.)"}
                  </p>
                  <Toggle
                    on={intro}
                    disabled={!hasLogo}
                    onChange={() => {
                      const next = !intro;
                      setIntro(next);
                      save({ introEnabled: next }, next ? "Intro card on." : "Intro card off.");
                    }}
                  />
                </div>
              )}
            </div>

            <div className="border-t border-border pt-4">
              <AssetRow
                slot="outro"
                title="Outro"
                hint="A photo or short video closing every generated video — a booking call-to-action works well here."
                accept="image/*,video/*"
                kind={kit.outroKind === "video" ? "video" : "image"}
                previewUrl={kit.outroPreviewUrl}
                busy={busySlot === "outro"}
                onUpload={(f) => upload("outro", f)}
                onRemove={() => removeAsset("outro")}
              />

              {!hasOutroMedia && (
                <>
                  <div className="mt-3 flex items-start justify-between gap-3">
                    <p className="text-[11px] text-neutral-500">
                      No outro uploaded — use a logo card with a call to action instead?
                      {!hasLogo && " (Needs a logo.)"}
                    </p>
                    <Toggle
                      on={outro}
                      disabled={!hasLogo}
                      onChange={() => {
                        const next = !outro;
                        setOutro(next);
                        save({ outroEnabled: next }, next ? "Outro card on." : "Outro card off.");
                      }}
                    />
                  </div>
                  {outro && hasLogo && (
                    <label className="mt-2 block text-xs text-neutral-500">
                      Outro card text
                      <Input
                        value={outroText}
                        onChange={(e) => setOutroText(e.target.value)}
                        onBlur={() => save({ outroText }, "Outro text saved.")}
                        placeholder="Book your next event @yourhandle"
                        className="mt-1 min-h-11 text-sm"
                      />
                    </label>
                  )}
                </>
              )}
            </div>

            <div className="flex items-start justify-between gap-3 border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium text-foreground">Watermark</p>
                <p className="text-[11px] text-neutral-500">
                  Burns your logo into generated videos so reposts stay credited.
                  {!hasLogo && " Needs a logo."}
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

                <div>
                  <p className="mb-2 text-xs font-medium text-foreground">Size</p>
                  <div className="grid grid-cols-3 gap-2">
                    {WATERMARK_SIZES.map((s) => (
                      <button
                        key={s.value}
                        onClick={() => {
                          setWmScale(s.value);
                          save({ watermarkScale: s.value }, "Size saved.");
                        }}
                        className={`tap-scale min-h-11 rounded-lg border px-3 text-xs ${
                          Math.abs(wmScale - s.value) < 0.03
                            ? "border-primary-pink bg-primary-pink/10 text-primary-pink"
                            : "border-border bg-background text-foreground"
                        }`}
                      >
                        {s.label}
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

          {error && (
            <p className="mt-3 rounded-lg bg-warning/10 p-2 text-[11px] text-warning">{error}</p>
          )}
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
