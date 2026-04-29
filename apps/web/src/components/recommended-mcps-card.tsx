"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api-client";

export interface RecommendedMcpEntry {
  entryId: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  envKeys: string[];
  reason: string;
}

interface Props {
  recommendedMcps: RecommendedMcpEntry[];
}

const STATUS_COLOR: Record<string, string> = {
  "equipped":        "border-success-border bg-success-bg text-success-fg",
  "pending-secret":  "border-warning-border bg-warning-bg text-warning-fg",
  "unhealthy":       "border-danger-border bg-danger-bg text-danger-fg",
  "not-equipped":    "border-strong bg-elevated text-secondary",
};

export const RecommendedMcpsCard = ({ recommendedMcps }: Props) => {
  const [statuses, setStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    if (recommendedMcps.length === 0) return;

    // Build inventory query. We need both:
    //   (a) per-entry inventory rows (resolved via lookup-by-envkey when keys exist)
    //   (b) per-entry inventory rows for entries without envKeys (resolved
    //       via direct GET /inventory/:entryId — those entries can still be
    //       'equipped' or 'not-equipped' based on whether the user has run
    //       the package check, even though they don't need secrets).
    const allKeys = new Set<string>();
    for (const r of recommendedMcps) for (const k of r.envKeys) allKeys.add(k);
    const noKeyEntryIds = recommendedMcps.filter((r) => r.envKeys.length === 0).map((r) => r.entryId);

    const ac = new AbortController();
    const merged: Record<string, string> = {};

    const tasks: Promise<unknown>[] = [];
    if (allKeys.size > 0) {
      tasks.push(
        apiFetch<{ mapping: Record<string, string | null>; statuses: Record<string, string> }>(
          `/api/kernel/mcp-catalog/lookup-by-envkey?names=${[...allKeys].map(encodeURIComponent).join(",")}`,
          { signal: ac.signal },
        ).then((r) => { if (r.ok) Object.assign(merged, r.data.statuses); }),
      );
    }
    for (const eid of noKeyEntryIds) {
      tasks.push(
        apiFetch<{ row: { status: string } | null }>(
          `/api/kernel/mcp-catalog/inventory/${encodeURIComponent(eid)}`,
          { signal: ac.signal },
        ).then((r) => {
          if (r.ok) merged[eid] = r.data.row?.status ?? "not-equipped";
        }),
      );
    }

    void Promise.all(tasks).then(() => {
      if (!ac.signal.aborted) setStatuses((prev) => ({ ...prev, ...merged }));
    });

    return () => ac.abort();
  // The dependency is a stable string derived from the entry ids; envKeys
  // changes within the same id set are not expected to occur for an
  // already-rendered awaitingConfirm gate context.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendedMcps.map((r) => r.entryId).sort().join("|")]);

  if (recommendedMcps.length === 0) return null;

  return (
    <section className="rounded-lg border border-info-border bg-info-bg p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-accent">
        Recommended Tools ({recommendedMcps.length})
      </h4>
      <p className="mt-1 text-xs text-secondary">
        Approving will commit these MCP servers to the generated pipeline. You can equip them now or after approval.
      </p>
      <ul className="mt-2 space-y-2">
        {recommendedMcps.map((r) => {
          const status = statuses[r.entryId] ?? "not-equipped";
          const color = STATUS_COLOR[status] ?? STATUS_COLOR["not-equipped"];
          return (
            <li key={r.entryId} className="rounded border border-strong bg-surface p-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-accent">{r.entryId}</span>
                <span className={`rounded border px-1.5 py-0.5 text-xs uppercase tracking-wide ${color}`}>
                  {status}
                </span>
                {status !== "equipped" && (
                  <a
                    href={`/kernel-next/mcp-catalog`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto text-xs text-accent underline"
                  >
                    前往装备 ↗
                  </a>
                )}
              </div>
              <p className="mt-1 text-xs text-secondary">{r.reason}</p>
              {r.envKeys.length > 0 && (
                <p className="mt-1 font-mono text-xs text-muted">
                  envKeys: {r.envKeys.join(", ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
