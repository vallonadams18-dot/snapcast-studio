"use client";

import { useMemo, useState } from "react";
import { Button, Card } from "@/components/ui";
import { ErrorState, EmptyState } from "@/components/States";

type DraftItem = {
  id: string;
  mediaId: string;
  platform: string;
  variantIndex: number;
  generatedCaption: string;
  // A parked edit from a previous session (Save in edit mode). Reopening
  // the editor picks this up instead of the AI's original text.
  editedCaption: string | null;
  mediaUrl: string;
  mediaType: string;
  energyScore: number | null;
  visualQualityScore: number | null;
  momentRarityScore: number | null;
  scoreSummary: string | null;
};

type Group = { key: string; variants: DraftItem[] };

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
};

const EXIT_ANIMATION_MS = 250;

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 70 ? "bg-success" : value >= 40 ? "bg-warning" : "bg-error";
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-neutral-500">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

interface DraftCardProps {
  group: Group;
  selectedVariant: number;
  onSelectVariant: (i: number) => void;
  editingId: string | null;
  editText: string;
  onEditTextChange: (v: string) => void;
  onStartEdit: (draft: DraftItem) => void;
  onCancelEdit: () => void;
  onUpdateStatus: (id: string, status: "approved" | "edited" | "skipped", editedCaption?: string) => void;
  onRegenerate: (id: string) => void;
  regenerating: boolean;
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
  isExiting: boolean;
  modifyingId: string | null;
  modifyText: string;
  onModifyTextChange: (v: string) => void;
  onStartModify: (id: string) => void;
  onCancelModify: () => void;
  onSubmitModify: (id: string) => void;
  onSaveDraft: (id: string, text: string) => void;
  savedDraftId: string | null;
}

