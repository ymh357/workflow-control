"use client";

// Per-attempt detail page (P7.3 / D25).
//
// Fetches GET /api/kernel/attempts/:attemptId/details and renders the
// rich execution record in a tabbed view:
//   - Tool Calls (tool_calls_json)
//   - Messages (agent_stream_json events with type="text")
//   - Thinking (agent_stream_json events with type="thinking")
//   - Status Timeline (derived from stage_attempts, plus compactEvents
//     for context-compaction markers)
//   - Usage (cost + tokens + session id)
//
// The task description asked for a "thinking_blocks_json" / "messages_json"
// split, but the kernel-next schema stores both as agentStream event
// types. This page partitions them client-side so the tab UX still
// matches the task intent.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type Tab = "tool-calls" | "messages" | "thinking" | "status" | "usage";

// Mirrors AttemptDetailsPayload from the server route. Duplicated
// locally so the web app doesn't reach across workspaces for types.
interface DetailsPayload {
  toolCalls: unknown[];
  agentStream: Array<{ type?: string } & Record<string, unknown>>;
  compactEvents: unknown[];
  subAgents: unknown[];
  statusHistory: Array<{
    status: string;
    startedAt: number;
    endedAt: number | null;
  }>;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  sessionId: string | null;
  model: string | null;
  durationMs: number | null;
  startedAt: number | null;
  endedAt: number | null;
  terminationReason: string | null;
}

