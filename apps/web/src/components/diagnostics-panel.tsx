"use client";

// P4.4 / D30 — multi-diagnostic aggregation panel.
//
// Shown on the kernel-next task detail page when the server emits
// `diagnostics_emitted` events (e.g. on run_final with >0 stageErrors,
// or — future tiers — when a submit/migrate fails with multiple
// validation codes). Groups diagnostics by `code` so repeated codes
// collapse into a single expandable section with a count. Offers a
// Copy JSON button so users can paste the full batch into an issue
// or a chat with the author.
//
// Intentionally presentational: no SSE wiring, no state beyond the
// memoised grouping. The page component accumulates diagnostics
// across multiple events and passes the full list as a prop.

import { useMemo } from "react";

export interface Diagnostic {
  code: string;
  message: string;
  severity?: "error" | "warning";
}

export interface DiagnosticsPanelProps {
  diagnostics: Diagnostic[];
}

export function DiagnosticsPanel({ diagnostics }: DiagnosticsPanelProps) {
  const grouped = useMemo(() => {
    const map = new Map<string, Diagnostic[]>();
    for (const d of diagnostics) {
      const bucket = map.get(d.code) ?? [];
      bucket.push(d);
      map.set(d.code, bucket);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [diagnostics]);

  if (diagnostics.length === 0) return null;

  const handleCopy = (): void => {
    try {
      void navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
    } catch {
      // clipboard unavailable (e.g. jsdom / insecure context) — silently ignore.
    }
  };

  return (
    <section className="mb-6 rounded border border-red-300 bg-red-50 p-3 font-mono text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold text-red-900">
          Diagnostics ({diagnostics.length})
        </h2>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded border border-red-300 bg-white px-2 py-1 text-xs hover:bg-red-100"
        >
          Copy JSON
        </button>
      </div>
      {grouped.map(([code, items]) => (
        <details key={code} open className="mb-1">
          <summary className="cursor-pointer font-semibold text-red-800">
            {code} ({items.length})
          </summary>
          <ul className="ml-4 list-disc text-xs text-red-700">
            {items.map((d, i) => (
              <li key={`${code}-${i}`}>{d.message}</li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}
