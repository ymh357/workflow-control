// REST tests for GET /api/kernel/attempts/:attemptId/details (P7.3 / D25).
// Seeds pipeline_versions + stage_attempts + prompt_contents +
// agent_execution_details directly so the route's SELECT + parse path
// can be exercised without spinning up the runner.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelAttemptDetailsRoute } from "./kernel-attempt-details.js";

interface SeedAedOptions {
  attemptId: string;
  toolCallsJson?: string | null;
  agentStreamJson?: string | null;
  compactEventsJson?: string | null;
  subAgentsJson?: string | null;
  costUsd?: number | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  sessionId?: string | null;
  model?: string;
  durationMs?: number | null;
  startedAt?: number;
  endedAt?: number | null;
  terminationReason?: string | null;
}

function seedStageAttempt(
  db: DatabaseSync,
  opts: {
    attemptId: string;
    taskId?: string;
    stageName?: string;
    status?: "running" | "success" | "error" | "superseded";
    startedAt?: number;
    endedAt?: number | null;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO pipeline_versions
     (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
     VALUES ('v-test', 'p', 0, NULL, '{}', '')`,
  ).run();
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx,
      started_at, ended_at, status)
     VALUES (?, ?, 'v-test', ?, 1, ?, ?, ?)`,
  ).run(
    opts.attemptId,
    opts.taskId ?? "t-test",
    opts.stageName ?? "s",
    opts.startedAt ?? 1000,
    opts.endedAt ?? null,
    opts.status ?? "success",
  );
}

function seedAed(db: DatabaseSync, opts: SeedAedOptions): void {
  db.prepare(
    `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at)
     VALUES ('h-test', 'c-test', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_execution_details
     (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
      sub_agents_json,
      tool_calls_json, agent_stream_json, compact_events_json,
      cost_usd, token_input, token_output, session_id, duration_ms,
      started_at, ended_at, termination_reason, last_heartbeat_at)
     VALUES (?, 'r', 'h-test', 'c-test', ?,
             ?,
             COALESCE(?, '[]'), COALESCE(?, '[]'), COALESCE(?, '[]'),
             ?, ?, ?, ?, ?,
             ?, ?, ?, ?)`,
  ).run(
    opts.attemptId,
    opts.model ?? "claude",
    opts.subAgentsJson ?? null,
    opts.toolCallsJson ?? null,
    opts.agentStreamJson ?? null,
    opts.compactEventsJson ?? null,
    opts.costUsd ?? null,
    opts.tokenInput ?? null,
    opts.tokenOutput ?? null,
    opts.sessionId ?? null,
    opts.durationMs ?? null,
    opts.startedAt ?? 1000,
    opts.endedAt ?? null,
    opts.terminationReason ?? null,
    opts.startedAt ?? 1000, // last_heartbeat_at
  );
}

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelAttemptDetailsRoute);
  return app;
}

