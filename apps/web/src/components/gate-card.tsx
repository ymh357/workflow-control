"use client";

// B5 Confirm UI — renders a single pending gate with its upstream
// decision context and answer buttons. The parent page owns gate
// lifecycle (polling /status, fetching /context, dispatching
// /answer); this component is a pure render + click-forward.

import { useState } from "react";

export interface GateContextResponse {
  gateId: string;
  taskId: string;
  stageName: string;
  question: { text: string; options?: string[] };
  createdAt: number;
  answeredAt: number | null;
  answer: string | null;
  answerOptions: string[];
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
  onAnswer: (answer: string) => Promise<{ ok: true } | { ok: false; error: string }>;
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
    <tr>
      <td className="border border-gray-300 px-2 py-1 align-top font-semibold">{port}</td>
      <td className="border border-gray-300 px-2 py-1 align-top">
        <pre className="whitespace-pre-wrap break-all text-xs">{rendered.text}</pre>
        {rendered.truncated && !expanded && (
          <button
            type="button"
            className="mt-1 text-xs text-blue-600 underline"
            onClick={() => setExpanded(true)}
          >
            show full
          </button>
        )}
      </td>
      <td className="border border-gray-300 px-2 py-1 align-top text-xs text-gray-500">
        {new Date(writtenAt).toLocaleTimeString()}
      </td>
    </tr>
  );
}

export function GateCard({ context, onAnswer }: Props) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const click = async (answer: string) => {
    setSubmitting(answer);
    setErrorMsg(null);
    try {
      const r = await onAnswer(answer);
      if (!r.ok) setErrorMsg(r.error);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <section className="mb-6 rounded border border-amber-400 bg-amber-50 p-4">
      <h2 className="mb-1 text-base font-bold text-amber-900">
        Gate pending: <span className="font-mono">{context.stageName}</span>
      </h2>
      <p className="mb-3 text-sm">{context.question.text}</p>

      {context.upstreams.length === 0 ? (
        <p className="mb-3 text-xs italic text-gray-600">
          (no stage upstream; gate is fed by external inputs only)
        </p>
      ) : (
        context.upstreams.map((up) => (
          <details key={up.stage} className="mb-2" open>
            <summary className="cursor-pointer font-semibold">
              {up.stage} ({up.outputs.length} outputs)
            </summary>
            <table className="mt-2 w-full border-collapse border border-gray-300 text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="border border-gray-300 px-2 py-1 text-left">Port</th>
                  <th className="border border-gray-300 px-2 py-1 text-left">Value</th>
                  <th className="border border-gray-300 px-2 py-1 text-left">Written</th>
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

      <div className="mt-3 flex flex-wrap gap-2">
        {context.answerOptions.map((opt) => (
          <button
            key={opt}
            type="button"
            disabled={submitting !== null}
            onClick={() => void click(opt)}
            className="rounded bg-amber-700 px-3 py-1 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
          >
            {submitting === opt ? `${opt} …` : opt}
          </button>
        ))}
      </div>

      {errorMsg && (
        <p className="mt-2 text-sm text-red-700">answer failed: {errorMsg}</p>
      )}
    </section>
  );
}
