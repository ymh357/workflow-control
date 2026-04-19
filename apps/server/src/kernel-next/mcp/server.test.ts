// End-to-end MCP server test: instantiate createKernelMcp, pull tools out,
// invoke each tool's handler directly, verify response envelope shape.
//
// Follows the pattern in src/lib/debug-mcp.test.ts — we mock
// createSdkMcpServer to return the raw {name, version, tools} object so
// the tools array is directly addressable.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
}));

// eslint-disable-next-line import/first
import { createKernelMcp } from "./server.js";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { runPipeline } from "../runtime/runner.js";
import { versionHash } from "../ir/canonical.js";
import { generatePipeline, diamondIR } from "../generator-mock/mini-generator.js";
import type { StageHandlerMap } from "../runtime/mock-executor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveTscPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, "node_modules", ".bin", "tsc");
    if (existsSync(cand)) return cand;
    dir = dirname(dir);
  }
  throw new Error("tsc not found");
}
const TSC_PATH = resolveTscPath();

interface McpTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function getTools(mcp: unknown): Map<string, McpTool> {
  // With createSdkMcpServer mocked to return opts directly, the shape is
  // { name, version, tools: [{name, handler}, ...] }.
  const toolsArray = (mcp as { tools: McpTool[] }).tools;
  const map = new Map<string, McpTool>();
  for (const t of toolsArray) map.set(t.name, t);
  return map;
}

function parsePayload(resp: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(resp.content[0]!.text);
}

