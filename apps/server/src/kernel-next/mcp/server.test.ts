// End-to-end MCP server test: instantiate createKernelMcp, pull tools out,
// invoke each tool's handler directly, verify response envelope shape.
//
// Follows the pattern in src/lib/debug-mcp.test.ts — we mock
// createSdkMcpServer to return the raw {name, version, tools} object so
// the tools array is directly addressable.

import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
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
import { KernelService } from "./kernel.js";
import { taskRegistry } from "../runtime/task-registry.js";

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

// Build a prompts map covering every AgentStage.promptRef in an IR so
// submit_pipeline does not fail with PROMPT_REF_MISSING. Uses "dummy"
// content — these tests don't exercise prompt content, only the
// submit/propose wiring.
function promptsForIR(ir: { stages: readonly { type: string; config: unknown }[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of ir.stages) {
    if (s.type === "agent") {
      const cfg = s.config as { promptRef?: string };
      if (cfg.promptRef) out[cfg.promptRef] = "dummy";
    }
  }
  return out;
}

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

  it("combined surface exposes 23 tools with expected names", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH, surface: "combined" });
    const tools = getTools(mcp);
    expect([...tools.keys()].sort()).toEqual([
      "answer_gate",
      "approve_proposal",
      "diff_runs",
      "dry_run_proposal",
      "dry_run_stage",
      "get_task_status",
      "list_gates",
      "list_proposals",
      "migrate_task",
      "propose_pipeline_change",
      "query_hot_update_stats",
      "query_lineage",
      "read_port",
      "reject_proposal",
      "replay_stage",
      "rollback_hot_update",
      "run_pipeline",
      "start_pipeline_generator",
      "submit_pipeline",
      "update_registry_pipeline",
      "validate_pipeline",
      "wait_pipeline_result",
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
    const prompts = promptsForIR(gen.ir);
    const resp = await t.get("submit_pipeline")!.handler({ ir: gen.ir, prompts });
    const payload = parsePayload(resp) as { ok: boolean; versionHash?: string };
    expect(payload.ok).toBe(true);
    // Pipeline-level hash now includes prompts — differs from IR-only hash.
    expect(payload.versionHash).not.toBe(versionHash(gen.ir));

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

    const ir = diamondIR();
    const submitResp = await t.get("submit_pipeline")!.handler({ ir, prompts: promptsForIR(ir) });
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
      await t.get("submit_pipeline")!.handler({ ir, prompts: promptsForIR(ir) }),
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
      await t.get("submit_pipeline")!.handler({ ir, prompts: promptsForIR(ir) }),
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

describe("A6: external vs internal MCP surfaces (§9.1 physical separation)", () => {
  // External surface = AI-facing. Per design doc the external tools
  // are strictly read-/submit-oriented. Specifically: write_port MUST
  // NOT be emitted on this surface. The only way an external consumer
  // could affect port state is via MCP tools, and write_port simply
  // isn't in the descriptor list — the SDK can't route a tool_use
  // whose name doesn't match any declared tool.
  it("external surface does NOT expose write_port", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH, surface: "external" });
    const tools = getTools(mcp);
    expect(tools.has("write_port")).toBe(false);
    db.close();
  });

  it("external surface exposes exactly the externally-safe tools", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH, surface: "external" });
    const tools = getTools(mcp);
    expect([...tools.keys()].sort()).toEqual([
      "answer_gate",
      "approve_proposal",
      "diff_runs",
      "dry_run_proposal",
      "dry_run_stage",
      "get_task_status",
      "list_gates",
      "list_proposals",
      "migrate_task",
      "propose_pipeline_change",
      "query_hot_update_stats",
      "query_lineage",
      "read_port",
      "reject_proposal",
      "replay_stage",
      "rollback_hot_update",
      "run_pipeline",
      "start_pipeline_generator",
      "submit_pipeline",
      "update_registry_pipeline",
      "validate_pipeline",
      "wait_pipeline_result",
    ]);
    db.close();
  });

  it("internal surface exposes ONLY write_port (no external tools leak)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH, surface: "internal" });
    const tools = getTools(mcp);
    expect([...tools.keys()]).toEqual(["write_port"]);
    db.close();
  });

  it("server name reflects the surface (external/internal/combined)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ext = createKernelMcp(db, { tscPath: TSC_PATH, surface: "external" }) as { name: string };
    const int = createKernelMcp(db, { tscPath: TSC_PATH, surface: "internal" }) as { name: string };
    const combined = createKernelMcp(db, { tscPath: TSC_PATH, surface: "combined" }) as { name: string };
    expect(ext.name).toBe("__kernel_next_external__");
    expect(int.name).toBe("__kernel_next_internal__");
    expect(combined.name).toBe("__kernel_next__");
    db.close();
  });

  it("combined surface still includes every tool (backwards compat)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH, surface: "combined" });
    const tools = getTools(mcp);
    // Stage 5A: +3 tools (dry_run_proposal / update_registry_pipeline / rollback_hot_update)
    // Stage 5E: +1 tool (query_hot_update_stats)
    // Phase 4.5 Tier2: +1 tool (replay_stage)
    // Phase 4.5 Tier3: +1 tool (dry_run_stage)
    expect(tools.size).toBe(23);
    expect(tools.has("write_port")).toBe(true);
    expect(tools.has("submit_pipeline")).toBe(true);
    expect(tools.has("migrate_task")).toBe(true);
    expect(tools.has("start_pipeline_generator")).toBe(true);
    expect(tools.has("wait_pipeline_result")).toBe(true);
    expect(tools.has("run_pipeline")).toBe(true);
    expect(tools.has("dry_run_proposal")).toBe(true);
    expect(tools.has("update_registry_pipeline")).toBe(true);
    expect(tools.has("rollback_hot_update")).toBe(true);
    expect(tools.has("query_hot_update_stats")).toBe(true);
    expect(tools.has("replay_stage")).toBe(true);
    expect(tools.has("dry_run_stage")).toBe(true);
    db.close();
  });

  it("default surface (no explicit argument) is 'external'", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH });
    const tools = getTools(mcp);
    // 'external' = EXTERNAL_TOOLS only (22 tools after Phase 4.5 Tier3; excludes write_port).
    expect(tools.size).toBe(22);
    expect(tools.has("write_port")).toBe(false);
    expect(tools.has("submit_pipeline")).toBe(true);
    db.close();
  });

  it("external surface includes start_pipeline_generator and wait_pipeline_result", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH, surface: "external" });
    const tools = getTools(mcp);
    expect(tools.has("start_pipeline_generator")).toBe(true);
    expect(tools.has("wait_pipeline_result")).toBe(true);
    db.close();
  });

  it("internal surface does NOT include pg-entry tools", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH, surface: "internal" });
    const tools = getTools(mcp);
    expect(tools.has("start_pipeline_generator")).toBe(false);
    expect(tools.has("wait_pipeline_result")).toBe(false);
    db.close();
  });
});