function DraftCard({
  group,
  selectedVariant,
  onSelectVariant,
  editingId,
  editText,
  onEditTextChange,
  onStartEdit,
  onCancelEdit,
  onUpdateStatus,
  onRegenerate,
  regenerating,
  copiedId,
  onCopy,
  isExiting,
  modifyingId,
  modifyText,
  onModifyTextChange,
  onStartModify,
  onCancelModify,
  onSubmitModify,
  onSaveDraft,
  savedDraftId,
}: DraftCardProps) {
  const draft = group.variants[Math.min(selectedVariant, group.variants.length - 1)];
  const isEditing = editingId === draft.id;

  return (
    <Card className={`overflow-hidden shadow-2xl ${isExiting ? "card-exit" : "card-enter"}`}>
      <div className="aspect-square overflow-hidden bg-black">
        {draft.mediaType === "photo" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={draft.mediaUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <video src={draft.mediaUrl} className="h-full w-full object-cover" muted controls />
        )}
      </div>

      {draft.energyScore !== null && (
        <div className="grid grid-cols-3 gap-3 border-b border-border p-3">
          <ScoreBar label="Energy" value={draft.energyScore} />
          <ScoreBar label="Visual quality" value={draft.visualQualityScore ?? 0} />
          <ScoreBar label="Moment rarity" value={draft.momentRarityScore ?? 0} />
        </div>
      )}
      {draft.scoreSummary && <p className="border-b border-border px-3 py-2 text-[11px] text-neutral-500">{draft.scoreSummary}</p>}

      <div className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="inline-block rounded-lg bg-primary-pink/10 px-3 py-1 text-xs font-medium text-primary-pink">
            {PLATFORM_LABELS[draft.platform] ?? draft.platform} caption
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onStartModify(draft.id)}
              disabled={regenerating}
              className="tap-scale flex min-h-11 items-center px-1 text-xs text-neutral-500 underline disabled:opacity-50"
            >
              Modify
            </button>
            <button
              onClick={() => onRegenerate(draft.id)}
              disabled={regenerating}
              className="tap-scale flex min-h-11 items-center px-1 text-xs text-neutral-500 underline disabled:opacity-50"
            >
              {regenerating ? "Regenerating…" : "Regenerate"}
            </button>
          </div>
        </div>

        {modifyingId === draft.id && (
          <div className="mb-3 rounded-lg border border-primary-pink/30 bg-primary-pink/5 p-3">
            <p className="mb-2 text-xs font-medium text-foreground">What should change?</p>
            <textarea
              value={modifyText}
              onChange={(e) => onModifyTextChange(e.target.value)}
              rows={2}
              placeholder="e.g. make it shorter, mention the venue, less formal"
              className="w-full rounded-lg border border-border bg-background p-2 text-sm text-foreground focus:border-primary-pink focus:outline-none"
            />
            <div className="mt-2 flex gap-2">
              <Button
                onClick={() => onSubmitModify(draft.id)}
                disabled={regenerating || !modifyText.trim()}
                className="min-h-11 flex-1 text-xs"
              >
                {regenerating ? "Rewriting…" : "Rewrite it"}
              </Button>
              <Button variant="secondary" onClick={onCancelModify} className="min-h-11 text-xs">
                Cancel
              </Button>
            </div>
            <p className="mt-1 text-[10px] text-neutral-500">
              Unlike Regenerate, this keeps the current caption and changes only what you ask for.
            </p>
          </div>
        )}

        {group.variants.length > 1 && (
          <div className="mb-2 flex gap-1.5">
            {group.variants.map((v, i) => (
              <button
                key={v.id}
                onClick={() => onSelectVariant(i)}
                className={`tap-scale min-h-11 flex-1 rounded-lg border px-2 text-xs font-medium ${
                  i === selectedVariant
                    ? "border-primary-pink bg-primary-pink/10 text-primary-pink"
                    : "border-border text-neutral-500"
                }`}
              >
                Option {i + 1}
              </button>
            ))}
          </div>
        )}

        {isEditing ? (
          <textarea
            value={editText}
            onChange={(e) => onEditTextChange(e.target.value)}
            rows={4}
            className="mt-2 w-full min-h-11 rounded-lg border border-border bg-background p-3 text-sm text-foreground focus:border-primary-pink focus:outline-none"
          />
        ) : (
          <>
            {draft.editedCaption && (
              <p className="mt-2 text-[10px] font-medium text-primary-pink">
                You have an unfinished edit saved — tap Edit to pick it back up.
              </p>
            )}
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
              {draft.editedCaption ?? draft.generatedCaption}
            </p>
          </>
        )}

        {isEditing ? (
          <div className="mt-4 flex gap-2">
            <div className="flex flex-1 flex-col items-center gap-1">
              <Button onClick={() => onUpdateStatus(draft.id, "edited", editText)} className="min-h-11 w-full">
                Save &amp; approve
              </Button>
              <span className="text-center text-[10px] leading-tight text-neutral-500">Post with your edits</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Button variant="secondary" onClick={() => onSaveDraft(draft.id, editText)} className="min-h-11">
                {savedDraftId === draft.id ? "Saved" : "Save"}
              </Button>
              <span className="text-center text-[10px] leading-tight text-neutral-500">Keep for later</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Button variant="secondary" onClick={onCancelEdit} className="min-h-11">
                Cancel
              </Button>
              <span className="text-center text-[10px] leading-tight text-neutral-500">Discard changes</span>
            </div>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-3 gap-2">
            <div className="flex flex-col items-center gap-1">
              <Button onClick={() => onUpdateStatus(draft.id, "approved")} className="min-h-11 w-full">
                Approve
              </Button>
              <span className="text-center text-[10px] leading-tight text-neutral-500">Post this as-is</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Button variant="secondary" className="min-h-11 w-full" onClick={() => onStartEdit(draft)}>
                Edit
              </Button>
              <span className="text-center text-[10px] leading-tight text-neutral-500">Tweak wording, then approve</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Button variant="secondary" className="min-h-11 w-full" onClick={() => onUpdateStatus(draft.id, "skipped")}>
                Skip
              </Button>
              <span className="text-center text-[10px] leading-tight text-neutral-500">Removes this draft only — not your upload</span>
            </div>
          </div>
        )}
        <button
          onClick={() => onCopy(draft.generatedCaption, draft.id)}
          className="tap-scale mt-2 min-h-11 w-full rounded-lg border border-border text-xs text-neutral-500"
        >
          {copiedId === draft.id ? "Copied!" : "Copy caption for manual posting"}
        </button>
      </div>
    </Card>
  );
}

