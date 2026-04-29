"use client";

import { useState } from "react";
import { apiFetch } from "../../../lib/api-client";
import { ErrorBanner } from "../../../components/error-banner";
import { useToast } from "../../../components/toast";
import type { ApiDiagnostic } from "../../../lib/api-client";

const TEMPLATE = JSON.stringify({
  id: "my-mcp",
  schemaVersion: "1",
  name: "My MCP",
  description: "Short user-facing one-liner",
  useCases: ["..."],
  tags: ["..."],
  command: "npx",
  args: ["-y", "@scope/my-mcp"],
  envKeys: [],
  healthCheckTimeoutMs: 10000,
}, null, 2);

interface Props { onClose: () => void; onAdded: () => void; }

export const AddEntryDialog = ({ onClose, onAdded }: Props) => {
  const toast = useToast();
  const [text, setText] = useState(TEMPLATE);
  const [diagnostics, setDiagnostics] = useState<ApiDiagnostic[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    let body: unknown;
    try { body = JSON.parse(text); }
    catch (e) {
      setDiagnostics([{ code: "INVALID_JSON_BODY", message: e instanceof Error ? e.message : String(e) }]);
      return;
    }
    setSubmitting(true);
    setDiagnostics([]);
    const r = await apiFetch<{ entry: unknown }>("/api/kernel/mcp-catalog/entries", { method: "POST", body });
    setSubmitting(false);
    if (!r.ok) { setDiagnostics(r.diagnostics); return; }
    toast.success("Custom entry added");
    onAdded();
  };

  return (
    <div role="dialog" aria-modal="true"
      className="fixed inset-0 z-[10000] flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-12"
      onClick={onClose}>
      <div className="w-full max-w-2xl rounded-lg border border-strong bg-surface"
        onClick={(e) => e.stopPropagation()}>
        <header className="border-b border-default px-5 py-3">
          <h2 className="text-base font-semibold">Add custom catalog entry</h2>
          <p className="mt-0.5 text-xs text-muted">
            Paste a CatalogEntry JSON. <code className="font-mono">id</code> must be kebab-case and not collide with a builtin.
          </p>
        </header>
        <div className="space-y-3 p-5">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={20}
            className="w-full rounded border border-strong bg-page px-2 py-2 font-mono text-xs" />
          {diagnostics.length > 0 && <ErrorBanner diagnostics={diagnostics} />}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded border border-strong px-3 py-1.5 text-sm">Cancel</button>
            <button onClick={onSubmit} disabled={submitting}
              className="rounded border border-info-border bg-info-bg px-3 py-1.5 text-sm text-info-fg disabled:opacity-50">
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
