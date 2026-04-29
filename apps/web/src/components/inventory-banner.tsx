"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api-client";

interface Props {
  envKeys: string[];
  layout?: "compact" | "full";
}

interface LookupResp {
  mapping: Record<string, string | null>;
  statuses: Record<string, string>;
}

export const InventoryBanner = ({ envKeys, layout = "compact" }: Props) => {
  const [data, setData] = useState<LookupResp | null>(null);

  useEffect(() => {
    if (envKeys.length === 0) return;
    void apiFetch<LookupResp>(
      `/api/kernel/mcp-catalog/lookup-by-envkey?names=${envKeys.map(encodeURIComponent).join(",")}`,
    ).then((r) => { if (r.ok) setData(r.data); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envKeys.join("|")]);

  if (!data) return null;
  const items = envKeys
    .map((k) => ({
      envKey: k,
      entryId: data.mapping[k],
      status: data.mapping[k] ? data.statuses[data.mapping[k]!] : null,
    }))
    .filter((it) => it.entryId !== null);
  if (items.length === 0) return null;

  if (layout === "compact") {
    return (
      <div className="rounded border border-strong bg-surface px-3 py-2 text-xs">
        <span className="font-semibold text-secondary">Inventory:</span>
        <ul className="mt-1 space-y-0.5">
          {items.map((it) => (
            <li key={it.envKey}>
              <span className="font-mono text-secondary">{it.envKey}</span>{" "}→{" "}
              <a className="text-accent underline" href={`/kernel-next/mcp-catalog`}>{it.entryId}</a>
              {" "}<span className="text-muted">({it.status})</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="rounded border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">
      Some required secrets map to MCP catalog entries.{" "}
      <a className="underline" href="/kernel-next/mcp-catalog">Equip them</a>{" "}to save the values once and reuse across runs.
    </div>
  );
};
