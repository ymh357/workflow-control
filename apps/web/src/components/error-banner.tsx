"use client";

import type { ApiDiagnostic } from "../lib/api-client";
import { diagnosticHint } from "../lib/api-client";

interface ErrorBannerProps {
  diagnostics: ApiDiagnostic[];
  onDismiss?: () => void;
  title?: string;
}

/**
 * Standardized diagnostic display. Renders code, message, optional
 * actionable hint, and any structured context from the kernel-next
 * envelope. All rows are visible — no "first error wins" hiding.
 *
 * 2026-04-27 B9.
 */
export const ErrorBanner = ({ diagnostics, onDismiss, title }: ErrorBannerProps) => {
  if (diagnostics.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-500/50 bg-red-950/40 px-4 py-3 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-red-200">
          {title ?? `${diagnostics.length === 1 ? "Error" : `${diagnostics.length} errors`}`}
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="rounded text-red-300 hover:text-red-100 focus:outline-none focus:ring-1 focus:ring-red-400"
          >
            ✕
          </button>
        )}
      </div>
      <ul className="mt-2 space-y-2">
        {diagnostics.map((d, i) => {
          const hint = diagnosticHint(d.code);
          return (
            <li key={i} className="border-l-2 border-red-700 pl-3">
              <div className="flex items-baseline gap-2">
                <code className="rounded bg-red-900/50 px-1.5 py-0.5 font-mono text-[0.7rem] text-red-200">
                  {d.code}
                </code>
                <span className="text-red-100">{d.message}</span>
              </div>
              {hint && (
                <p className="mt-1 text-xs text-red-200/80">→ {hint}</p>
              )}
              {d.context && Object.keys(d.context).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[0.7rem] text-red-300/80 hover:text-red-200">
                    show context
                  </summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-red-950/60 p-2 text-[0.7rem] text-red-200/90">
                    {JSON.stringify(d.context, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
