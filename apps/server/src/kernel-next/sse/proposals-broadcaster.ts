// Global broadcaster for proposal lifecycle events.
//
// Unlike KernelNextBroadcaster (per-task channels), proposals are a
// single global stream: any UI surface that cares about "there's a
// new pending proposal" subscribes to the one channel. This keeps
// the confirm-UI workflow (B5 roadmap §7.2: wf.hotUpdatePending) out
// of the per-task namespace and avoids forcing clients to know
// taskIds ahead of time.
//
// Shape parity with KernelNextBroadcaster:
//   - Ring-buffer history so late subscribers (browser reload)
//     immediately see recent proposals.
//   - Publish is synchronous and non-throwing; listener errors are
//     swallowed.
//   - subscribe returns an idempotent unsubscribe.

export type ProposalEventType =
  | "proposal_created"    // NEW proposal landed (any status)
  | "proposal_approved"   // pending → approved
  | "proposal_rejected";  // pending → rejected

export interface ProposalEvent {
  type: ProposalEventType;
  // ISO 8601 UTC assigned at publish time.
  timestamp: string;
  data: {
    proposalId: string;
    pipelineName: string;
    baseVersion: string;
    proposedVersion: string | null;
    actor: string;
    status: "pending" | "approved" | "rejected";
    createdAt: number;
  };
}

export type ProposalEventListener = (event: ProposalEvent) => void;

export interface ProposalsBroadcasterOptions {
  historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 50;

export class ProposalsBroadcaster {
  private readonly listeners = new Set<ProposalEventListener>();
  private readonly history: ProposalEvent[] = [];
  private readonly historyLimit: number;

  constructor(options: ProposalsBroadcasterOptions = {}) {
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  subscribe(listener: ProposalEventListener): () => void {
    for (const event of this.history) {
      this.safeDispatch(listener, event);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: ProposalEvent): void {
    this.history.push(event);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    for (const listener of this.listeners) {
      this.safeDispatch(listener, event);
    }
  }

  historySnapshot(): ProposalEvent[] {
    return [...this.history];
  }

  subscriberCount(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
    this.history.length = 0;
  }

  private safeDispatch(listener: ProposalEventListener, event: ProposalEvent): void {
    try {
      listener(event);
    } catch {
      // Swallow listener errors — a broken consumer must not stop
      // the propose() hot path.
    }
  }
}