export default function AttemptDetailsPage(): React.JSX.Element {
  const params = useParams();
  const raw = params?.attemptId;
  const attemptId = Array.isArray(raw) ? raw[0] : raw;

  const [details, setDetails] = useState<DetailsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tool-calls");

  useEffect(() => {
    if (!attemptId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const r = await fetch(
          `${API_BASE}/api/kernel/attempts/${encodeURIComponent(attemptId)}/details`,
          { signal: controller.signal },
        );
        if (!r.ok) {
          setError(`HTTP ${r.status}`);
          return;
        }
        const body = (await r.json()) as {
          ok: boolean;
          details?: DetailsPayload;
          diagnostics?: Array<{ code: string; message: string }>;
        };
        if (!body.ok || !body.details) {
          setError(body.diagnostics?.[0]?.message ?? "attempt not found");
          return;
        }
        setDetails(body.details);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => controller.abort();
  }, [attemptId]);

  // Partition the agent stream into "messages" (assistant text) and
  // "thinking" (reasoning blocks) so the tabs line up with the task's
  // intended UX. The discriminator is the event.type field emitted by
  // the kernel-next executor.
  const messages = useMemo(
    () => (details?.agentStream ?? []).filter((e) => e.type !== "thinking"),
    [details],
  );
  const thinking = useMemo(
    () => (details?.agentStream ?? []).filter((e) => e.type === "thinking"),
    [details],
  );

  if (!attemptId) {
    return <p className="p-6 font-mono">Missing attempt id.</p>;
  }
  if (error) {
    return <p className="p-6 font-mono text-red-600">Error: {error}</p>;
  }
  if (!details) {
    return <p className="p-6 font-mono text-gray-600">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-5xl p-6 font-mono text-sm">
      <h1 className="mb-2 text-xl font-bold">
        Attempt <code>{attemptId.slice(0, 8)}</code>
      </h1>
      {details.sessionId && (
        <p className="mb-1 text-xs text-gray-600">
          Session: <code>{details.sessionId}</code>
        </p>
      )}
      {details.model && (
        <p className="mb-4 text-xs text-gray-600">
          Model: <code>{details.model}</code>
        </p>
      )}

      {/* Usage summary */}
      <div className="mb-4 flex flex-wrap gap-4 text-xs">
        <span>
          Cost: <strong>${(details.costUsd ?? 0).toFixed(4)}</strong>
        </span>
        <span>
          Input tokens:{" "}
          <strong>{(details.inputTokens ?? 0).toLocaleString()}</strong>
        </span>
        <span>
          Output tokens:{" "}
          <strong>{(details.outputTokens ?? 0).toLocaleString()}</strong>
        </span>
        {details.durationMs !== null && (
          <span>
            Duration: <strong>{details.durationMs}ms</strong>
          </span>
        )}
      </div>

      {/* Tab bar */}
      <div role="tablist" className="mb-3 flex flex-wrap gap-1 border-b border-gray-300">
        {(
          [
            ["tool-calls", `Tool Calls (${details.toolCalls.length})`],
            ["messages", `Messages (${messages.length})`],
            ["thinking", `Thinking (${thinking.length})`],
            ["status", `Status Timeline (${details.statusHistory.length})`],
            ["usage", "Usage"],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-t border-b-2 px-3 py-1 text-xs ${
              tab === key
                ? "border-blue-500 bg-white font-semibold"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Panels */}
      {tab === "tool-calls" && (
        <JsonPanel items={details.toolCalls} emptyLabel="No tool calls" />
      )}
      {tab === "messages" && (
        <JsonPanel items={messages} emptyLabel="No messages" />
      )}
      {tab === "thinking" && (
        <JsonPanel items={thinking} emptyLabel="No thinking blocks" />
      )}
      {tab === "status" && (
        <StatusPanel
          history={details.statusHistory}
          compactEvents={details.compactEvents}
          terminationReason={details.terminationReason}
        />
      )}
      {tab === "usage" && (
        <pre className="overflow-auto rounded bg-gray-50 p-3 text-xs">
          {JSON.stringify(
            {
              cost_usd: details.costUsd,
              input_tokens: details.inputTokens,
              output_tokens: details.outputTokens,
              session_id: details.sessionId,
              model: details.model,
              duration_ms: details.durationMs,
              started_at: details.startedAt,
              ended_at: details.endedAt,
              termination_reason: details.terminationReason,
            },
            null,
            2,
          )}
        </pre>
      )}
    </div>
  );
}

// Extract a short label from a JSON item for the collapsed summary row.
// Probes common identifier fields so tool calls show as `#1 write_port`,
// stream events as `#1 text` / `#1 thinking`, status rows as `#1 running`.
// Falls back to nothing when none match — caller still shows `#N`.
function itemHint(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null;
  const r = item as Record<string, unknown>;
  const first = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  };
  // tool_calls → name; stream events → type; status/role fallbacks
  return first("name", "type", "role", "status", "kind");
}

// Generic JSON list panel: each item collapsed behind a <details>
// summary so long tool-call / message blobs don't blow up the viewport.
function JsonPanel({
  items,
  emptyLabel,
}: {
  items: unknown[];
  emptyLabel: string;
}): React.JSX.Element {
  if (items.length === 0) {
    return <p className="text-sm text-gray-500">{emptyLabel}</p>;
  }
  return (
    <ol className="space-y-2">
      {items.map((item, i) => {
        const hint = itemHint(item);
        return (
        <li
          key={i}
          className="rounded border border-gray-200 bg-white p-2"
        >
          <details>
            <summary className="cursor-pointer text-xs text-gray-700">
              #{i + 1}{hint ? <span className="ml-1 font-mono text-gray-500">{hint}</span> : null}
            </summary>
            <pre className="mt-2 overflow-auto text-xs">
              {JSON.stringify(item, null, 2)}
            </pre>
          </details>
        </li>
        );
      })}
    </ol>
  );
}

function StatusPanel({
  history,
  compactEvents,
  terminationReason,
}: {
  history: DetailsPayload["statusHistory"];
  compactEvents: unknown[];
  terminationReason: string | null;
}): React.JSX.Element {
  if (history.length === 0 && compactEvents.length === 0) {
    return <p className="text-sm text-gray-500">No status history</p>;
  }
  return (
    <div className="space-y-3">
      {history.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold text-gray-700">
            Stage attempt
          </h3>
          <ul className="space-y-1">
            {history.map((h, i) => (
              <li
                key={i}
                className="rounded border border-gray-200 bg-white px-2 py-1 text-xs"
              >
                <span
                  className={
                    h.status === "error"
                      ? "text-red-600"
                      : h.status === "success"
                        ? "text-green-600"
                        : h.status === "running"
                          ? "text-blue-600"
                          : "text-gray-600"
                  }
                >
                  {h.status}
                </span>{" "}
                <span className="text-gray-600">
                  {new Date(h.startedAt).toLocaleString()}
                </span>
                {h.endedAt !== null && (
                  <span className="text-gray-600">
                    {" "}
                    → {new Date(h.endedAt).toLocaleString()}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {terminationReason && (
            <p className="mt-1 text-xs text-gray-600">
              Termination reason: <code>{terminationReason}</code>
            </p>
          )}
        </div>
      )}
      {compactEvents.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold text-gray-700">
            Context compactions ({compactEvents.length})
          </h3>
          <JsonPanel
            items={compactEvents}
            emptyLabel="No compactions"
          />
        </div>
      )}
    </div>
  );
}
