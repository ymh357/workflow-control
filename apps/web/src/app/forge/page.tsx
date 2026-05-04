"use client";

// /forge — the user-triggered "Forge Now" entry point. One big button.
// Click it → POST /api/forge/analyze → render the recommendation.
//
// The user is in flow when they hit this button — they want a fast,
// clear answer ("use existing" / "create new" / "no pattern") with
// the next click already obvious.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { API_BASE } from "../../lib/api-client";

type AnalyzeResponse =
  | UseExisting | CreateNew | NoPattern | ErrorResp;

interface AnalyzeBase {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  episodeCount: number;
  episodes: Array<{
    episodeId: string;
    intent: string;
    outcome: string;
    pipelineAble: boolean;
    rationale: string;
    steps: Array<{ stageKind: string; description: string }>;
  }>;
  truncated: boolean;
  embeddingModel: string;
}

interface UseExisting extends AnalyzeBase {
  kind: "use-existing";
  recommendation: {
    pipelineName: string;
    versionHash: string;
    cosine: number;
    why: string;
    runUrl: string;
  };
  alternatives: Array<{ pipelineName: string; versionHash: string; cosine: number }>;
}

interface CreateNew extends AnalyzeBase {
  kind: "create-new";
  proposal: {
    suggestedName: string;
    intent: string;
    description: string;
    pipelineGeneratorPrompt: string;
    suggestedExternalInputs: Array<{ name: string; type: string; description: string }>;
    nearestExisting: Array<{ pipelineName: string; cosine: number }>;
    whyNotExisting: string;
  };
}

interface NoPattern extends AnalyzeBase {
  kind: "no-pattern";
  reason: string;
}

interface ErrorResp {
  kind: "error";
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export default function ForgePage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [sessionInput, setSessionInput] = useState<string>("");
  const router = useRouter();

