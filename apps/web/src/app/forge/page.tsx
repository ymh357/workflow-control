"use client";

// /forge — the user-triggered "Forge Now" entry point.
//
// One Claude Code session usually contains MULTIPLE pipeline-able
// episodes (the user did 3-7 distinct things in one session). We
// render one recommendation card per episode.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { API_BASE } from "../../lib/api-client";

interface SessionEpisodeDTO {
  episodeId: string;
  intent: string;
  outcome: string;
  pipelineAble: boolean;
  rationale: string;
  steps: Array<{ stageKind: string; description: string }>;
}

type AnalyzeResponse =
  | AnalyzeOk | AnalyzeNoPattern | AnalyzeError;

interface AnalyzeBase {
  sessionId: string;
  jsonlPath: string;
  // Raw Claude Code project-dir encoding (e.g. "-Users-minghao-foo").
  // Not decoded server-side because the encoding is lossy for dirs
  // that contain literal hyphens. Render as-is.
  cwd: string;
  projectDirEncoded: true;
  episodeCount: number;
  truncated: boolean;
  embeddingModel: string;
}

type PerEpisodeRec = UseExistingRec | CreateNewRec;

interface UseExistingRec {
  kind: "use-existing";
  episode: SessionEpisodeDTO;
  pipelineName: string;
  versionHash: string;
  cosine: number;
  why: string;
  runUrl: string;
  alternatives: Array<{ pipelineName: string; versionHash: string; cosine: number }>;
}

interface CreateNewRec {
  kind: "create-new";
  episode: SessionEpisodeDTO;
  proposal: {
    suggestedName: string;
    intent: string;
    pipelineGeneratorPrompt: string;
    suggestedExternalInputs: Array<{ name: string; type: string; description: string }>;
    nearestExisting: Array<{ pipelineName: string; cosine: number }>;
    whyNotExisting: string;
  };
}

interface AnalyzeOk extends AnalyzeBase {
  kind: "ok";
  recommendations: PerEpisodeRec[];
  skippedEpisodes: Array<{ episode: SessionEpisodeDTO; reason: string }>;
  summary: {
    useExistingCount: number;
    createNewCount: number;
    skippedCount: number;
  };
}

interface AnalyzeNoPattern extends AnalyzeBase {
  kind: "no-pattern";
  reason: string;
}

interface AnalyzeError {
  kind: "error";
  code: string;
  message: string;
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
          Analyze a Claude Code session for automation candidates. One session
          usually contains multiple distinct tasks — Forge surfaces every one
          that is pipeline-worthy and tells you per-task whether to{" "}
          <strong>run an existing pipeline</strong> or{" "}
          <strong>create a new one</strong>.
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
              Distillation runs as a Claude agent; this typically takes 10–60s.
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
          Session: <code className="font-mono">{result.sessionId}</code>
          {" · project (encoded): "}
          <code className="font-mono">{result.cwd}</code>
          · {result.episodeCount} episodes
          {result.truncated && " · truncated"}
        </p>
      </section>
    );
  }

  // kind: "ok" — multi-episode response
  const summaryText = [
    result.summary.useExistingCount > 0 && `${result.summary.useExistingCount} can run an existing pipeline`,
    result.summary.createNewCount > 0 && `${result.summary.createNewCount} would need a new pipeline`,
    result.summary.skippedCount > 0 && `${result.summary.skippedCount} not pipeline-able`,
  ].filter(Boolean).join(" · ");

  return (
    <div className="space-y-4">
      <section className="rounded border border-default bg-surface px-3 py-2 text-xs text-secondary">
        Session <code className="font-mono">{result.sessionId}</code> ·
        project (encoded) <code className="font-mono">{result.cwd}</code> ·
        embedding {result.embeddingModel}
        {result.truncated && <span className="ml-1 text-warning-fg">· truncated</span>}
        <br />
        Detected {result.episodeCount} episode{result.episodeCount !== 1 ? "s" : ""}
        {summaryText && `: ${summaryText}`}.
      </section>

      {result.recommendations.length === 0 && result.skippedEpisodes.length > 0 && (
        <section className="rounded-lg border border-default bg-surface p-4 text-sm text-secondary">
          All detected episodes were one-off / exploratory. No automation
          candidates this session.
        </section>
      )}

      {result.recommendations.map((rec, i) => (
        <RecommendationCard key={rec.episode.episodeId + i} rec={rec} router={router} />
      ))}

      {result.skippedEpisodes.length > 0 && (
        <details className="text-xs text-secondary rounded border border-default bg-surface p-3">
          <summary className="cursor-pointer">
            {result.skippedEpisodes.length} skipped episode{result.skippedEpisodes.length > 1 ? "s" : ""} (not pipeline-able)
          </summary>
          <ul className="mt-2 space-y-2">
            {result.skippedEpisodes.map((s) => (
              <li key={s.episode.episodeId} className="border-l-2 border-default pl-2">
                <p className="font-semibold">{s.episode.intent}</p>
                <p className="text-xs italic text-muted">{s.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function RecommendationCard({ rec, router }: { rec: PerEpisodeRec; router: RouterLike }) {
  if (rec.kind === "use-existing") {
    return (
      <section className="rounded-lg border border-success-border bg-success-bg p-5 space-y-3">
        <header className="space-y-0.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-success-fg">
            Use existing pipeline
          </p>
          <h2 className="text-lg font-semibold">{rec.pipelineName}</h2>
          <p className="text-xs text-muted">
            episode: {rec.episode.intent} · cosine {rec.cosine.toFixed(3)}
          </p>
        </header>
        <p className="text-sm">{rec.why}</p>
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => router.push(rec.runUrl)}
            className="rounded border border-info-border bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            Open {rec.pipelineName} →
          </button>
        </div>
        {rec.alternatives.length > 0 && (
          <details className="text-xs text-secondary">
            <summary className="cursor-pointer">
              {rec.alternatives.length} alternative{rec.alternatives.length > 1 ? "s" : ""}
            </summary>
            <ul className="mt-2 space-y-1">
              {rec.alternatives.map((a) => (
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
        <EpisodeStepList episode={rec.episode} />
      </section>
    );
  }

  // create-new
  const p = rec.proposal;
  return (
    <section className="rounded-lg border border-info-border bg-info-bg p-5 space-y-3">
      <header className="space-y-0.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-info-fg">
          Create a new pipeline
        </p>
        <h2 className="text-lg font-semibold">{p.suggestedName}</h2>
        <p className="text-sm">{p.intent}</p>
      </header>
      <p className="text-xs text-secondary">{p.whyNotExisting}</p>

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
        <pre className="rounded border border-default bg-surface p-3 font-mono text-xs whitespace-pre-wrap max-h-64 overflow-auto">
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

      <EpisodeStepList episode={rec.episode} />
    </section>
  );
}

function EpisodeStepList({ episode }: { episode: SessionEpisodeDTO }) {
  if (episode.steps.length === 0) return null;
  return (
    <details className="text-xs text-secondary">
      <summary className="cursor-pointer">
        {episode.steps.length} step{episode.steps.length > 1 ? "s" : ""} · outcome {episode.outcome}
      </summary>
      <ol className="mt-2 space-y-0.5 list-decimal list-inside">
        {episode.steps.map((s, i) => (
          <li key={i}>
            <span className="font-mono text-muted">[{s.stageKind}]</span> {s.description}
          </li>
        ))}
      </ol>
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
