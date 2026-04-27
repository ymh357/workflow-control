"use client";

// B5 Confirm UI — renders a single pending gate with its upstream
// decision context and answer buttons. The parent page owns gate
// lifecycle (polling /status, fetching /context, dispatching
// /answer); this component is a pure render + click-forward.

import { useState } from "react";
import { RecommendedMcpsCard, type RecommendedMcpEntry } from "./recommended-mcps-card";

export interface GateAnswerOption {
  value: string;
  description?: string;
}

export interface GateContextResponse {
  gateId: string;
  taskId: string;
  stageName: string;
  // P3.7 question.options promoted to { value, description? }.
  question: { text: string; options?: GateAnswerOption[] };
  createdAt: number;
  answeredAt: number | null;
  answer: string | null;
  // P3.7 answerOptions promoted from plain string[] to object form —
  // each entry pairs a routing key with an optional description from
  // the author's GateStage.config.question.options.
  answerOptions: GateAnswerOption[];
  upstreams: Array<{
    stage: string;
    outputs: Array<{
      port: string;
      value: unknown;
      writtenAt: number;
    }>;
  }>;
}

interface Props {
  context: GateContextResponse;
  // Returns { ok: true } on HTTP success, { ok: false, error } otherwise.
  // Now accepts an optional comment — persisted via the gate's builtin
  // __gate_feedback__ output port (A). Empty string is sent when the
  // caller leaves the textarea blank so downstream consumers see a
  // determinate value either way.
  onAnswer: (answer: string, comment: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

// Truncate long string / JSON values to keep the card scrollable.
// 2 kB is roughly two screens in a monospace font at typical DPI —
// plenty for decision-making without breaking layout on
// pipeline-generator's fat `subPipelineContracts`.
const PREVIEW_LIMIT = 2048;

function renderValue(value: unknown): { text: string; truncated: boolean } {
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
  if (text.length <= PREVIEW_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, PREVIEW_LIMIT) + " …", truncated: true };
}

function PortRow({ port, value, writtenAt }: { port: string; value: unknown; writtenAt: number }) {
  const [expanded, setExpanded] = useState(false);
  const rendered = expanded
    ? { text: typeof value === "string" ? value : JSON.stringify(value, null, 2), truncated: false }
    : renderValue(value);
  return (
    <tr className="border-t border-zinc-800">
      <td className="px-3 py-1.5 align-top font-mono text-sm text-zinc-200">{port}</td>
      <td className="px-3 py-1.5 align-top">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-300">{rendered.text}</pre>
        {rendered.truncated && !expanded && (
          <button
            type="button"
            className="mt-1 text-xs text-sky-400 hover:text-sky-300 hover:underline"
            onClick={() => setExpanded(true)}
          >
            show full
          </button>
        )}
      </td>
      <td className="px-3 py-1.5 align-top text-xs text-zinc-500 whitespace-nowrap">
        {new Date(writtenAt).toLocaleTimeString()}
      </td>
    </tr>
  );
}

export function GateCard({ context, onAnswer }: Props) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // A: optional free-text feedback persisted to the gate's builtin
  // __gate_feedback__ port. Most useful on reject — the upstream
  // regenerating agent reads it via a wire to decide what to change.
  const [comment, setComment] = useState<string>("");

  const recommendedMcps: RecommendedMcpEntry[] = (() => {
    for (const u of context.upstreams) {
      for (const out of u.outputs) {
        if (out.port === "recommendedMcps" && Array.isArray(out.value)) {
          // Defensive filter: a malformed pipeline could write a non-conforming
          // array; reject any element missing the keys we depend on rather than
          // letting it crash useEffect / render.
          return (out.value as unknown[]).filter(
            (e): e is RecommendedMcpEntry =>
              e !== null
              && typeof e === "object"
              && typeof (e as RecommendedMcpEntry).entryId === "string"
              && Array.isArray((e as RecommendedMcpEntry).envKeys),
          );
        }
      }
    }
    return [];
  })();

  const click = async (answer: string) => {
    setSubmitting(answer);
    setErrorMsg(null);
    try {
      const r = await onAnswer(answer, comment);
      if (!r.ok) setErrorMsg(r.error);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <section className="mb-6 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
      <div className="mb-3 flex items-baseline gap-3">
        <span className="rounded border border-amber-500/50 bg-amber-500/20 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-300">
          Gate pending
        </span>
        <code className="font-mono text-sm text-zinc-200">{context.stageName}</code>
      </div>
      <p className="mb-4 text-sm text-zinc-100">{context.question.text}</p>

      {context.upstreams.length === 0 ? (
        <p className="mb-3 text-xs italic text-zinc-500">
          (no stage upstream; gate is fed by external inputs only)
        </p>
      ) : (
        context.upstreams.map((up) => (
          <details key={up.stage} className="mb-3 rounded border border-zinc-800 bg-zinc-950/50" open>
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-900/50">
              {up.stage} <span className="text-xs font-normal text-zinc-500">({up.outputs.length} outputs)</span>
            </summary>
            <table className="w-full border-collapse text-sm">
              <thead className="bg-zinc-900/70 text-xs uppercase tracking-wide text-zinc-400">
                <tr>
                  <th className="px-3 py-1.5 text-left font-semibold">Port</th>
                  <th className="px-3 py-1.5 text-left font-semibold">Value</th>
                  <th className="px-3 py-1.5 text-left font-semibold">Written</th>
                </tr>
              </thead>
              <tbody>
                {up.outputs.map((o) => (
                  <PortRow
                    key={o.port}
                    port={o.port}
                    value={o.value}
                    writtenAt={o.writtenAt}
                  />
                ))}
              </tbody>
            </table>
          </details>
        ))
      )}

      <RecommendedMcpsCard recommendedMcps={recommendedMcps} />

      <div className="mt-4">
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Feedback (optional)
          <span className="ml-2 font-normal normal-case text-zinc-500">
            persisted to <code className="font-mono text-zinc-400">__gate_feedback__</code> port
          </span>
        </label>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          placeholder="Rejecting? Explain what to change. The upstream agent reads this on rerun."
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          maxLength={16_384}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {context.answerOptions.map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={submitting !== null}
            onClick={() => void click(opt.value)}
            title={opt.description}
            className="rounded border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-sm font-semibold text-amber-200 hover:border-amber-500/70 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting === opt.value ? `${opt.value} …` : opt.value}
            {opt.description && (
              <span className="ml-1.5 text-[11px] font-normal italic text-amber-300/80">
                — {opt.description.length > 40 ? `${opt.description.slice(0, 40)}…` : opt.description}
              </span>
            )}
          </button>
        ))}
      </div>

      {errorMsg && (
        <p className="mt-3 rounded border border-red-500/50 bg-red-500/10 px-3 py-1.5 text-sm text-red-300">
          answer failed: {errorMsg}
        </p>
      )}
    </section>
  );
}
