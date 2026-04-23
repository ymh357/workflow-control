"use client";

// Multi-textarea editor for a pipeline's prompts map. Pure component:
// owns the editable state (textarea values), emits only modified refs
// on submit, displays inline errors from the upstream HTTP call.
// Parent owns `actor` (single source of truth across pages).

import { useState } from "react";

type SubmitResult = { ok: true } | { ok: false; error: string };

interface Props {
  originalPrompts: Record<string, string>;
  actor: string;
  onActorChange: (next: string) => void;
  onSubmit: (modified: Record<string, string>) => Promise<SubmitResult>;
}

export function PromptsEditor({ originalPrompts, actor, onActorChange, onSubmit }: Props) {
  // Local mutable state mirrors originalPrompts at first render and
  // diverges as the user types. modifiedRefs is derived (not stored)
  // so stale state can't drift from textarea values.
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...originalPrompts }));
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const refs = Object.keys(originalPrompts).sort();
  if (refs.length === 0) {
    return (
      <p className="text-sm italic text-gray-600">
        No editable prompts in this pipeline — nothing to iterate via this UI yet.
      </p>
    );
  }

  const modifiedEntries = refs.filter((r) => draft[r] !== originalPrompts[r]);
  const canSubmit = modifiedEntries.length > 0 && actor.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    setSubmitting(true);
    setErrorMsg(null);
    const payload: Record<string, string> = {};
    for (const r of modifiedEntries) payload[r] = draft[r]!;
    try {
      const result = await onSubmit(payload);
      if (!result.ok) setErrorMsg(result.error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-semibold">Actor (required)</span>
        <input
          type="text"
          value={actor}
          onChange={(e) => onActorChange(e.target.value)}
          placeholder="human:ymh"
          className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 font-mono text-sm"
        />
      </label>

      {refs.map((ref) => {
        const modified = draft[ref] !== originalPrompts[ref];
        return (
          <label key={ref} className="block">
            <span className="text-sm font-semibold">
              {ref}{" "}
              {modified && (
                <span className="ml-1 rounded bg-amber-200 px-1 text-[10px] uppercase text-amber-900">
                  modified
                </span>
              )}
            </span>
            <textarea
              value={draft[ref] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [ref]: e.target.value }))}
              rows={10}
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs"
            />
          </label>
        );
      })}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void handleSubmit()}
        className="rounded bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Submit proposal"}
      </button>

      {errorMsg && (
        <p className="text-sm text-red-700">submit failed: {errorMsg}</p>
      )}
    </div>
  );
}
