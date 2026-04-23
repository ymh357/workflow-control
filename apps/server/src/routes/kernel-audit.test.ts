// REST tests for GET /api/kernel/tasks/:taskId/audit (P6.3 / D26).
// Seeds hot_update_events rows directly (with optional pipeline_proposals
// join data) so the route's SELECT + kind-mapping can be exercised
// without spinning up the runner.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelAuditRoute } from "./kernel-audit.js";
import type { AuditEvent } from "./kernel-audit.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelAuditRoute);
  return app;
}

// hot_update_events requires no FK constraints on task_id, so any string
// works for routing-only tests. proposal_id is a nullable FK to
// pipeline_proposals — omit or set null for tests that don't need it.
function insertHotUpdateEvent(
  db: DatabaseSync,
  row: {
    eventId: string;
    taskId: string;
    fromVersion: string;
    toVersion: string;
    actor: string;
    status: "success" | "failed" | "rolled_back";
    startedAt: number;
    finishedAt?: number | null;
    proposalId?: string | null;
    rerunFromStage?: string | null;
    diagnosticJson?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO hot_update_events
     (event_id, task_id, from_version, to_version, actor, proposal_id,
      rerun_from_stage, status, started_at, finished_at, diagnostic_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.eventId,
    row.taskId,
    row.fromVersion,
    row.toVersion,
    row.actor,
    row.proposalId ?? null,
    row.rerunFromStage ?? null,
    row.status,
    row.startedAt,
    row.finishedAt ?? null,
    row.diagnosticJson ?? null,
  );
}

// Insert a pipeline_version (required FK for pipeline_proposals.base_version)
// and then a pipeline_proposals row.
function insertProposalWithVersion(
  db: DatabaseSync,
  row: {
    proposalId: string;
    baseVersion: string;
    proposedVersion: string | null;
    actor: string;
    status: "pending" | "approved" | "rejected";
  },
): void {
  // Insert a stub pipeline_versions row for the FK (no pipeline_name needed
  // beyond the unique constraint — use a synthetic name).
  db.prepare(
    `INSERT OR IGNORE INTO pipeline_versions
     (version_hash, pipeline_name, ir_json, ts_source, created_at)
     VALUES (?, ?, '{}', '', 0)`,
  ).run(row.baseVersion, `test-pipeline-${row.baseVersion}`);

  if (row.proposedVersion) {
    db.prepare(
      `INSERT OR IGNORE INTO pipeline_versions
       (version_hash, pipeline_name, ir_json, ts_source, created_at)
       VALUES (?, ?, '{}', '', 0)`,
    ).run(row.proposedVersion, `test-pipeline-${row.proposedVersion}`);
  }

  db.prepare(
    `INSERT INTO pipeline_proposals
     (proposal_id, base_version, proposed_version, actor, status,
      diagnostic_json, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 0)`,
  ).run(
    row.proposalId,
    row.baseVersion,
    row.proposedVersion,
    row.actor,
    row.status,
  );
}

describe("GET /api/kernel/tasks/:taskId/audit", () => {
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

  it("returns empty array for unknown taskId", async () => {
    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/unknown/audit"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, events: [] });
  });

  it("maps status=success to kind=migrate", async () => {
    insertHotUpdateEvent(db, {
      eventId: "e1",
      taskId: "t1",
      fromVersion: "aaa",
      toVersion: "bbb",
      actor: "user",
      status: "success",
      startedAt: 1000,
      finishedAt: 1500,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t1/audit"),
    );
    const body = await res.json() as { ok: boolean; events: AuditEvent[] };
    expect(body.ok).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.kind).toBe("migrate");
    expect(body.events[0]!.from_version).toBe("aaa");
    expect(body.events[0]!.to_version).toBe("bbb");
    expect(body.events[0]!.actor).toBe("user");
  });

  it("maps status=rolled_back to kind=rollback", async () => {
    insertHotUpdateEvent(db, {
      eventId: "e2",
      taskId: "t2",
      fromVersion: "ccc",
      toVersion: "ddd",
      actor: "user",
      status: "rolled_back",
      startedAt: 2000,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t2/audit"),
    );
    const body = await res.json() as { ok: boolean; events: AuditEvent[] };
    expect(body.events[0]!.kind).toBe("rollback");
  });

  it("maps status=failed to kind=migrate_failed", async () => {
    insertHotUpdateEvent(db, {
      eventId: "e3",
      taskId: "t3",
      fromVersion: "eee",
      toVersion: "fff",
      actor: "claude",
      status: "failed",
      startedAt: 3000,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t3/audit"),
    );
    const body = await res.json() as { ok: boolean; events: AuditEvent[] };
    expect(body.events[0]!.kind).toBe("migrate_failed");
  });

  it("returns events in chronological (started_at ASC) order", async () => {
    // Seed out-of-order
    insertHotUpdateEvent(db, {
      eventId: "late", taskId: "t4", fromVersion: "v2", toVersion: "v3",
      actor: "user", status: "rolled_back", startedAt: 3000,
    });
    insertHotUpdateEvent(db, {
      eventId: "early", taskId: "t4", fromVersion: "v1", toVersion: "v2",
      actor: "user", status: "success", startedAt: 1000,
    });
    insertHotUpdateEvent(db, {
      eventId: "mid", taskId: "t4", fromVersion: "v1.5", toVersion: "v2.5",
      actor: "claude", status: "failed", startedAt: 2000,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t4/audit"),
    );
    const body = await res.json() as { ok: boolean; events: AuditEvent[] };
    expect(body.events.map((e) => e.event_id)).toEqual(["early", "mid", "late"]);
  });

  it("joins proposal_status from pipeline_proposals when proposal_id is set", async () => {
    insertProposalWithVersion(db, {
      proposalId: "prop-1",
      baseVersion: "base-v1",
      proposedVersion: "prop-v1",
      actor: "claude",
      status: "approved",
    });
    insertHotUpdateEvent(db, {
      eventId: "e5",
      taskId: "t5",
      fromVersion: "base-v1",
      toVersion: "prop-v1",
      actor: "user",
      status: "success",
      startedAt: 5000,
      proposalId: "prop-1",
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t5/audit"),
    );
    const body = await res.json() as { ok: boolean; events: AuditEvent[] };
    expect(body.events[0]!.proposal_id).toBe("prop-1");
    expect(body.events[0]!.proposal_status).toBe("approved");
  });

  it("returns proposal_status=null when event has no proposal_id", async () => {
    insertHotUpdateEvent(db, {
      eventId: "e6",
      taskId: "t6",
      fromVersion: "x",
      toVersion: "y",
      actor: "user",
      status: "rolled_back",
      startedAt: 6000,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t6/audit"),
    );
    const body = await res.json() as { ok: boolean; events: AuditEvent[] };
    expect(body.events[0]!.proposal_status).toBeNull();
    expect(body.events[0]!.proposal_id).toBeNull();
  });

  it("parses diagnostic_json when present", async () => {
    insertHotUpdateEvent(db, {
      eventId: "e7",
      taskId: "t7",
      fromVersion: "a",
      toVersion: "b",
      actor: "user",
      status: "failed",
      startedAt: 7000,
      diagnosticJson: JSON.stringify({ reason: "conflict" }),
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t7/audit"),
    );
    const body = await res.json() as { ok: boolean; events: AuditEvent[] };
    expect(body.events[0]!.diagnostic).toEqual({ reason: "conflict" });
  });

  it("does not return events for a different taskId", async () => {
    insertHotUpdateEvent(db, {
      eventId: "e8",
      taskId: "other-task",
      fromVersion: "p",
      toVersion: "q",
      actor: "user",
      status: "success",
      startedAt: 8000,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t8/audit"),
    );
    const body = await res.json() as { ok: boolean; events: AuditEvent[] };
    expect(body.events).toHaveLength(0);
  });
});
