"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../lib/api-client";

interface ImportDiagnostic {
  code: string;
  message?: string;
}

export interface ImportSuccessResult {
  versionHash: string;
  pipelineName: string;
  alreadyExisted: boolean;
}

interface ImportPipelineDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (result: ImportSuccessResult) => void;
}

export const ImportPipelineDialog = ({
  open,
  onClose,
  onImported,
}: ImportPipelineDialogProps) => {
  const [pasted, setPasted] = useState<string>("");
  const [fileText, setFileText] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [diagnostics, setDiagnostics] = useState<ImportDiagnostic[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPasted("");
      setFileText("");
      setFileName("");
      setDiagnostics([]);
      setSubmitting(false);
    }
  }, [open]);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      setFileText("");
      setFileName("");
      return;
    }
    setFileName(file.name);
    void file.text().then((txt) => setFileText(txt));
  }, []);

  const handleSubmit = useCallback(async () => {
    const body = fileText.trim() || pasted.trim();
    if (!body) return;
    setSubmitting(true);
    setDiagnostics([]);
    try {
      const res = await fetch(`${API_BASE}/api/kernel/pipelines/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const json = await res.json() as
        | (ImportSuccessResult & { ok: true })
        | { ok: false; diagnostics: ImportDiagnostic[] };
      if (res.ok && json.ok) {
        onImported({
          versionHash: json.versionHash,
          pipelineName: json.pipelineName,
          alreadyExisted: json.alreadyExisted,
        });
        return;
      }
      const diag = (json as { diagnostics?: ImportDiagnostic[] }).diagnostics ?? [];
      setDiagnostics(
        diag.length > 0
          ? diag
          : [{ code: `HTTP_${res.status}`, message: "import failed" }],
      );
    } catch (err) {
      setDiagnostics([{
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      }]);
    } finally {
      setSubmitting(false);
    }
  }, [fileText, pasted, onImported]);

  if (!open) return null;

  const canSubmit =
    (fileText.trim().length > 0 || pasted.trim().length > 0) && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-strong bg-surface p-5 shadow-lg">
        <h2 className="text-lg font-semibold">Import pipeline</h2>
        <p className="mt-1 text-sm text-secondary">
          Upload a <code className="rounded bg-elevated px-1 font-mono text-xs">.wfctl.json</code>{" "}
          file exported from another instance, or paste the JSON directly.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-secondary">
              File
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.wfctl.json,application/json"
              onChange={handleFile}
              className="mt-1 block w-full text-sm text-secondary file:mr-3 file:rounded file:border file:border-strong file:bg-elevated file:px-3 file:py-1 file:text-sm file:text-primary"
            />
            {fileName && (
              <p className="mt-1 text-xs text-muted">selected: {fileName}</p>
            )}
          </div>

          <div className="text-center text-xs uppercase tracking-wide text-muted">
            — or —
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-secondary">
              Paste JSON
            </label>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="Paste pipeline export JSON here…"
              rows={8}
              className="mt-1 block w-full rounded border border-strong bg-surface p-2 font-mono text-xs text-primary focus:outline-none focus:border-strong"
              disabled={submitting || fileText.trim().length > 0}
            />
            {fileText.trim().length > 0 && (
              <p className="mt-1 text-xs text-muted">
                Textarea disabled because a file is selected. Clear file selection to paste.
              </p>
            )}
          </div>

          {diagnostics.length > 0 && (
            <div className="rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger-fg">
              <p className="font-semibold">Import failed</p>
              <ul className="mt-1 space-y-1 text-xs">
                {diagnostics.map((d, i) => (
                  <li key={i}>
                    <code className="font-mono">{d.code}</code>
                    {d.message ? `: ${d.message}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-strong bg-surface px-3 py-1.5 text-sm hover:bg-elevated"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="rounded border border-info-border bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
};
