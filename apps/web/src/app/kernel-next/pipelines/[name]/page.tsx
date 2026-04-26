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
import type { PipelineIRLike } from "../../../../lib/ir-to-flow";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
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

  if (!pipelineName) return <p className="text-sm text-zinc-400">Missing pipeline name.</p>;
  if (error) {
    return (
      <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        Error: {error}
      </div>
    );
  }
  if (!detail) return <p className="text-sm text-zinc-500">Loading…</p>;

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
            <span className="text-sm text-zinc-500">{stageCount} stages</span>
          </div>
          <p className="text-xs text-zinc-500">
            base version:{" "}
            <code className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-zinc-300">
              {detail.latestVersion}
            </code>
            <CopyButton value={detail.latestVersion} label="copy hash" />
          </p>
        </div>
        <button
          type="button"
          onClick={() => setLauncherOpen(true)}
          className="rounded border border-blue-600 bg-blue-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-400"
        >
          Launch →
        </button>
      </header>

      {externalInputs.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-semibold">External inputs</h2>
            <p className="text-xs text-zinc-500">
              Supplied to <code className="font-mono text-zinc-400">run_pipeline</code> via{" "}
              <code className="font-mono text-zinc-400">seedValues</code>.
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-zinc-900/70 text-xs uppercase tracking-wide text-zinc-400">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Name</th>
                  <th className="px-3 py-2 text-left font-semibold">Type</th>
                  <th className="px-3 py-2 text-left font-semibold">Description</th>
                </tr>
              </thead>
              <tbody>
                {externalInputs.map((p) => (
                  <tr key={p.name} className="border-t border-zinc-800">
                    <td className="px-3 py-2 font-mono text-zinc-100">{p.name}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-400">{p.type}</td>
                    <td className="px-3 py-2 text-zinc-300">
                      {p.description || <span className="italic text-zinc-600">no description</span>}
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
          <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <PipelineGraph ir={detail.ir} height={560} />
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Prompts</h2>
        <p className="text-xs text-zinc-500">
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
