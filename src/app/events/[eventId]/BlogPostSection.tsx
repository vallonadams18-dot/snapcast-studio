"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { ErrorState } from "@/components/States";
import { VoiceNotesInput } from "./VoiceNotesInput";

type BlogPost = {
  status: string;
  generatedContent: string;
  editedContent: string | null;
  inputNotes: string;
};

export function BlogPostSection({ eventId, initialPost }: { eventId: string; initialPost: BlogPost | null }) {
  const [post, setPost] = useState(initialPost);
  const [notes, setNotes] = useState(initialPost?.inputNotes ?? "");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(Boolean(initialPost));

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/events/${eventId}/blog-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputNotes: notes }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Generation failed.");
      setPost(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't generate a blog post — try again.");
    }
    setLoading(false);
  }

  async function updateStatus(status: "approved" | "edited", editedContent?: string) {
    const response = await fetch(`/api/events/${eventId}/blog-post`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, editedContent }),
    });
    if (response.ok) setPost(await response.json());
    setEditing(false);
  }

  const displayedContent = post?.editedContent ?? post?.generatedContent ?? "";

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface">
      <button onClick={() => setOpen((v) => !v)} className="tap-scale flex min-h-11 w-full items-center justify-between px-4 py-3 text-left">
        <span className="text-sm font-medium text-foreground">
          Blog post <span className="font-normal text-neutral-500">(optional — for local SEO)</span>
        </span>
        <span className="text-neutral-500">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="border-t border-border p-4">
          {!post ? (
            <>
              <p className="mb-2 text-sm text-neutral-500">
                Want a blog post for this event? Tell us a bit about it — highlights, quotes, vibe, specifics. Leave
                it blank and we won&apos;t generate anything.
              </p>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="e.g. Sarah and Jake's rooftop wedding, 120 guests, surprise fireworks finale, the best man's speech had everyone in tears..."
                className="w-full rounded-lg border border-border bg-background p-3 text-sm text-foreground focus:border-primary-pink focus:outline-none"
              />
              <VoiceNotesInput value={notes} onChange={setNotes} disabled={loading} />
              {error && (
                <div className="mt-2">
                  <ErrorState message={error} onRetry={generate} />
                </div>
              )}
              <Button onClick={generate} disabled={loading || !notes.trim()} className="mt-3 min-h-11 w-full">
                {loading ? "Writing…" : "Generate blog post"}
              </Button>
            </>
          ) : (
            <>
              <span
                className={`mb-2 inline-block rounded-lg px-2 py-0.5 text-xs font-medium ${
                  post.status === "approved" ? "bg-success/10 text-success" : "bg-primary-pink/10 text-primary-pink"
                }`}
              >
                {post.status === "approved" ? "Approved" : "Draft — needs review"}
              </span>
              {editing ? (
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={10}
                  className="w-full rounded-lg border border-border bg-background p-3 text-sm text-foreground focus:border-primary-pink focus:outline-none"
                />
              ) : (
                <p className="whitespace-pre-wrap text-sm text-foreground">{displayedContent}</p>
              )}
              <div className="mt-3 flex gap-2">
                {editing ? (
                  <>
                    <Button onClick={() => updateStatus("edited", editText)} className="min-h-11 flex-1">
                      Save &amp; approve
                    </Button>
                    <Button variant="secondary" onClick={() => setEditing(false)} className="min-h-11">
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    {post.status !== "approved" && (
                      <Button onClick={() => updateStatus("approved")} className="min-h-11 flex-1">
                        Approve
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      className="min-h-11 flex-1"
                      onClick={() => {
                        setEditing(true);
                        setEditText(displayedContent);
                      }}
                    >
                      Edit
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
