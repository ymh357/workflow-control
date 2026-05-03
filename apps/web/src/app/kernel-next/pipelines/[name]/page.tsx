"use client";

// /kernel-next/pipelines/[name] — pick the pipeline's latest version,
// fetch its IR + prompts, render PromptsEditor; on submit, POST a
// prompts-only proposal to /api/kernel/proposals and redirect to
// /kernel-next/proposals.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PromptsEditor } from "../../../../components/prompts-editor";
import { PipelineGraph } from "../../../../components/pipeline-graph";
import { LaunchPipelineDialog } from "../../../../components/launch-pipeline-dialog";
import { CopyButton } from "../../../../components/copy-button";
import { API_BASE } from "../../../../lib/api-client";
import type { PipelineIRLike } from "../../../../lib/ir-to-flow";
const ACTOR_LS_KEY = "kernelActor";

interface PipelineDetail {
  name: string;
  latestVersion: string;
  prompts: Record<string, string>;
  ir: PipelineIRLike;
}

export default function PipelineEditorPage() {
  const params = useParams();
  const router = useRouter();
  const nameRaw = params?.name;
  const rawSegment = Array.isArray(nameRaw) ? nameRaw[0]! : (nameRaw as string | undefined);
  // Next.js's useParams() returns the URL segment verbatim — spaces in a
  // pipeline name (e.g. "Export Linear Tasks") arrive here as
  // "Export%20Linear%20Tasks" and won't match the decoded name returned
  // by the /api/kernel/pipelines list route.
  const pipelineName = rawSegment ? decodeURIComponent(rawSegment) : undefined;

  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [actor, setActor] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);

  useEffect(() => {
    // Prefill actor from localStorage so repeat users don't re-type.
    // Wrapped in try/catch because jsdom in some test configurations
    // ships Storage as a bare interface without method implementations.
    try {
      const saved = window.localStorage.getItem(ACTOR_LS_KEY);
      if (saved) setActor(saved);
    } catch { /* storage unavailable — skip prefill */ }
  }, []);

  useEffect(() => {
    if (!pipelineName) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const listRes = await fetch(`${API_BASE}/api/kernel/pipelines`, { signal: controller.signal });
        if (!listRes.ok) { setError(`list HTTP ${listRes.status}`); return; }
        const listBody = await listRes.json() as {
          ok: boolean;
          pipelines: Array<{ name: string; latestVersion: string }>;
        };
        const match = listBody.pipelines.find((p) => p.name === pipelineName);
        if (!match) { setError(`pipeline '${pipelineName}' not found`); return; }

        const detailRes = await fetch(
          `${API_BASE}/api/kernel/pipelines/${encodeURIComponent(match.latestVersion)}`,
          { signal: controller.signal },
        );
        if (!detailRes.ok) { setError(`detail HTTP ${detailRes.status}`); return; }
        const detailBody = await detailRes.json() as {
          ok: boolean;
          prompts: Record<string, string>;
          ir: PipelineIRLike;
        };
        if (!detailBody.ok) { setError("detail not ok"); return; }
        setDetail({
          name: pipelineName,
          latestVersion: match.latestVersion,
          prompts: detailBody.prompts,
          ir: detailBody.ir,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => controller.abort();
  }, [pipelineName]);

  const handleSubmit = useCallback(async (modified: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!detail) return { ok: false, error: "pipeline not loaded" };
    try {
      const res = await fetch(new Request(`${API_BASE}/api/kernel/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentVersion: detail.latestVersion,
          patch: { ops: [] },
          actor,
          prompts: modified,
        }),
      }));
      const body = await res.json() as {
        ok: boolean;
        diagnostics?: Array<{ code: string; message: string }>;
      };
      if (!res.ok || !body.ok) {
        const diag = body.diagnostics?.[0];
        return { ok: false, error: diag ? `${diag.code}: ${diag.message}` : `HTTP ${res.status}` };
      }
      try { window.localStorage.setItem(ACTOR_LS_KEY, actor); } catch { /* storage unavailable */ }
      router.push("/kernel-next/proposals");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [detail, actor, router]);

  if (!pipelineName) return <p className="text-sm text-secondary">Missing pipeline name.</p>;
  if (error) {
    return (
      <div className="rounded border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
        Error: {error}
      </div>
    );
  }
  if (!detail) return <p className="text-sm text-muted">Loading…</p>;

  const externalInputs = detail.ir?.externalInputs ?? [];
  const stageCount = detail.ir?.stages?.length ?? 0;
  const envKeysSet = new Set<string>();
  for (const stage of detail.ir?.stages ?? []) {
    type Mcp = { envKeys?: string[] };
    type StageWithMcp = { config?: { mcpServers?: Mcp[] } };
    const cfg = (stage as StageWithMcp).config;
    for (const m of cfg?.mcpServers ?? []) {
      for (const k of m.envKeys ?? []) envKeysSet.add(k);
    }
  }
  const envKeys = Array.from(envKeysSet).sort();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{detail.name}</h1>
            <span className="text-sm text-muted">{stageCount} stages</span>
          </div>
          <p className="text-xs text-muted">
            base version:{" "}
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-secondary">
              {detail.latestVersion}
            </code>
            <CopyButton value={detail.latestVersion} label="copy hash" />
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`${API_BASE}/api/kernel/pipelines/${detail.latestVersion}/export`}
            download
            className="rounded border border-strong bg-surface px-3 py-1.5 text-sm text-secondary hover:border-strong hover:bg-elevated"
            title="Download this pipeline as a portable JSON file"
          >
            Export
          </a>
          <button
            type="button"
            onClick={() => setLauncherOpen(true)}
            className="rounded border border-info-border bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover focus:outline-none focus:ring-1 focus-visible:ring-accent"
          >
            Launch →
          </button>
        </div>
      </header>

      {externalInputs.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-semibold">External inputs</h2>
            <p className="text-xs text-muted">
              Supplied to <code className="font-mono text-secondary">run_pipeline</code> via{" "}
              <code className="font-mono text-secondary">seedValues</code>.
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-default">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface text-xs uppercase tracking-wide text-secondary">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Name</th>
                  <th className="px-3 py-2 text-left font-semibold">Type</th>
                  <th className="px-3 py-2 text-left font-semibold">Description</th>
                </tr>
              </thead>
              <tbody>
                {externalInputs.map((p) => (
                  <tr key={p.name} className="border-t border-default">
                    <td className="px-3 py-2 font-mono text-primary">{p.name}</td>
                    <td className="px-3 py-2 font-mono text-xs text-secondary">{p.type}</td>
                    <td className="px-3 py-2 text-secondary">
                      {p.description || <span className="italic text-muted">no description</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {detail.ir && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Pipeline structure</h2>
          <div className="rounded-lg border border-default overflow-hidden">
            <PipelineGraph ir={detail.ir} height={560} />
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Prompts</h2>
        <p className="text-xs text-muted">
          Edit agent stage prompts. Submit creates a proposal; approve/reject on the proposals page.
        </p>
        <PromptsEditor
          originalPrompts={detail.prompts}
          actor={actor}
          onActorChange={setActor}
          onSubmit={handleSubmit}
        />
      </section>

      {launcherOpen && (
        <LaunchPipelineDialog
          open={true}
          pipeline={{
            name: detail.name,
            latestVersion: detail.latestVersion,
            externalInputs: externalInputs.map((p) => ({ name: p.name, type: p.type })),
            envKeys,
          }}
          onClose={() => setLauncherOpen(false)}
        />
      )}
    </div>
  );
}
