import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { kernelRunRoute } from "./kernel-run.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { kernelNextBroadcaster } from "../kernel-next/sse/singleton.js";
import type { KernelNextSSEEvent } from "../kernel-next/sse/types.js";

describe("POST /api/kernel/tasks/run", () => {
  let app: Hono;
  let db: DatabaseSync;

  beforeEach(() => {
    app = new Hono();
    app.route("/api", kernelRunRoute);
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    __setKernelNextDbForTest(undefined);
  });

  it("returns 202 with taskId + versionHash for a known pipeline", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "diamond" }),
    });
    expect(res.status).toBe(202);
    const json = await res.json() as { ok: boolean; taskId: string; versionHash: string };
    expect(json.ok).toBe(true);
    expect(json.taskId).toMatch(/^kr-/);
    expect(json.versionHash).toMatch(/^[0-9a-f]+$/);
  });

  it("accepts a caller-provided taskId", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "diamond", taskId: "custom-task-123" }),
    });
    expect(res.status).toBe(202);
    const json = await res.json() as { taskId: string };
    expect(json.taskId).toBe("custom-task-123");
  });

  it("rejects unknown pipeline names with UNKNOWN_PIPELINE", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "not-real" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as {
      ok: boolean;
      diagnostics: Array<{ code: string; context?: { known: string[] } }>;
    };
    expect(json.ok).toBe(false);
    expect(json.diagnostics[0]!.code).toBe("UNKNOWN_PIPELINE");
    expect(json.diagnostics[0]!.context?.known).toContain("diamond");
    expect(json.diagnostics[0]!.context?.known).toContain("diamond-slow");
  });

  it("rejects malformed JSON body with INVALID_JSON_BODY", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(json.diagnostics[0]!.code).toBe("INVALID_JSON_BODY");
  });

  it("rejects missing pipeline field with INVALID_REQUEST_BODY", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(json.diagnostics[0]!.code).toBe("INVALID_REQUEST_BODY");
  });

  it("dispatches runPipeline asynchronously and publishes events through the singleton broadcaster", async () => {
    const taskId = `kr-integration-${Date.now()}`;
    const events: KernelNextSSEEvent[] = [];
    // Subscribe BEFORE the POST so we capture history/live events.
    const unsub = kernelNextBroadcaster.subscribe(taskId, (e) => events.push(e));

    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "diamond", taskId }),
    });
    expect(res.status).toBe(202);

    // Give the event loop time for the fire-and-forget runPipeline
    // to finish. 'diamond' (no sleep) completes in well under 1s.
    // Poll up to ~3s for a run_final event.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === "run_final")) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    unsub();
    kernelNextBroadcaster.clearTask(taskId);

    const types = events.map((e) => e.type);
    expect(types).toContain("task_state");
    expect(types).toContain("stage_executing");
    expect(types).toContain("stage_done");
    expect(types).toContain("port_written");
    expect(types).toContain("run_final");

    const runFinal = events.find((e) => e.type === "run_final");
    const data = runFinal!.data as { finalState: string };
    expect(data.finalState).toBe("completed");
  });

});