  const handleAnalyze = useCallback(async () => {
    setBusy(true);
    setResult(null);
    const body: { sessionId?: string; jsonlPath?: string } = {};
    const trimmed = sessionInput.trim();
    if (trimmed) {
      if (trimmed.startsWith("/") || trimmed.endsWith(".jsonl")) body.jsonlPath = trimmed;
      else body.sessionId = trimmed;
    }
    try {
      const res = await fetch(`${API_BASE}/api/forge/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as AnalyzeResponse;
      setResult(data);
    } catch (err) {
      setResult({
        kind: "error",
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [sessionInput]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Forge</h1>
        <p className="text-sm text-secondary">
          Analyze a Claude Code session and find out whether it can be
          automated as a workflow pipeline. We&apos;ll either point you at
          an existing pipeline that already does the work, or hand you
          a prompt you can paste into <code className="rounded bg-elevated px-1 font-mono">pipeline-generator</code> to build a new one.
        </p>
      </header>

      <section className="rounded-lg border border-default bg-surface p-5 space-y-3">
        <label className="block text-xs font-semibold uppercase tracking-wide text-secondary">
          Session (optional)
        </label>
        <input
          type="text"
          value={sessionInput}
          onChange={(e) => setSessionInput(e.target.value)}
          placeholder="Session ID or full /path/to/session.jsonl — leave blank to auto-detect most recent"
          className="block w-full rounded border border-strong bg-surface px-2 py-1 text-sm text-primary placeholder:text-muted focus:border-strong focus:outline-none"
          disabled={busy}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleAnalyze()}
            disabled={busy}
            className="rounded border border-info-border bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Analyzing…" : "Forge Now"}
          </button>
          {busy && (
            <span className="text-xs text-muted">
              This may take 10-60s. Distillation is running.
            </span>
          )}
        </div>
      </section>

      {result && <ResultView result={result} router={router} />}
    </div>
  );
}

interface RouterLike { push: (href: string) => void }
function ResultView({ result, router }: { result: AnalyzeResponse; router: RouterLike }) {
  if (result.kind === "error") {
    return (
      <section className="rounded-lg border border-danger-border bg-danger-bg p-4 text-sm text-danger-fg space-y-1">
        <p className="font-semibold">Analysis failed</p>
        <p><code className="font-mono">{result.code}</code> — {result.message}</p>
      </section>
    );
  }

  if (result.kind === "no-pattern") {
    return (
      <section className="rounded-lg border border-default bg-surface p-5 space-y-2">
        <p className="text-sm font-semibold">No automatable pattern detected</p>
        <p className="text-sm text-secondary">{result.reason}</p>
        <p className="text-xs text-muted">
          Session: <code className="font-mono">{result.sessionId}</code> ({result.cwd})
          · {result.episodeCount} episodes
          {result.truncated && " · truncated"}
        </p>
      </section>
    );
  }

  if (result.kind === "use-existing") {
    const r = result.recommendation;
    return (
      <section className="rounded-lg border border-success-border bg-success-bg p-5 space-y-4">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-success-fg">
            Use existing pipeline
          </p>
          <h2 className="text-xl font-semibold">{r.pipelineName}</h2>
          <p className="text-xs text-muted">
            cosine {r.cosine.toFixed(3)} · session {result.sessionId}
          </p>
        </div>
        <p className="text-sm">{r.why}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => router.push(r.runUrl)}
            className="rounded border border-info-border bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            Open {r.pipelineName} →
          </button>
        </div>
        {result.alternatives.length > 0 && (
          <details className="text-xs text-secondary">
            <summary className="cursor-pointer">
              {result.alternatives.length} alternative{result.alternatives.length > 1 ? "s" : ""}
            </summary>
            <ul className="mt-2 space-y-1">
              {result.alternatives.map((a) => (
                <li key={a.versionHash}>
                  <a
                    href={`/kernel-next/pipelines/${encodeURIComponent(a.pipelineName)}`}
                    className="text-accent hover:underline"
                  >
                    {a.pipelineName}
                  </a>
                  {" "}
                  <span className="font-mono">{a.cosine.toFixed(3)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <EpisodeList episodes={result.episodes} />
      </section>
    );
  }

  // create-new
  const p = result.proposal;
  return (
    <section className="rounded-lg border border-info-border bg-info-bg p-5 space-y-4">
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-info-fg">
          Create a new pipeline
        </p>
        <h2 className="text-xl font-semibold">{p.suggestedName}</h2>
        <p className="text-sm">{p.intent}</p>
      </div>
      <p className="text-sm text-secondary">{p.whyNotExisting}</p>

      {p.suggestedExternalInputs.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-secondary">Inputs</p>
          <ul className="mt-1 text-sm space-y-0.5">
            {p.suggestedExternalInputs.map((i) => (
              <li key={i.name}>
                <code className="font-mono">{i.name}</code>{" "}
                <span className="text-muted">({i.type})</span> — {i.description}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-secondary">
            Prompt for pipeline-generator
          </p>
          <CopyButton text={p.pipelineGeneratorPrompt} />
        </div>
        <pre className="rounded border border-default bg-surface p-3 font-mono text-xs whitespace-pre-wrap">
{p.pipelineGeneratorPrompt}
        </pre>
      </div>

      <div className="flex gap-2 flex-wrap">
        <a
          href="/kernel-next/pipelines/pipeline-generator"
          className="rounded border border-info-border bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover"
        >
          Open pipeline-generator →
        </a>
      </div>

      <EpisodeList episodes={result.episodes} />
    </section>
  );
}

function EpisodeList({ episodes }: { episodes: AnalyzeBase["episodes"] }) {
  if (episodes.length === 0) return null;
  return (
    <details className="text-xs text-secondary">
      <summary className="cursor-pointer">
        {episodes.length} episode{episodes.length > 1 ? "s" : ""} detected
      </summary>
      <div className="mt-2 space-y-2">
        {episodes.map((ep) => (
          <div key={ep.episodeId} className="rounded border border-default bg-surface p-2">
            <p className="font-semibold">{ep.intent}</p>
            <p className="text-xs text-muted">
              {ep.outcome} · {ep.pipelineAble ? "pipeline-able" : "one-off"} · {ep.steps.length} steps
            </p>
            <p className="text-xs italic">{ep.rationale}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* ignore */ }
      }}
      className="text-xs rounded border border-strong bg-surface px-2 py-0.5 hover:bg-elevated"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
