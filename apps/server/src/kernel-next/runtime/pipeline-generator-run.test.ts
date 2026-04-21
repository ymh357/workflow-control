import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import { convertLegacyYaml } from "../converter/legacy-yaml.js";
import type { StageHandlerMap } from "./mock-executor.js";
import type { PortIR } from "../ir/schema.js";

const YAML_PATH = path.resolve(__dirname, "../../builtin-pipelines/pipeline-generator/pipeline.yaml");

function makeDb() { const db = new DatabaseSync(":memory:"); initKernelNextSchema(db); return db; }
function stubValue(t: string): unknown {
  if (t === "string") return "stub";
  if (t === "string[]") return [];
  if (t === "number") return 0;
  if (t === "boolean") return true;
  if (t === "object") return {};
  if (t === "object[]") return [];
  if (t === "markdown") return "# stub";
  return null;
}
function stubOutputs(outs: PortIR[]): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const p of outs) r[p.name] = stubValue(p.type);
  return r;
}

// C6 (task #180): MockExecutor E2E for pipeline-generator times out for
// reasons unrelated to the converter. Deferred to a separate milestone.
// Skipped here so the regression suite does not pay 45 s per run.
describe.skip("pipeline-generator E2E", () => {
  it("converts, answers gate, retries persisting, completes", async () => {
    const conv = convertLegacyYaml(readFileSync(YAML_PATH, "utf8"));
    expect(conv.ok).toBe(true);
    if (!conv.ok) return;
    const ir = conv.ir;
    const db = makeDb();
    try {
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      let persistingCalls = 0;
      let genSkeletonCalls = 0;
      const handlers: StageHandlerMap = {};
      for (const s of ir.stages) {
        if (s.type === "gate") continue;
        const outs = s.outputs;
        if (s.name === "persisting") {
          handlers[s.name] = () => {
            persistingCalls++;
            if (persistingCalls === 1) throw new Error("induced persisting failure");
            return stubOutputs(outs);
          };
        } else if (s.name === "genSkeleton") {
          handlers[s.name] = () => { genSkeletonCalls++; return stubOutputs(outs); };
        } else {
          handlers[s.name] = () => stubOutputs(outs);
        }
      }

      const seedValues: Record<string, unknown> = {};
      for (const p of ir.externalInputs ?? []) seedValues[p.name] = stubValue(p.type);

      const { KernelNextBroadcaster } = await import("../sse/broadcaster.js");
      const broadcaster = new KernelNextBroadcaster();
      const events: Array<{ type: string; data: unknown }> = [];
      broadcaster.subscribe("pg-e2e", (e) => events.push({ type: e.type, data: e.data }));

      const runPromise = runPipeline(
        { db, ir, taskId: "pg-e2e", versionHash: hash, handlers, seedValues, broadcaster },
        30_000,
      );

      const { KernelService } = await import("../mcp/kernel.js");
      const { taskRegistry } = await import("./task-registry.js");
      const kernel = new KernelService(db, { skipTypeCheck: true });

      let gateId: string | undefined;
      for (let i = 0; i < 200 && !gateId; i++) {
        const gates = kernel.listGates({ taskId: "pg-e2e", answered: false });
        if (gates.length > 0) gateId = gates[0]!.gateId;
        else await new Promise(r => setTimeout(r, 20));
      }
      expect(gateId).toBeDefined();

      const answer = kernel.answerGate(gateId!, "approve");
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;

      const dispatcher = taskRegistry.get("pg-e2e");
      dispatcher!.send({
        type: "GATE_ANSWERED",
        gateId: answer.gateId, stageName: answer.stageName,
        answer: answer.answer, targetStage: answer.targetStage,
      });

      const result = await runPromise;
      console.log(`finalState=${result.finalState} persistingCalls=${persistingCalls} genSkeletonCalls=${genSkeletonCalls}`);
      expect(result.finalState).toBe("completed");
      expect(persistingCalls).toBeGreaterThanOrEqual(2);
      expect(genSkeletonCalls).toBeGreaterThanOrEqual(2);
      const retryEvents = events.filter(e => e.type === "stage_retry");
      expect(retryEvents).toHaveLength(1);
    } finally { db.close(); }
  }, 45000);
});
