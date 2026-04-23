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
  proposal_id?: string | null;
  proposal_status?: string | null;
  rerun_from_stage?: string | null;
  diagnostic?: unknown;
}

interface AuditTimelineProps {
  entries: AuditEntry[];
}

const KIND_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  migrate:       { label: "migrate",        bg: "bg-purple-100", fg: "text-purple-800" },
  rollback:      { label: "rollback",       bg: "bg-amber-100",  fg: "text-amber-800" },
  migrate_failed:{ label: "migrate-failed", bg: "bg-red-100",    fg: "text-red-800" },
};

const PROPOSAL_STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  pending:  { bg: "bg-blue-100",  fg: "text-blue-700" },
  approved: { bg: "bg-green-100", fg: "text-green-700" },
  rejected: { bg: "bg-red-100",   fg: "text-red-700" },
};

export function AuditTimeline({ entries }: AuditTimelineProps) {
  if (entries.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-2 font-semibold">Hot-update audit ({entries.length})</h2>
      <ol className="relative ml-4 border-l-2 border-gray-200 pl-4">
        {entries.map((e) => {
          const style = KIND_STYLE[e.kind] ?? { label: e.kind, bg: "bg-gray-100", fg: "text-gray-700" };
          const proposalStyle = e.proposal_status
            ? (PROPOSAL_STATUS_STYLE[e.proposal_status] ?? { bg: "bg-gray-100", fg: "text-gray-700" })
            : null;

          return (
            <li key={e.event_id} className="relative mb-3">
              <span className="absolute -left-[1.4rem] top-1 h-2 w-2 rounded-full bg-gray-400" />
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={`rounded ${style.bg} px-1.5 py-0.5 text-xs font-semibold uppercase ${style.fg}`}>
                  {style.label}
                </span>
                <span className="text-xs text-gray-500">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-xs text-gray-700">
                  actor: <code>{e.actor}</code>
                </span>
                {e.from_version && e.to_version && (
                  <span className="text-xs text-gray-600">
                    <code>{e.from_version.slice(0, 8)}</code>
                    {" "}
                    <span aria-hidden="true">&rarr;</span>
                    {" "}
                    <code>{e.to_version.slice(0, 8)}</code>
                  </span>
                )}
                {e.rerun_from_stage && (
                  <span className="text-xs text-gray-500">
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
