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
  "equipped":        "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  "pending-secret":  "border-amber-500/40 bg-amber-500/10 text-amber-300",
  "unhealthy":       "border-red-500/40 bg-red-500/10 text-red-300",
  "not-equipped":    "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
};

export const RecommendedMcpsCard = ({ recommendedMcps }: Props) => {
  const [statuses, setStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    if (recommendedMcps.length === 0) return;
    const allKeys = new Set<string>();
    for (const r of recommendedMcps) for (const k of r.envKeys) allKeys.add(k);
    if (allKeys.size === 0) {
      const fallback: Record<string, string> = {};
      for (const r of recommendedMcps) fallback[r.entryId] = "not-equipped";
      setStatuses(fallback);
      return;
    }
    void apiFetch<{ mapping: Record<string, string | null>; statuses: Record<string, string> }>(
      `/api/kernel/mcp-catalog/lookup-by-envkey?names=${[...allKeys].map(encodeURIComponent).join(",")}`,
    ).then((r) => { if (r.ok) setStatuses(r.data.statuses); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendedMcps.map((r) => r.entryId).sort().join("|")]);

  if (recommendedMcps.length === 0) return null;

  return (
    <section className="rounded-lg border border-sky-700/40 bg-sky-700/5 p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-sky-300">
        Recommended Tools ({recommendedMcps.length})
      </h4>
      <p className="mt-1 text-[0.7rem] text-zinc-400">
        Approving will commit these MCP servers to the generated pipeline. You can equip them now or after approval.
      </p>
      <ul className="mt-2 space-y-2">
        {recommendedMcps.map((r) => {
          const status = statuses[r.entryId] ?? "not-equipped";
          const color = STATUS_COLOR[status] ?? STATUS_COLOR["not-equipped"];
          return (
            <li key={r.entryId} className="rounded border border-zinc-700 bg-zinc-900/80 p-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-sky-300">{r.entryId}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[0.55rem] uppercase tracking-wide ${color}`}>
                  {status}
                </span>
                {status !== "equipped" && (
                  <a
                    href={`/kernel-next/mcp-catalog`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto text-[0.65rem] text-sky-400 underline"
                  >
                    前往装备 ↗
                  </a>
                )}
              </div>
              <p className="mt-1 text-[0.7rem] text-zinc-300">{r.reason}</p>
              {r.envKeys.length > 0 && (
                <p className="mt-1 font-mono text-[0.6rem] text-zinc-500">
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
