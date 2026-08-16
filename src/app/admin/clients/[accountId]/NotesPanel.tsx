"use client";

import { useState } from "react";

type Note = { id: string; body: string; createdAt: string };

export function NotesPanel({ accountId, initialNotes }: { accountId: string; initialNotes: Note[] }) {
  const [notes, setNotes] = useState(initialNotes);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  async function addNote() {
    if (!text.trim()) return;
    setSaving(true);
    const response = await fetch(`/api/admin/clients/${accountId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text }),
    });
    if (response.ok) {
      const note = await response.json();
      setNotes((prev) => [{ id: note.id, body: note.body, createdAt: note.createdAt }, ...prev]);
      setText("");
    }
    setSaving(false);
  }

  return (
    <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <h2 className="mb-3 text-sm font-medium text-neutral-400">Internal notes</h2>
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Note visible only to admins…"
          rows={2}
          className="flex-1 rounded-lg border border-neutral-700 bg-neutral-800 p-2 text-sm text-neutral-200 focus:border-neutral-500 focus:outline-none"
        />
        <button
          onClick={addNote}
          disabled={saving}
          className="tap-scale min-h-11 shrink-0 rounded-lg border border-neutral-700 px-3 text-sm text-neutral-200 disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {notes.map((note) => (
          <li key={note.id} className="rounded-lg bg-neutral-800 p-2 text-sm text-neutral-300">
            {note.body}
            <span className="mt-1 block text-[10px] text-neutral-500">{new Date(note.createdAt).toLocaleString()}</span>
          </li>
        ))}
        {notes.length === 0 && <li className="text-sm text-neutral-500">No notes yet.</li>}
      </ul>
    </div>
  );
}
