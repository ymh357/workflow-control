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
      <p className="text-sm italic text-muted">
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
        <span className="text-sm font-medium text-secondary">Actor (required)</span>
        <input
          type="text"
          value={actor}
          onChange={(e) => onActorChange(e.target.value)}
          placeholder="human:ymh"
          className="mt-1 block w-full rounded border border-strong bg-surface px-2 py-1 font-mono text-sm text-primary placeholder:text-muted focus:border-strong focus:outline-none"
        />
      </label>

      {refs.map((ref) => {
        const modified = draft[ref] !== originalPrompts[ref];
        return (
          <label key={ref} className="block">
            <span className="text-sm font-medium text-secondary">
              {ref}
              {modified && (
                <span className="ml-2 rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-warning-fg">
                  modified
                </span>
              )}
            </span>
            <textarea
              value={draft[ref] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [ref]: e.target.value }))}
              rows={10}
              className="mt-1 block w-full rounded border border-strong bg-surface px-2 py-1 font-mono text-xs text-primary focus:border-strong focus:outline-none"
            />
          </label>
        );
      })}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          className="rounded border border-warning-border bg-warning-bg px-4 py-2 text-sm font-semibold text-warning-fg hover:border-warning-border hover:bg-warning-bg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Submitting…" : "Submit proposal"}
        </button>
        {modifiedEntries.length > 0 && (
          <span className="text-xs text-muted">
            {modifiedEntries.length} prompt{modifiedEntries.length === 1 ? "" : "s"} modified
          </span>
        )}
      </div>

      {errorMsg && (
        <p className="rounded border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          submit failed: {errorMsg}
        </p>
      )}
    </div>
  );
}
