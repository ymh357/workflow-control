"use client";

// React hook that tracks the live pending-proposal count. Every
// surface that needs a "new proposal landed" badge calls this —
// currently the global Nav bar. Subscribes to
// /api/kernel/proposals/stream and refetches the list on any event,
// falling back to an initial fetch for the opening render.
//
// Local engine, single user: we don't debounce — real-world pending
// churn is low (< 10 events/hour).

import { useEffect, useState, useCallback } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function usePendingProposalsCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  const refetch = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/kernel/proposals?status=pending`, { signal });
      if (!res.ok) return;
      const body = await res.json() as { ok: boolean; proposals: Array<unknown> };
      if (body.ok) setCount(body.proposals.length);
    } catch {
      // network error; leave last count untouched
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refetch(controller.signal);
    return () => controller.abort();
  }, [refetch]);

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

  return count;
}
