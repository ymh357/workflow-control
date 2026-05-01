"use client";

// /kernel-next/proposals — three-section list (pending/approved/
// rejected). Pending rows have Approve / Reject buttons that POST to
// the existing endpoints and locally move the row out of pending on
// success. No migrate-on-approve from UI (see design spec §8); use
// MCP or curl for that.

import React, { useCallback, useEffect, useState } from "react";
import { ProposalDiff } from "../../../components/proposal-diff";
import { MigrateProposalDialog } from "../../../components/migrate-proposal-dialog";
import type { PipelineIRLike } from "../../../lib/ir-to-flow";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface PreviewPayload {
  baseIr: PipelineIRLike;
  projectedIr: PipelineIRLike;
}

type Status = "pending" | "approved" | "rejected";

interface ProposalRow {
  proposalId: string;
  pipelineName: string;
  baseVersion: string;
  proposedVersion: string | null;
  actor: string;
  status: Status;
  createdAt: number;
  diagnosticJson: string | null;
  rerunFrom: string | null;
  migrateRunning: "all" | "none" | string[];
}

export default function ProposalsPage() {
  const [rows, setRows] = useState<ProposalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-proposal preview cache. undefined = not fetched; null = fetch
  // failed; otherwise the {baseIr, projectedIr} payload. Mirrors the
  // attemptDiffs pattern from task detail (P6.4).
  const [previews, setPreviews] = useState<Record<string, PreviewPayload | null>>({});
  const [previewLoading, setPreviewLoading] = useState<Record<string, boolean>>({});
  // 2026-04-27 B-secondary: real Migrate dialog replaces window.prompt.
  const [migrateTarget, setMigrateTarget] = useState<ProposalRow | null>(null);

  const refetch = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const res = await fetch(`${API_BASE}/api/kernel/proposals`, { signal });
      const body = await res.json() as { ok: boolean; proposals: ProposalRow[] };
      setRows(body.ok ? body.proposals : []);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refetch(controller.signal);
    return () => controller.abort();
  }, [refetch]);

  // B5 wf.hotUpdatePending: subscribe to the global proposals SSE
  // stream so newly-created / state-changed proposals refresh the
  // list without the user having to reload. EventSource handles
  // auto-reconnect; we just re-fetch on any event.
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(`${API_BASE}/api/kernel/proposals/stream`);
    const onEvent = () => { void refetch(); };
    es.addEventListener("proposal_created", onEvent);
    es.addEventListener("proposal_approved", onEvent);
    es.addEventListener("proposal_rejected", onEvent);
    return () => {
      es.removeEventListener("proposal_created", onEvent);
      es.removeEventListener("proposal_approved", onEvent);
      es.removeEventListener("proposal_rejected", onEvent);
      es.close();
    };
  }, [refetch]);

  const togglePreview = useCallback(async (id: string) => {
    // Toggle-off if already loaded/loaded-null.
    if (id in previews) {
      setPreviews((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setError(null);
    setPreviewLoading((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(
        `${API_BASE}/api/kernel/proposals/${encodeURIComponent(id)}/preview`,
        { method: "POST" },
      );
      const body = await res.json() as
        | { ok: true; baseIr: PipelineIRLike; projectedIr: PipelineIRLike }
        | { ok: false; diagnostics?: Array<{ message: string }> };
      if (res.ok && body.ok) {
        setPreviews((prev) => ({ ...prev, [id]: { baseIr: body.baseIr, projectedIr: body.projectedIr } }));
      } else {
        const message = !body.ok
          ? body.diagnostics?.[0]?.message ?? `HTTP ${res.status}`
          : `HTTP ${res.status}`;
        setError(message);
        setPreviews((prev) => ({ ...prev, [id]: null }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPreviews((prev) => ({ ...prev, [id]: null }));
    } finally {
      setPreviewLoading((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, [previews]);

  const mutateStatus = useCallback(async (id: string, endpoint: "approve" | "reject") => {
    setError(null);
    try {
      // B7.F26 (2026-04-30 review): pre-fix the approve path sent
      // body="" with content-type=application/json — an empty
      // string is not valid JSON. The route handler ignored the
      // body anyway (POST /approve takes no payload), but the
      // mismatch was misleading and any stricter middleware would
      // reject it. Now: approve has no body and no content-type;
      // reject still sends a JSON object (empty for the no-reason
      // case, populated otherwise) with the matching content-type.
      const init: RequestInit = endpoint === "reject"
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          }
        : { method: "POST" };
      const res = await fetch(
        `${API_BASE}/api/kernel/proposals/${encodeURIComponent(id)}/${endpoint}`,
        init,
      );
      const body = await res.json() as { ok: boolean; diagnostics?: Array<{ message: string }> };
      if (!res.ok || !body.ok) {
        setError(body.diagnostics?.[0]?.message ?? `HTTP ${res.status}`);
        return;
      }
      setRows((prev) => (prev ?? []).map((r) =>
        r.proposalId === id ? { ...r, status: endpoint === "approve" ? "approved" : "rejected" } : r,
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  if (error && !rows) {
    return (
      <div className="rounded border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
        Error: {error}
      </div>
    );
  }
  if (!rows) return <p className="text-sm text-muted">Loading…</p>;

  const pending = rows.filter((r) => r.status === "pending");
  const approved = rows.filter((r) => r.status === "approved");
  const rejected = rows.filter((r) => r.status === "rejected");

  const Section = ({ title, items, actions, afterRow }: {
    title: string;
    items: ProposalRow[];
    actions?: (r: ProposalRow) => React.ReactNode;
    afterRow?: (r: ProposalRow) => React.ReactNode;
  }) => {
    const columnCount = 4 + (actions ? 1 : 0);
    return (
    <section className="mb-6">
      <h2 className="mb-2 text-base font-semibold">{title} ({items.length})</h2>
      {items.length === 0 ? (
        <p className="text-xs text-muted">none</p>
      ) : (
        <table className="w-full border-collapse border border-default">
          <thead className="bg-surface text-secondary uppercase text-xs tracking-wide">
            <tr>
              <th className="border border-default px-2 py-1 text-left">Proposal</th>
              <th className="border border-default px-2 py-1 text-left">Pipeline</th>
              <th className="border border-default px-2 py-1 text-left">Actor</th>
              <th className="border border-default px-2 py-1 text-left">Created</th>
              {actions && <th className="border border-default px-2 py-1 text-left">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((r) => {
              const extra = afterRow?.(r);
              return (
                <React.Fragment key={r.proposalId}>
                  <tr>
                    <td className="border border-default px-2 py-1 text-xs">{r.proposalId}</td>
                    <td className="border border-default px-2 py-1">{r.pipelineName}</td>
                    <td className="border border-default px-2 py-1 text-xs">{r.actor}</td>
                    <td className="border border-default px-2 py-1 text-xs text-muted">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    {actions && <td className="border border-default px-2 py-1">{actions(r)}</td>}
                  </tr>
                  {extra && (
                    <tr>
                      <td colSpan={columnCount} className="border border-default bg-surface p-3">
                        {extra}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
    );
  };

  return (
    <div className="space-y-4">
      <header className="flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Proposals</h1>
        <span className="text-sm text-muted">
          {rows.length} total · {pending.length} pending · {approved.length} approved · {rejected.length} rejected
        </span>
      </header>
      {error && (
        <div className="rounded border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          {error}
        </div>
      )}
      <Section
        title="Pending"
        items={pending}
        actions={(r) => (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void togglePreview(r.proposalId)}
              disabled={previewLoading[r.proposalId] ?? false}
              className="rounded border border-strong bg-elevated px-2 py-1 text-xs font-semibold text-primary hover:border-strong hover:bg-elevated disabled:opacity-40"
            >
              {previewLoading[r.proposalId]
                ? "Loading…"
                : r.proposalId in previews ? "Hide preview" : "Preview"}
            </button>
            <button
              type="button"
              onClick={() => void mutateStatus(r.proposalId, "approve")}
              className="rounded border border-success-border bg-success-bg px-2 py-1 text-xs font-semibold text-success-fg hover:border-success-border hover:bg-elevated"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => void mutateStatus(r.proposalId, "reject")}
              className="rounded border border-danger-border bg-danger-bg px-2 py-1 text-xs font-semibold text-danger-fg hover:border-danger-border hover:bg-danger-bg"
            >
              Reject
            </button>
          </div>
        )}
        afterRow={(r) => {
          if (!(r.proposalId in previews)) return null;
          const p = previews[r.proposalId];
          if (p === null) {
            return <p className="text-xs text-danger-fg">Preview failed — see error at top of page.</p>;
          }
          return <ProposalDiff baseIr={p.baseIr} projectedIr={p.projectedIr} />;
        }}
      />
      <Section
        title="Approved"
        items={approved}
        actions={(r) => (
          <button
            type="button"
            onClick={() => setMigrateTarget(r)}
            disabled={r.migrateRunning === "none"}
            className="rounded border border-info-border bg-info-bg px-2 py-1 text-xs font-semibold text-info-fg hover:border-info-border hover:bg-elevated disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              r.migrateRunning === "none"
                ? "This proposal is for new tasks only (migrateRunningTasks=\"none\")"
                : "Apply this approved proposal to a running task"
            }
          >
            Migrate→
          </button>
        )}
      />
      <Section title="Rejected" items={rejected} />

      {migrateTarget && (
        <MigrateProposalDialog
          open={true}
          proposalId={migrateTarget.proposalId}
          pipelineName={migrateTarget.pipelineName}
          migrateRunning={migrateTarget.migrateRunning}
          onClose={() => setMigrateTarget(null)}
          onSuccess={() => void refetch()}
        />
      )}
    </div>
  );
}
