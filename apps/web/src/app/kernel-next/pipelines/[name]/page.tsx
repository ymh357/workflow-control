"use client";

// /kernel-next/pipelines/[name] — pick the pipeline's latest version,
// fetch its IR + prompts, render PromptsEditor; on submit, POST a
// prompts-only proposal to /api/kernel/proposals and redirect to
// /kernel-next/proposals.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PromptsEditor } from "../../../../components/prompts-editor";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const ACTOR_LS_KEY = "kernelActor";

interface PipelineDetail {
  name: string;
  latestVersion: string;
  prompts: Record<string, string>;
}

export default function PipelineEditorPage() {
  const params = useParams();
  const router = useRouter();
  const nameRaw = params?.name;
  const pipelineName = Array.isArray(nameRaw) ? nameRaw[0]! : (nameRaw as string | undefined);

  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [actor, setActor] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

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
        };
        if (!detailBody.ok) { setError("detail not ok"); return; }
        setDetail({ name: pipelineName, latestVersion: match.latestVersion, prompts: detailBody.prompts });
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

  if (!pipelineName) return <p className="p-6 font-mono">Missing pipeline name.</p>;
  if (error) return <p className="p-6 font-mono text-red-600">Error: {error}</p>;
  if (!detail) return <p className="p-6 font-mono text-gray-600">Loading…</p>;

  return (
    <div className="mx-auto max-w-4xl p-6 font-mono text-sm">
      <h1 className="mb-2 text-xl font-bold">{detail.name}</h1>
      <p className="mb-4 text-xs text-gray-600">
        base version: <code>{detail.latestVersion}</code>
      </p>
      <PromptsEditor
        originalPrompts={detail.prompts}
        actor={actor}
        onActorChange={setActor}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