describe("run_pipeline tool surface", () => {
  it("is in EXTERNAL surface", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH, surface: "external" });
    const tools = getTools(mcp);
    expect([...tools.keys()]).toContain("run_pipeline");
    db.close();
  });

  it("is NOT in INTERNAL surface", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { tscPath: TSC_PATH, surface: "internal" });
    const tools = getTools(mcp);
    expect([...tools.keys()]).not.toContain("run_pipeline");
    db.close();
  });
});

// A7.2 Bug 1 regression — ensure a caller-supplied PortRuntime is
// actually reused by the write_port handler, not silently replaced by
// a fresh PortRuntime that would bypass any onPortWritten hook.
describe("A7.2: createKernelMcp reuses caller-supplied PortRuntime", () => {
  it("write_port routes through options.portRuntime (onPortWritten fires)", { timeout: 15_000 }, async () => {
    const { PortRuntime } = await import("../runtime/port-runtime.js");
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);

    // Seed a pipeline + an attempt to satisfy write_port's FK checks.
    const mcpExternal = createKernelMcp(db, { tscPath: TSC_PATH, skipTypeCheck: true, surface: "combined" });
    const tExternal = getTools(mcpExternal);
    const { diamondIR: diamondIrFn } = await import("../generator-mock/mini-generator.js");
    const ir = diamondIrFn();
    const submitResp = await tExternal.get("submit_pipeline")!.handler({
      ir,
      prompts: promptsForIR(ir),
    });
    const submit = JSON.parse(submitResp.content[0]!.text) as { versionHash: string };
    const taskId = "portRuntime-reuse-test";

    // Open a stage_attempt so write_port has an attemptId to target.
    const portWritten: Array<{ stage: string; port: string; value: unknown }> = [];
    const liveRuntime = new PortRuntime(
      db,
      { send: () => { /* inert dispatcher */ } },
      "regular",
      ({ stageName, portName, value }) => {
        portWritten.push({ stage: stageName, port: portName, value });
      },
    );
    const { attemptId } = liveRuntime.startAttempt({
      taskId,
      versionHash: submit.versionHash,
      stageName: "A",
    });

    // Build a SECOND MCP server that reuses the live runtime.
    const mcp = createKernelMcp(db, {
      tscPath: TSC_PATH,
      skipTypeCheck: true,
      surface: "combined",
      portRuntime: liveRuntime,
    });
    const t = getTools(mcp);

    const resp = await t.get("write_port")!.handler({
      taskId,
      versionHash: submit.versionHash,
      attemptId,
      stage: "A",
      port: "x",
      value: 42,
    });
    const parsed = JSON.parse(resp.content[0]!.text) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    // Hook fired exactly once with our write — NOT silently bypassed
    // by a freshly constructed PortRuntime.
    expect(portWritten).toHaveLength(1);
    expect(portWritten[0]).toEqual({ stage: "A", port: "x", value: 42 });

    db.close();
  });
});