describe("kernel-next MCP server", () => {
  beforeAll(() => {
    expect(existsSync(TSC_PATH)).toBe(true);
  });

  it("exposes 12 tools with expected names", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH });
    const tools = getTools(mcp);
    expect([...tools.keys()].sort()).toEqual([
      "answer_gate",
      "approve_proposal",
      "diff_runs",
      "list_gates",
      "list_proposals",
      "propose_pipeline_change",
      "query_lineage",
      "read_port",
      "reject_proposal",
      "submit_pipeline",
      "validate_pipeline",
      "write_port",
    ]);
    db.close();
  });

  it("submit_pipeline end-to-end: generator -> submit -> validated -> persisted", { timeout: 20_000 }, async () => {
    const db2 = new DatabaseSync(":memory:");
    initKernelNextSchema(db2);
    const mcp = createKernelMcp(db2, { tscPath: TSC_PATH });
    const t = getTools(mcp);

    const gen = generatePipeline({ task: "diamond" });
    const resp = await t.get("submit_pipeline")!.handler({ ir: gen.ir });
    const payload = parsePayload(resp) as { ok: boolean; versionHash?: string };
    expect(payload.ok).toBe(true);
    expect(payload.versionHash).toBe(versionHash(gen.ir));

    // Row in pipeline_versions.
    const row = db2.prepare("SELECT pipeline_name FROM pipeline_versions WHERE version_hash = ?")
      .get(payload.versionHash!) as { pipeline_name: string };
    expect(row.pipeline_name).toBe("diamond");
    db2.close();
  });

  it("validate_pipeline rejects a type-mismatched IR with WIRE_TYPE_MISMATCH", { timeout: 20_000 }, async () => {
    const db2 = new DatabaseSync(":memory:");
    initKernelNextSchema(db2);
    const mcp = createKernelMcp(db2, { tscPath: TSC_PATH });
    const t = getTools(mcp);

    const bad = diamondIR();
    // Make A.x a string so wire A.x -> B.x (number) fails tsc.
    bad.stages[0]!.outputs[0]!.type = "string";

    const resp = await t.get("validate_pipeline")!.handler({ ir: bad });
    const payload = parsePayload(resp) as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics.some((d) => d.code === "WIRE_TYPE_MISMATCH")).toBe(true);
    db2.close();
  });

  it("read_port + query_lineage after a real run", { timeout: 30_000 }, async () => {
    const db2 = new DatabaseSync(":memory:");
    initKernelNextSchema(db2);
    const mcp = createKernelMcp(db2, { tscPath: TSC_PATH, skipTypeCheck: true });
    const t = getTools(mcp);

    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db2, ir, { versionHash: hash, tsSource: "" });

    const handlers: StageHandlerMap = {
      A: () => ({ x: 42 }),
      B: (i) => ({ y: `B:${i.x}` }),
      C: (i) => ({ z: `C:${i.x}` }),
      D: (i) => ({ final: `${i.b}|${i.c}` }),
    };
    await runPipeline({ db: db2, ir, taskId: "rr1", versionHash: hash, handlers });

    // read_port latest
    const rp = await t.get("read_port")!.handler({
      taskId: "rr1", stage: "D", port: "final",
    });
    const payload = parsePayload(rp) as { ok: boolean; value: unknown; truncated: boolean };
    expect(payload.ok).toBe(true);
    expect(payload.truncated).toBe(false);
    expect(payload.value).toBe("B:42|C:42");

    // query_lineage
    const ql = await t.get("query_lineage")!.handler({
      stage: "A", port: "x", taskId: "rr1",
    });
    const lineage = parsePayload(ql) as { ok: boolean; report: { latestWrite: { valuePreview: string } | null } };
    expect(lineage.ok).toBe(true);
    expect(lineage.report.latestWrite!.valuePreview).toBe("42");

    db2.close();
  });

  it("read_port truncates values above maxBytes", { timeout: 15_000 }, async () => {
    const db2 = new DatabaseSync(":memory:");
    initKernelNextSchema(db2);
    const mcp = createKernelMcp(db2, { tscPath: TSC_PATH, skipTypeCheck: true, defaultMaxBytes: 16 });
    const t = getTools(mcp);

    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db2, ir, { versionHash: hash, tsSource: "" });

    const handlers: StageHandlerMap = {
      A: () => ({ x: 42 }),
      B: (i) => ({ y: "LONG-VALUE-ABOVE-MAX" }),
      C: (i) => ({ z: "short" }),
      D: (i) => ({ final: "ok" }),
    };
    await runPipeline({ db: db2, ir, taskId: "rr2", versionHash: hash, handlers });

    const rp = await t.get("read_port")!.handler({
      taskId: "rr2", stage: "B", port: "y",
    });
    const payload = parsePayload(rp) as { ok: boolean; truncated: boolean; totalBytes: number };
    expect(payload.ok).toBe(true);
    expect(payload.truncated).toBe(true);
    expect(payload.totalBytes).toBeGreaterThan(16);
    db2.close();
  });

  it("propose_pipeline_change creates a pending proposal", { timeout: 20_000 }, async () => {
    const db2 = new DatabaseSync(":memory:");
    initKernelNextSchema(db2);
    const mcp = createKernelMcp(db2, { tscPath: TSC_PATH, skipTypeCheck: true });
    const t = getTools(mcp);

    const submitResp = await t.get("submit_pipeline")!.handler({ ir: diamondIR() });
    const submitPayload = parsePayload(submitResp) as { ok: true; versionHash: string };

    const proposeResp = await t.get("propose_pipeline_change")!.handler({
      currentVersion: submitPayload.versionHash,
      patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
      actor: "ai:test",
    });
    const pr = parsePayload(proposeResp) as {
      ok: boolean; proposalId?: string; autoApplied?: boolean;
    };
    expect(pr.ok).toBe(true);
    expect(pr.autoApplied).toBe(false);

    const row = db2.prepare("SELECT status FROM pipeline_proposals WHERE proposal_id = ?")
      .get(pr.proposalId!) as { status: string };
    expect(row.status).toBe("pending");
    db2.close();
  });

  it("diff_runs reports stage output differences", { timeout: 15_000 }, async () => {
    const db2 = new DatabaseSync(":memory:");
    initKernelNextSchema(db2);
    const mcp = createKernelMcp(db2, { tscPath: TSC_PATH, skipTypeCheck: true });
    const t = getTools(mcp);

    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db2, ir, { versionHash: hash, tsSource: "" });

    await runPipeline({
      db: db2, ir, taskId: "dA", versionHash: hash,
      handlers: {
        A: () => ({ x: 1 }),
        B: (i) => ({ y: `${i.x}` }),
        C: (i) => ({ z: `${i.x}` }),
        D: (i) => ({ final: `${i.b}${i.c}` }),
      },
    });
    await runPipeline({
      db: db2, ir, taskId: "dB", versionHash: hash,
      handlers: {
        A: () => ({ x: 2 }),
        B: (i) => ({ y: `${i.x}` }),
        C: (i) => ({ z: `${i.x}` }),
        D: (i) => ({ final: `${i.b}${i.c}` }),
      },
    });

    const resp = await t.get("diff_runs")!.handler({ taskA: "dA", taskB: "dB" });
    const payload = parsePayload(resp) as {
      ok: boolean;
      report: { stageComparison: Array<{ stage: string; outputsDiffer: string[]; outputsEqual: boolean }> };
    };
    expect(payload.ok).toBe(true);
    const stageA = payload.report.stageComparison.find((s) => s.stage === "A");
    expect(stageA!.outputsDiffer).toEqual(["x"]);
    expect(stageA!.outputsEqual).toBe(false);
    db2.close();
  });

  it("proposal lifecycle: propose -> list -> approve -> list (filtered)", async () => {
    const db3 = new DatabaseSync(":memory:");
    initKernelNextSchema(db3);
    const mcp = createKernelMcp(db3, { tscPath: TSC_PATH, skipTypeCheck: true });
    const t = getTools(mcp);

    const ir = diamondIR();
    const submit = parsePayload(
      await t.get("submit_pipeline")!.handler({ ir }),
    ) as { ok: true; versionHash: string };

    const proposed = parsePayload(
      await t.get("propose_pipeline_change")!.handler({
        currentVersion: submit.versionHash,
        patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
        actor: "ai:test",
      }),
    ) as { ok: true; proposalId: string; proposedVersion: string; autoApplied: false };
    expect(proposed.autoApplied).toBe(false);

    const listed = parsePayload(
      await t.get("list_proposals")!.handler({ status: "pending" }),
    ) as { ok: true; proposals: Array<{ proposalId: string; status: string; actor: string }> };
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0]!.proposalId).toBe(proposed.proposalId);
    expect(listed.proposals[0]!.status).toBe("pending");

    const approved = parsePayload(
      await t.get("approve_proposal")!.handler({ proposalId: proposed.proposalId }),
    ) as { ok: true; status: string };
    expect(approved.status).toBe("approved");

    const afterPending = parsePayload(
      await t.get("list_proposals")!.handler({ status: "pending" }),
    ) as { ok: true; proposals: unknown[] };
    expect(afterPending.proposals).toHaveLength(0);

    const afterAll = parsePayload(
      await t.get("list_proposals")!.handler({}),
    ) as { ok: true; proposals: Array<{ status: string }> };
    expect(afterAll.proposals).toHaveLength(1);
    expect(afterAll.proposals[0]!.status).toBe("approved");

    db3.close();
  });

  it("reject_proposal persists reason and blocks second approve", async () => {
    const db4 = new DatabaseSync(":memory:");
    initKernelNextSchema(db4);
    const mcp = createKernelMcp(db4, { tscPath: TSC_PATH, skipTypeCheck: true });
    const t = getTools(mcp);

    const ir = diamondIR();
    const submit = parsePayload(
      await t.get("submit_pipeline")!.handler({ ir }),
    ) as { ok: true; versionHash: string };

    const proposed = parsePayload(
      await t.get("propose_pipeline_change")!.handler({
        currentVersion: submit.versionHash,
        patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
        actor: "ai:test",
      }),
    ) as { ok: true; proposalId: string };

    const rejected = parsePayload(
      await t.get("reject_proposal")!.handler({
        proposalId: proposed.proposalId,
        reason: "breaks contract",
      }),
    ) as { ok: true; status: string };
    expect(rejected.status).toBe("rejected");

    const reApprove = parsePayload(
      await t.get("approve_proposal")!.handler({ proposalId: proposed.proposalId }),
    ) as { ok: false; diagnostics: Array<{ code: string }> };
    expect(reApprove.ok).toBe(false);
    expect(reApprove.diagnostics[0]!.code).toBe("PROPOSAL_ALREADY_RESOLVED");

    db4.close();
  });
});