export function ReviewFeed({ initialDrafts, eventId }: { initialDrafts: DraftItem[]; eventId: string }) {
  const [drafts, setDrafts] = useState(initialDrafts);
  const [selectedVariants, setSelectedVariants] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [exitingKeys, setExitingKeys] = useState<Set<string>>(new Set());
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trustModeOffer, setTrustModeOffer] = useState(false);
  const [trustModeEnabled, setTrustModeEnabled] = useState(false);
  const [modifyingId, setModifyingId] = useState<string | null>(null);
  const [modifyText, setModifyText] = useState("");
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);

  // Group by (mediaId, platform) so multiple caption options for the same
  // photo/platform show as one card with a variant switcher, not separate
  // cards in a row.
  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, DraftItem[]>();
    for (const d of drafts) {
      const key = `${d.mediaId}:${d.platform}`;
      const list = map.get(key) ?? [];
      list.push(d);
      map.set(key, list);
    }
    return Array.from(map.entries()).map(([key, variants]) => ({
      key,
      variants: variants.sort((a, b) => a.variantIndex - b.variantIndex),
    }));
  }, [drafts]);

  async function updateStatus(groupKey: string, id: string, status: "approved" | "edited" | "skipped", editedCaption?: string) {
    setExitingKeys((prev) => new Set(prev).add(groupKey));
    setError(null);

    try {
      const response = await fetch(`/api/drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, editedCaption }),
      });
      if (!response.ok) throw new Error();
      const updated = await response.json();
      if (updated.trustModeOfferable) setTrustModeOffer(true);
    } catch {
      setError("Couldn't save that — check your connection and try again.");
      setExitingKeys((prev) => {
        const next = new Set(prev);
        next.delete(groupKey);
        return next;
      });
      return;
    }

    setTimeout(() => {
      setDrafts((prev) => prev.filter((d) => `${d.mediaId}:${d.platform}` !== groupKey));
      setEditingId(null);
      setExitingKeys((prev) => {
        const next = new Set(prev);
        next.delete(groupKey);
        return next;
      });
    }, EXIT_ANIMATION_MS);
  }

  async function enableTrustMode() {
    setTrustModeEnabled(true);
    setTrustModeOffer(false);
    await fetch("/api/account/trust-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
  }

  async function regenerate(id: string) {
    setRegenerating(true);
    setError(null);
    try {
      const response = await fetch(`/api/drafts/${id}/regenerate`, { method: "POST" });
      if (!response.ok) throw new Error();
      const updated = await response.json();
      setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, generatedCaption: updated.generatedCaption } : d)));
    } catch {
      setError("Couldn't generate a new draft — check your connection and try again.");
    }
    setRegenerating(false);
  }

  // Modify: unlike Regenerate (a blind re-roll), this sends the client's own
  // instruction and rewrites the existing caption around it.
  async function submitModify(id: string) {
    const guidance = modifyText.trim();
    if (!guidance) return;

    setRegenerating(true);
    setError(null);
    try {
      const response = await fetch(`/api/drafts/${id}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guidance }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Couldn't rewrite that caption.");

      setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, generatedCaption: body.generatedCaption } : d)));
      setModifyingId(null);
      setModifyText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rewrite that caption.");
    }
    setRegenerating(false);
  }

  // Save-as-draft: park the in-progress edit without approving, so leaving
  // the page mid-sentence doesn't lose it.
  async function saveDraft(id: string, text: string) {
    setError(null);
    try {
      const response = await fetch(`/api/drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saveOnly: true, editedCaption: text }),
      });
      if (!response.ok) throw new Error();
      setSavedDraftId(id);
      setTimeout(() => setSavedDraftId(null), 2000);
    } catch {
      setError("Couldn't save your draft — check your connection and try again.");
    }
  }

  async function copyCaption(text: string, id: string) {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  const trustModeBanner = trustModeOffer && !trustModeEnabled && (
    <div className="mb-3 rounded-xl border border-primary-pink/30 bg-primary-pink/10 p-4">
      <p className="text-sm font-medium text-foreground">20 clean approvals in a row 🎉</p>
      <p className="mt-1 text-sm text-neutral-500">
        Your drafts are consistently on-brand. Turn on Trust Mode to skip manual review on future drafts for
        channels that support auto-posting.
      </p>
      <div className="mt-3 flex gap-2">
        <Button onClick={enableTrustMode} className="text-xs">
          Turn on Trust Mode
        </Button>
        <Button variant="secondary" onClick={() => setTrustModeOffer(false)} className="text-xs">
          Not yet
        </Button>
      </div>
    </div>
  );

  if (groups.length === 0) {
    return (
      <div>
        {trustModeBanner}
        <EmptyState
          title="All caught up"
          description="No drafts left to review. Upload more photos or video to generate new ones."
        />
        {/* Finishing the queue is exactly when you want what you just
            approved — without this the content is only reachable by
            guessing the URL. */}
        <a
          href={`/events/${eventId}/approved`}
          className="tap-scale mt-3 block rounded-lg bg-gradient-to-r from-primary-purple to-primary-pink px-4 py-3 text-center font-semibold text-white"
        >
          View approved content
        </a>
      </div>
    );
  }

  function cardProps(group: Group) {
    return {
      group,
      selectedVariant: selectedVariants[group.key] ?? 0,
      onSelectVariant: (i: number) => setSelectedVariants((prev) => ({ ...prev, [group.key]: i })),
      editingId,
      editText,
      onEditTextChange: setEditText,
      onStartEdit: (draft: DraftItem) => {
        setEditingId(draft.id);
        setEditText(draft.editedCaption ?? draft.generatedCaption);
      },
      onCancelEdit: () => setEditingId(null),
      onUpdateStatus: (id: string, status: "approved" | "edited" | "skipped", editedCaption?: string) =>
        updateStatus(group.key, id, status, editedCaption),
      onRegenerate: regenerate,
      regenerating,
      copiedId,
      onCopy: copyCaption,
      isExiting: exitingKeys.has(group.key),
      modifyingId,
      modifyText,
      onModifyTextChange: setModifyText,
      onStartModify: (id: string) => {
        setModifyingId(id);
        setModifyText("");
      },
      onCancelModify: () => {
        setModifyingId(null);
        setModifyText("");
      },
      onSubmitModify: submitModify,
      onSaveDraft: saveDraft,
      savedDraftId,
    };
  }

  return (
    <div>
      {trustModeBanner}
      {error && (
        <div className="mb-3">
          <ErrorState message={error} />
        </div>
      )}

      {/* Mobile: one card at a time, swipe-style. */}
      <div className="lg:hidden">
        <DraftCard {...cardProps(groups[0])} />
        <p className="pb-3 pt-3 text-center text-xs text-neutral-500">
          {groups.length} draft{groups.length === 1 ? "" : "s"} left
        </p>
      </div>

      {/* Desktop: work through several at once in a grid. */}
      <div className="hidden lg:block">
        <p className="mb-3 text-xs text-neutral-500">
          {groups.length} draft{groups.length === 1 ? "" : "s"} left
        </p>
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {groups.map((g) => (
            <DraftCard key={g.key} {...cardProps(g)} />
          ))}
        </div>
      </div>
    </div>
  );
}
