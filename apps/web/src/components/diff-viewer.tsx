"use client";

// DiffViewer renders a unified diff with colored +/- lines (P6.4 / D27).
// Used in the attempts sub-table to show per-attempt worktree changes.

export interface DiffViewerProps {
  diff: string;
  beforeSha?: string | null;
  afterSha?: string | null;
  // Checkpoint status from stage_checkpoints.status. When present AND
  // the diff is empty, the message changes to reflect WHY (capture still
  // in progress vs. checkpoint disabled vs. not a git repo vs. diff too
  // large). When absent or diff non-empty, status is ignored.
  status?: string;
}

const EMPTY_DIFF_MSG: Record<string, string> = {
  capturing: "Checkpoint still capturing…",
  captured: "No diff (stage made no changes).",
  before_failed: "Before-snapshot failed; no diff available.",
  after_failed: "After-snapshot failed; no diff available.",
  not_a_repo: "Worktree is not a git repository; no diff recorded.",
  disabled: "Checkpoint disabled for this stage.",
  diff_too_large: "Diff exceeded size cap; not stored.",
};

export function DiffViewer({ diff, beforeSha, afterSha, status }: DiffViewerProps) {
  if (!diff || diff.trim().length === 0) {
    const msg = (status && EMPTY_DIFF_MSG[status]) ?? "No diff (stage made no changes).";
    return <p className="text-xs text-gray-500">{msg}</p>;
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
