import type { SSEMessage } from "../types/index.js";
import type { StatementSync } from "node:sqlite";
import { getDb } from "../lib/db.js";

interface SSEConnection {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  heartbeat?: ReturnType<typeof setInterval>;
}

const encoder = new TextEncoder();

export type SSEListener = (msg: SSEMessage) => void;

class SSEManager {
  private static readonly MAX_HISTORY = 500;
  private static readonly MAX_CONNECTIONS_PER_TASK = 10;

  // taskId -> list of active connections
  private connections = new Map<string, SSEConnection[]>();
  // taskId -> message history (for reconnection)
  private history = new Map<string, SSEMessage[]>();
  // taskId -> cleanup timer (deduplicated)
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // taskId -> programmatic listeners (for edge events SSE)
  private listeners = new Map<string, Set<SSEListener>>();
  // Periodic cleanup of closed connections (prevents leak when pushMessage not called)
  private cleanupInterval: ReturnType<typeof setInterval>;
  // Prepared statement cache
  private insertStmt: StatementSync | undefined;

  constructor() {
    this.cleanupInterval = setInterval(() => {
      for (const [taskId, conns] of this.connections) {
        const active = conns.filter(c => !c.closed);
        if (active.length === 0) {
          this.connections.delete(taskId);
        } else {
          this.connections.set(taskId, active);
        }
      }
    }, 60_000);
  }

  private getInsertStmt() {
    if (!this.insertStmt) {
      this.insertStmt = getDb().prepare(
        "INSERT INTO sse_messages (task_id, type, timestamp, data) VALUES (?, ?, ?, ?)"
      );
    }
    return this.insertStmt;
  }

  private loadFromDb(taskId: string): SSEMessage[] {
    const rows = getDb()
      .prepare("SELECT type, timestamp, data FROM sse_messages WHERE task_id = ? ORDER BY id DESC LIMIT ?")
      .all(taskId, SSEManager.MAX_HISTORY) as Array<{ type: string; timestamp: string; data: string }>;
    return rows.reverse().map((r) => ({
      type: r.type as SSEMessage["type"],
      taskId,
      timestamp: r.timestamp,
      data: JSON.parse(r.data),
    }));
  }

  createStream(taskId: string): ReadableStream<Uint8Array> {
    const existing = this.connections.get(taskId);
    const activeCount = existing ? existing.filter(c => !c.closed).length : 0;
    if (activeCount >= SSEManager.MAX_CONNECTIONS_PER_TASK) {
      throw new Error(`Too many connections for task ${taskId} (limit: ${SSEManager.MAX_CONNECTIONS_PER_TASK})`);
    }

    // conn is declared outside the ReadableStream so both start() and cancel() can access it
    let conn: SSEConnection;

    return new ReadableStream({
      start: (controller) => {
        conn = { controller, closed: false };

        // Heartbeat every 30s to keep connection alive during long idle periods
        conn.heartbeat = setInterval(() => {
          if (conn.closed) { clearInterval(conn.heartbeat); return; }
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            conn.closed = true;
            clearInterval(conn.heartbeat);
          }
        }, 30_000);

        if (!this.connections.has(taskId)) {
          this.connections.set(taskId, []);
        }
        this.connections.get(taskId)!.push(conn);

        // Replay history for reconnecting clients
        let history = this.history.get(taskId);
        if (!history || history.length === 0) {
          // Fallback to DB if memory history is empty (e.g. after server restart)
          const dbHistory = this.loadFromDb(taskId);
          if (dbHistory.length > 0) {
            this.history.set(taskId, dbHistory);
            history = dbHistory;
          }
        }
        if (history) {
          for (const msg of history) {
            this.sendToController(controller, msg);
          }
        }
      },
      cancel: () => {
        if (conn) {
          conn.closed = true;
          if (conn.heartbeat) clearInterval(conn.heartbeat);
        }
        this.removeClosedConnections(taskId);
      },
    });
  }

  pushMessage(taskId: string, message: SSEMessage): void {
    // Store in memory history
    if (!this.history.has(taskId)) {
      this.history.set(taskId, []);
    }
    const hist = this.history.get(taskId)!;
    hist.push(message);

    // Trim memory history to cap
    if (hist.length > SSEManager.MAX_HISTORY) {
      hist.splice(0, hist.length - SSEManager.MAX_HISTORY);
    }

    // Persist to DB
    try {
      this.getInsertStmt().run(taskId, message.type, message.timestamp, JSON.stringify(message.data));
    } catch {
      // Non-critical: DB write failure should not block SSE delivery
    }

    // Notify programmatic listeners
    const fns = this.listeners.get(taskId);
    if (fns) {
      for (const fn of fns) {
        try { fn(message); } catch { /* listener error should not break push */ }
      }
    }

    // Broadcast to all connections for this task
    const conns = this.connections.get(taskId);
    if (!conns) return;

    for (const conn of conns) {
      if (conn.closed) continue;
      try {
        this.sendToController(conn.controller, message);
      } catch {
        conn.closed = true;
        if (conn.heartbeat) clearInterval(conn.heartbeat);
      }
    }

    this.removeClosedConnections(taskId);
  }

  closeStream(taskId: string): void {
    const conns = this.connections.get(taskId);
    if (!conns) return;

    for (const conn of conns) {
      if (conn.heartbeat) clearInterval(conn.heartbeat);
      if (conn.closed) continue;
      try {
        conn.controller.close();
      } catch {
        // already closed
      }
      conn.closed = true;
    }

    this.connections.delete(taskId);

    // Deduplicate cleanup timers — only clear memory cache, DB data is preserved
    const existing = this.cleanupTimers.get(taskId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      // Skip cleanup if new connections have been established
      const conns = this.connections.get(taskId);
      if (conns && conns.some(c => !c.closed)) {
        this.cleanupTimers.delete(taskId);
        return;
      }
      this.history.delete(taskId);
      this.listeners.delete(taskId);
      this.cleanupTimers.delete(taskId);
    }, 5 * 60 * 1000);
    this.cleanupTimers.set(taskId, timer);
  }

  addListener(taskId: string, fn: SSEListener): () => void {
    if (!this.listeners.has(taskId)) this.listeners.set(taskId, new Set());
    this.listeners.get(taskId)!.add(fn);
    return () => {
      this.listeners.get(taskId)?.delete(fn);
      if (this.listeners.get(taskId)?.size === 0) this.listeners.delete(taskId);
    };
  }

  hasHistory(taskId: string): boolean {
    if (this.history.has(taskId)) return true;
    // Fallback to DB
    const row = getDb()
      .prepare("SELECT 1 FROM sse_messages WHERE task_id = ? LIMIT 1")
      .get(taskId);
    return !!row;
  }

  private sendToController(
    controller: ReadableStreamDefaultController<Uint8Array>,
    message: SSEMessage,
  ): void {
    const data = `data: ${JSON.stringify(message)}\n\n`;
    controller.enqueue(encoder.encode(data));
  }

  private removeClosedConnections(taskId: string): void {
    const conns = this.connections.get(taskId);
    if (!conns) return;

    const active = conns.filter((c) => !c.closed);
    if (active.length === 0) {
      this.connections.delete(taskId);
    } else {
      this.connections.set(taskId, active);
    }
  }
}

export const sseManager = new SSEManager();
