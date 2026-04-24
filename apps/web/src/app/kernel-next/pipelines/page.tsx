"use client";

// /kernel-next/pipelines — list all known pipelines with their latest
// version. Click-through navigates to the per-pipeline editor at
// /kernel-next/pipelines/[name].

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface PipelineSummary {
  name: string;
  latestVersion: string;
  latestCreatedAt: number;
}

function formatTimestamp(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString(undefined, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function relativeTime(ms: number): string {
  if (!ms || ms <= 0) return "";
  const delta = Math.floor((Date.now() - ms) / 1000);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`;
  return "";
}

export default function PipelinesPage() {
  const [pipelines, setPipelines] = useState<PipelineSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<string>("");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/kernel/pipelines`, { signal: controller.signal });
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          setPipelines([]);
          return;
        }
        const body = await res.json() as { ok: boolean; pipelines: PipelineSummary[] };
        setPipelines(body.ok ? body.pipelines : []);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setPipelines([]);
      }
    })();
    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    if (!pipelines) return null;
    if (!query.trim()) return pipelines;
    const q = query.toLowerCase();
    return pipelines.filter((p) =>
      p.name.toLowerCase().includes(q) || p.latestVersion.toLowerCase().includes(q),
    );
  }, [pipelines, query]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Pipelines</h1>
          {pipelines !== null && (
            <span className="text-sm text-zinc-500">
              {pipelines.length} total
              {filtered && filtered.length !== pipelines.length && ` · ${filtered.length} match`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <input
            type="search"
            placeholder="Filter by name or hash…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-64 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
          />
          <Link
            href="/kernel-next"
            className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 hover:border-zinc-600 hover:bg-zinc-800"
          >
            tasks
          </Link>
          <Link
            href="/kernel-next/proposals"
            className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 hover:border-zinc-600 hover:bg-zinc-800"
          >
            proposals
          </Link>
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {pipelines === null && <div className="text-sm text-zinc-500">Loading…</div>}

      {pipelines !== null && pipelines.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 p-10 text-center">
          <p className="text-zinc-400">No pipelines registered yet.</p>
          <p className="mt-2 text-xs text-zinc-500">
            Submit via MCP <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono">submit_pipeline</code> or
            use <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono">pipeline-generator</code>.
          </p>
        </div>
      )}

      {filtered && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-900/70 text-xs uppercase tracking-wide text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Name</th>
                <th className="px-3 py-2 text-left font-semibold">Latest version</th>
                <th className="px-3 py-2 text-left font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr
                  key={p.name}
                  className="border-t border-zinc-800 hover:bg-zinc-900/40 transition-colors"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/kernel-next/pipelines/${encodeURIComponent(p.name)}`}
                      className="text-sky-400 hover:text-sky-300 hover:underline"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-400" title={p.latestVersion}>
                    {p.latestVersion.slice(0, 16)}…
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">
                    <span>{formatTimestamp(p.latestCreatedAt)}</span>
                    {relativeTime(p.latestCreatedAt) && (
                      <span className="ml-2 text-zinc-600">{relativeTime(p.latestCreatedAt)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filtered && filtered.length === 0 && pipelines !== null && pipelines.length > 0 && (
        <p className="text-sm text-zinc-500">No pipelines match <code className="rounded bg-zinc-800 px-1 font-mono">{query}</code>.</p>
      )}
    </div>
  );
}
