"use client";

// DiffViewer renders a unified diff with colored +/- lines (P6.4 / D27).
// Used in the attempts sub-table to show per-attempt worktree changes.

export interface DiffViewerProps {
  diff: string;
  beforeSha?: string | null;
  afterSha?: string | null;
}

export function DiffViewer({ diff, beforeSha, afterSha }: DiffViewerProps) {
  if (!diff || diff.trim().length === 0) {
    return <p className="text-xs text-gray-500">No diff (stage made no changes).</p>;
  }

  const lines = diff.split("\n");
  return (
    <div className="font-mono text-xs">
      {(beforeSha || afterSha) && (
        <div className="mb-1 text-gray-500">
          {beforeSha && <code>{beforeSha.slice(0, 8)}</code>}
          {beforeSha && afterSha && " → "}
          {afterSha && <code>{afterSha.slice(0, 8)}</code>}
        </div>
      )}
      <pre className="overflow-auto rounded bg-gray-900 p-2 leading-tight">
        {lines.map((l, i) => {
          const cls =
            l.startsWith("+++") || l.startsWith("---") ? "text-gray-400"
            : l.startsWith("+") ? "text-green-400"
            : l.startsWith("-") ? "text-red-400"
            : l.startsWith("@") ? "text-cyan-400"
            : "text-gray-200";
          return (
            <div key={i} className={cls}>
              {l || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
