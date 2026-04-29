"use client";

// Launch hub. Lists every pipeline registered in pipeline_versions and
// lets the user start a task with a typed input form, all without
// dropping out to MCP or curl.

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../lib/api-client";
import type { ApiDiagnostic } from "../lib/api-client";
import { ErrorBanner } from "../components/error-banner";
import { CopyButton } from "../components/copy-button";
import { LaunchPipelineDialog } from "../components/launch-pipeline-dialog";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

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
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Launch a pipeline</h1>
          <p className="mt-1 text-sm text-secondary">
            Pick a pipeline, fill in inputs, and start a task. Live runs at{" "}
            <Link href="/kernel-next" className="text-accent hover:underline">/kernel-next</Link>.
          </p>
        </div>
        <Input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter pipelines…"
          className="w-64"
          aria-label="Filter pipelines"
        />
      </header>

      {diagnostics.length > 0 && (
        <ErrorBanner diagnostics={diagnostics} onDismiss={() => setDiagnostics([])} />
      )}

      {pipelines === null && <p className="text-sm text-muted">Loading…</p>}

      {pipelines !== null && filtered.length === 0 && (
        <div className="rounded-lg border border-dashed border-default bg-surface p-10 text-center">
          <p className="text-secondary">
            {pipelines.length === 0 ? "No pipelines installed yet." : "No matches."}
          </p>
          {pipelines.length === 0 && (
            <p className="mt-2 text-xs text-muted">
              Builtin pipelines are seeded automatically on server start. Check that the kernel-next server is running.
            </p>
          )}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <Card
              key={p.name}
              as="article"
              className="flex flex-col transition-colors hover:border-strong"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-mono text-sm font-semibold text-primary">{p.name}</h2>
                <span className="text-xs text-muted">{formatDate(p.latestCreatedAt)}</span>
              </div>
              <div className="mt-1 flex items-center gap-1">
                <code className="font-mono text-xs text-muted">
                  {p.latestVersion.slice(0, 12)}…
                </code>
                <CopyButton value={p.latestVersion} label="hash" />
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-secondary">
                <dt className="text-muted">inputs</dt>
                <dd className="text-right font-mono">{p.externalInputs.length}</dd>
                <dt className="text-muted">secrets</dt>
                <dd className="text-right font-mono">
                  {p.envKeys.length === 0 ? "—" : p.envKeys.length}
                </dd>
              </dl>

              {p.envKeys.length > 0 && (
                <p className="mt-1 truncate font-mono text-xs text-warning-fg" title={p.envKeys.join(", ")}>
                  ⚿ {p.envKeys.join(", ")}
                </p>
              )}

              <div className="mt-auto flex gap-2 pt-3">
                <Link
                  href={`/kernel-next/pipelines/${encodeURIComponent(p.name)}`}
                  className="inline-flex items-center justify-center rounded border border-strong bg-surface px-2.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-elevated hover:text-primary"
                >
                  Inspect
                </Link>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setActive(p)}
                >
                  Launch →
                </Button>
              </div>
            </Card>
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
