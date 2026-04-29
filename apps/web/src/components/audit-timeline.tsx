"use client";

// P6.3 / D26 — hot-update audit trail timeline component.
//
// Renders a vertical timeline of AuditEntry items from
// GET /api/kernel/tasks/:taskId/audit. Each entry shows a
// kind-coloured badge, timestamp, actor, and (for migrate/rollback)
// truncated from/to version hashes. Returns null when entries is empty
// so the page can omit the section entirely without extra conditionals.

export interface AuditEntry {
  event_id: string;
  kind: string;
  actor: string;
  from_version?: string | null;
  to_version?: string | null;
  timestamp: number;
  // Server also returns `finished_at` — when non-null the entry rendered
  // a duration badge alongside the timestamp. Null means the migration /
  // rollback never settled (interrupted, crashed).
  finished_at?: number | null;
  proposal_id?: string | null;
  proposal_status?: string | null;
  rerun_from_stage?: string | null;
  diagnostic?: unknown;
}

function formatAuditDuration(startedAt: number, finishedAt: number): string {
  const ms = finishedAt - startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

interface AuditTimelineProps {
  entries: AuditEntry[];
}

const KIND_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  migrate:       { label: "migrate",        bg: "bg-info-bg", fg: "text-info-fg" },
  rollback:      { label: "rollback",       bg: "bg-warning-bg",  fg: "text-warning-fg" },
  migrate_failed:{ label: "migrate-failed", bg: "bg-danger-bg",    fg: "text-danger-fg" },
};

const PROPOSAL_STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  pending:  { bg: "bg-info-bg",     fg: "text-accent" },
  approved: { bg: "bg-success-bg", fg: "text-success-fg" },
  rejected: { bg: "bg-danger-bg",     fg: "text-danger-fg" },
};

export function AuditTimeline({ entries }: AuditTimelineProps) {
  if (entries.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-2 font-semibold text-primary">Hot-update audit ({entries.length})</h2>
      <ol className="relative ml-4 border-l-2 border-default pl-4">
        {entries.map((e) => {
          const style = KIND_STYLE[e.kind] ?? { label: e.kind, bg: "bg-elevated", fg: "text-secondary" };
          const proposalStyle = e.proposal_status
            ? (PROPOSAL_STATUS_STYLE[e.proposal_status] ?? { bg: "bg-elevated", fg: "text-secondary" })
            : null;

          return (
            <li key={e.event_id} className="relative mb-3">
              <span className="absolute -left-[1.4rem] top-1 h-2 w-2 rounded-full bg-elevated" />
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={`rounded ${style.bg} px-1.5 py-0.5 text-xs font-semibold uppercase ${style.fg}`}>
                  {style.label}
                </span>
                <span className="text-xs text-muted">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
                {typeof e.finished_at === "number" && (
                  <span className="text-xs text-muted" title="Migration duration">
                    &middot; {formatAuditDuration(e.timestamp, e.finished_at)}
                  </span>
                )}
                <span className="text-xs text-secondary">
                  actor: <code>{e.actor}</code>
                </span>
                {e.from_version && e.to_version && (
                  <span className="text-xs text-secondary">
                    <code>{e.from_version.slice(0, 8)}</code>
                    {" "}
                    <span aria-hidden="true">&rarr;</span>
                    {" "}
                    <code>{e.to_version.slice(0, 8)}</code>
                  </span>
                )}
                {e.rerun_from_stage && (
                  <span className="text-xs text-muted">
                    rerun from: <code>{e.rerun_from_stage}</code>
                  </span>
                )}
                {proposalStyle && e.proposal_status && (
                  <span className={`rounded ${proposalStyle.bg} px-1.5 py-0.5 text-xs ${proposalStyle.fg}`}>
                    proposal: {e.proposal_status}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
