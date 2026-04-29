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
 */
export const ErrorBanner = ({ diagnostics, onDismiss, title }: ErrorBannerProps) => {
  if (diagnostics.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-danger-fg">
          {title ?? `${diagnostics.length === 1 ? "Error" : `${diagnostics.length} errors`}`}
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="rounded text-danger-fg opacity-80 hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-danger-border"
          >
            ✕
          </button>
        )}
      </div>
      <ul className="mt-2 space-y-2">
        {diagnostics.map((d, i) => {
          const hint = diagnosticHint(d.code);
          return (
            <li key={i} className="border-l-2 border-danger-border pl-3">
              <div className="flex items-baseline gap-2">
                <code className="rounded border border-danger-border bg-page px-1.5 py-0.5 font-mono text-xs text-danger-fg">
                  {d.code}
                </code>
                <span className="text-danger-fg">{d.message}</span>
              </div>
              {hint && (
                <p className="mt-1 text-xs text-danger-fg opacity-80">→ {hint}</p>
              )}
              {d.context && Object.keys(d.context).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-danger-fg opacity-80 hover:opacity-100">
                    show context
                  </summary>
                  <pre className="mt-1 overflow-x-auto rounded border border-danger-border bg-page p-2 text-xs text-danger-fg">
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