// Task 1.9 — write_port must refuse stage='__external__'. Only the
// runner's seed phase is allowed to produce port_values rows with that
// reserved stage name; agents writing runtime ports must never forge
// external-input lineage.
describe("write_port rejects __external__ sentinel", () => {
  it("rejects stage='__external__' before touching FK / lineage state", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, {
      tscPath: TSC_PATH,
      skipTypeCheck: true,
      surface: "combined",
    });
    const t = getTools(mcp);

    // Intentionally do NOT seed a matching attempt row. The sentinel
    // check must fire first — if the handler reached the FK lookup it
    // would instead complain about a missing attemptId.
    const resp = await t.get("write_port")!.handler({
      taskId: "irrelevant",
      attemptId: "irrelevant",
      stage: "__external__",
      port: "anything",
      value: 1,
    });

    expect(resp.isError).toBe(true);
    const payload = parsePayload(resp) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/reserved/i);
    expect(payload.error).toMatch(/__external__/);

    db.close();
  });
});

// Task 4: answer_gate handler dispatches GATE_REJECTED for rollback answers
// and GATE_ANSWERED for forward answers — branching on AnswerGateResult.kind.
describe("answer_gate MCP handler — reject dispatch", () => {
  afterEach(() => {
    taskRegistry.__clearForTest();
  });

  // Seed an in-memory DB with a pipeline whose gate G has routes:
  //   { approve: "B", reject: "A" }
  // and a wire A.out -> G.i, making A a transitive upstream of G
  // (so "reject" is a rollback answer and kernel returns kind="rejected").
  // Returns { db, gateId } — gateId is assigned by createGate.
  function setupRejectReadyDb(taskId: string): { db: DatabaseSync; gateId: string } {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);

    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = {
      name: "mcp-reject-test",
      stages: [
        {
          name: "A",
          type: "agent" as const,
          inputs: [],
          outputs: [{ name: "out", type: "unknown" }],
          config: { promptRef: "p", reads: [] },
        },
        {
          name: "G",
          type: "gate" as const,
          inputs: [{ name: "i", type: "unknown" }],
          outputs: [],
          config: {
            question: { text: "approve or reject?", options: ["approve", "reject"] },
            routing: { routes: { approve: "B", reject: "A" } },
          },
        },
        {
          name: "B",
          type: "agent" as const,
          inputs: [],
          outputs: [],
          config: { promptRef: "p", reads: [] },
        },
      ],
      wires: [
        { from: { stage: "A", port: "out" }, to: { stage: "G", port: "i" } },
      ],
    };
    const submit = svc.submit(ir, { prompts: { p: "dummy" } });
    if (!submit.ok) throw new Error("submit failed");

    // Open a running stage_attempt for G so createGate has an FK to reference.
    const attemptId = "attempt-g-" + taskId;
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, ?, ?, 1, ?, 'running')`,
    ).run(attemptId, taskId, submit.versionHash, "G", Date.now());

    // Open the gate — createGate assigns and returns the gateId.
    const { gateId } = svc.createGate({
      taskId,
      stageName: "G",
      attemptId,
      question: { text: "approve or reject?", options: ["approve", "reject"] },
    });

    return { db, gateId };
  }

  it("dispatches GATE_REJECTED when kernel returns kind='rejected'", async () => {
    const taskId = "t-mcp-reject-1";
    const { db, gateId } = setupRejectReadyDb(taskId);

    const captured: unknown[] = [];
    taskRegistry.register(taskId, { send: (ev: unknown) => captured.push(ev) } as never);

    try {
      const mcp = createKernelMcp(db, { surface: "external", skipTypeCheck: true });
      const tool = getTools(mcp).get("answer_gate")!;
      await tool.handler({ gateId, answer: "reject" });

      expect(captured).toHaveLength(1);
      const ev = captured[0] as Record<string, unknown>;
      expect(ev["type"]).toBe("GATE_REJECTED");
      expect(ev["gateId"]).toBe(gateId);
      expect(ev["stageName"]).toBe("G");
      expect(ev["targetStage"]).toBe("A");
      expect(Array.isArray(ev["affectedStages"])).toBe(true);
      expect(new Set(ev["affectedStages"] as string[])).toEqual(new Set(["A", "G"]));
    } finally {
      db.close();
    }
  });

  it("dispatches GATE_ANSWERED when kernel returns kind='answered'", async () => {
    const taskId = "t-mcp-reject-2";
    const { db, gateId } = setupRejectReadyDb(taskId);

    const captured: unknown[] = [];
    taskRegistry.register(taskId, { send: (ev: unknown) => captured.push(ev) } as never);

    try {
      const mcp = createKernelMcp(db, { surface: "external", skipTypeCheck: true });
      const tool = getTools(mcp).get("answer_gate")!;
      await tool.handler({ gateId, answer: "approve" });

      expect(captured).toHaveLength(1);
      const ev = captured[0] as Record<string, unknown>;
      expect(ev["type"]).toBe("GATE_ANSWERED");
    } finally {
      db.close();
    }
  });
});
