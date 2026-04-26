"use client";

// Launch hub. Lists every pipeline registered in pipeline_versions and
// lets the user start a task with a typed input form, all without
// dropping out to MCP or curl.
//
// 2026-04-27 B2.

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../lib/api-client";
import type { ApiDiagnostic } from "../lib/api-client";
import { ErrorBanner } from "../components/error-banner";
import { CopyButton } from "../components/copy-button";
import { LaunchPipelineDialog } from "../components/launch-pipeline-dialog";

interface PipelineSummary {
  name: string;
  latestVersion: string;
  latestCreatedAt: number;
  externalInputs: Array<{ name: string; type: string }>;
  envKeys: string[];
}

const formatDate = (ms: number): string => {
  if (!ms || ms <= 0) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

export default function Home() {
  const [pipelines, setPipelines] = useState<PipelineSummary[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<ApiDiagnostic[]>([]);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState<PipelineSummary | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      const res = await apiFetch<{ pipelines: PipelineSummary[] }>(
        "/api/kernel/pipelines",
        { signal: ac.signal },
      );
      if (!res.ok) {
        setDiagnostics(res.diagnostics);
        setPipelines([]);
        return;
      }
      setPipelines(res.data.pipelines);
    })();
    return () => ac.abort();
  }, []);

  const filtered = (pipelines ?? []).filter((p) =>
    filter.length === 0 ? true : p.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Launch a pipeline</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Pick a pipeline, fill in inputs, and start a task. Live runs at{" "}
            <Link href="/kernel-next" className="text-sky-400 hover:underline">/kernel-next</Link>.
          </p>
        </div>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter pipelines…"
          className="w-64 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          aria-label="Filter pipelines"
        />
      </header>

      {diagnostics.length > 0 && (
        <ErrorBanner diagnostics={diagnostics} onDismiss={() => setDiagnostics([])} />
      )}

      {pipelines === null && <p className="text-sm text-zinc-500">Loading…</p>}

      {pipelines !== null && filtered.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 p-10 text-center">
          <p className="text-zinc-400">
            {pipelines.length === 0 ? "No pipelines installed yet." : "No matches."}
          </p>
          {pipelines.length === 0 && (
            <p className="mt-2 text-xs text-zinc-500">
              Builtin pipelines are seeded automatically on server start. Check that the kernel-next server is running.
            </p>
          )}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <article
              key={p.name}
              className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 transition-colors hover:border-zinc-700"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-mono text-sm font-semibold text-zinc-100">{p.name}</h2>
                <span className="text-[0.65rem] text-zinc-500">{formatDate(p.latestCreatedAt)}</span>
              </div>
              <div className="mt-1 flex items-center gap-1">
                <code className="font-mono text-[0.65rem] text-zinc-500">
                  {p.latestVersion.slice(0, 12)}…
                </code>
                <CopyButton value={p.latestVersion} label="hash" />
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-zinc-400">
                <dt className="text-zinc-500">inputs</dt>
                <dd className="text-right font-mono">{p.externalInputs.length}</dd>
                <dt className="text-zinc-500">secrets</dt>
                <dd className="text-right font-mono">
                  {p.envKeys.length === 0 ? "—" : p.envKeys.length}
                </dd>
              </dl>

              {p.envKeys.length > 0 && (
                <p className="mt-1 truncate font-mono text-[0.65rem] text-amber-400/80" title={p.envKeys.join(", ")}>
                  ⚿ {p.envKeys.join(", ")}
                </p>
              )}

              <div className="mt-auto flex gap-2 pt-3">
                <Link
                  href={`/kernel-next/pipelines/${encodeURIComponent(p.name)}`}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800"
                >
                  Inspect
                </Link>
                <button
                  type="button"
                  onClick={() => setActive(p)}
                  className="ml-auto rounded border border-blue-600 bg-blue-700 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  Launch →
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {active && (
        <LaunchPipelineDialog
          open={true}
          pipeline={active}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}