describe("GET /api/kernel/attempts/:attemptId/details", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    __setKernelNextDbForTest(undefined);
    db.close();
  });

  it("returns 404 for unknown attempt", async () => {
    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/attempts/missing/details"),
    );
    expect(res.status).toBe(404);
    const body = await res.json() as {
      ok: boolean;
      diagnostics: Array<{ code: string; message: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("ATTEMPT_NOT_FOUND");
    expect(body.diagnostics[0]!.message).toBe("missing");
  });

  it("returns parsed detail arrays + scalar fields for an existing row", async () => {
    seedStageAttempt(db, {
      attemptId: "a1",
      status: "success",
      startedAt: 1000,
      endedAt: 1800,
    });
    seedAed(db, {
      attemptId: "a1",
      toolCallsJson: JSON.stringify([
        { id: "tc1", name: "write_port", input: { stage: "s", port: "o" } },
      ]),
      agentStreamJson: JSON.stringify([
        { type: "text", text: "hello" },
        { type: "thinking", text: "reasoning..." },
      ]),
      compactEventsJson: JSON.stringify([
        { startedAt: "2026-04-20T00:00:00Z", endedAt: null },
      ]),
      subAgentsJson: JSON.stringify([{ name: "sub-a" }]),
      costUsd: 0.0123,
      tokenInput: 120,
      tokenOutput: 80,
      sessionId: "sess-abc",
      durationMs: 800,
      startedAt: 1000,
      endedAt: 1800,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/attempts/a1/details"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      details: {
        toolCalls: Array<{ id: string; name: string }>;
        agentStream: Array<{ type: string }>;
        compactEvents: unknown[];
        subAgents: unknown[];
        statusHistory: Array<{ status: string; startedAt: number; endedAt: number | null }>;
        costUsd: number | null;
        inputTokens: number | null;
        outputTokens: number | null;
        sessionId: string | null;
        model: string | null;
        durationMs: number | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.details.toolCalls).toHaveLength(1);
    expect(body.details.toolCalls[0]!.name).toBe("write_port");
    expect(body.details.agentStream.map((e) => e.type)).toEqual(["text", "thinking"]);
    expect(body.details.compactEvents).toHaveLength(1);
    expect(body.details.subAgents).toHaveLength(1);
    expect(body.details.statusHistory).toEqual([
      { status: "success", startedAt: 1000, endedAt: 1800 },
    ]);
    expect(body.details.costUsd).toBe(0.0123);
    expect(body.details.inputTokens).toBe(120);
    expect(body.details.outputTokens).toBe(80);
    expect(body.details.sessionId).toBe("sess-abc");
    expect(body.details.model).toBe("claude");
    expect(body.details.durationMs).toBe(800);
  });

  it("handles default '[]' json columns + null sub_agents_json gracefully (empty arrays)", async () => {
    seedStageAttempt(db, { attemptId: "a2", status: "running", endedAt: null });
    // Do not pass any json columns -> DEFAULT '[]' for the NOT NULL
    // columns + NULL for sub_agents_json (has no DEFAULT).
    seedAed(db, { attemptId: "a2", subAgentsJson: null });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/attempts/a2/details"),
    );
    const body = await res.json() as {
      ok: boolean;
      details: {
        toolCalls: unknown[];
        agentStream: unknown[];
        compactEvents: unknown[];
        subAgents: unknown[];
      };
    };
    expect(body.details.toolCalls).toEqual([]);
    expect(body.details.agentStream).toEqual([]);
    expect(body.details.compactEvents).toEqual([]);
    expect(body.details.subAgents).toEqual([]);
  });

  it("returns empty statusHistory when stage_attempts row is absent", async () => {
    // Skip stage_attempts; directly seed a pipeline_versions row and
    // insert agent_execution_details against a stage_attempts row whose
    // FK points to a row we'll also insert — then DELETE that row so
    // the route's JOIN lookup returns nothing. (FK is ON DELETE RESTRICT
    // so we bypass by disabling FKs for this test row.)
    db.prepare("PRAGMA foreign_keys = OFF").run();
    try {
      db.prepare(
        `INSERT OR IGNORE INTO pipeline_versions
         (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
         VALUES ('v-test', 'p', 0, NULL, '{}', '')`,
      ).run();
      db.prepare(
        `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at)
         VALUES ('h-test', 'c-test', 0)`,
      ).run();
      db.prepare(
        `INSERT INTO agent_execution_details
         (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
          tool_calls_json, agent_stream_json, compact_events_json,
          started_at, last_heartbeat_at)
         VALUES ('orphan', 'r', 'h-test', 'c-test', 'm', '[]', '[]', '[]', 1, 1)`,
      ).run();
    } finally {
      db.prepare("PRAGMA foreign_keys = ON").run();
    }

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/attempts/orphan/details"),
    );
    const body = await res.json() as {
      ok: boolean;
      details: { statusHistory: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.details.statusHistory).toEqual([]);
  });
});
