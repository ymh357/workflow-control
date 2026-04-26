// F19: orchestrateFanoutStage must surface secret_pending from per-element
// executor results upward as a FanoutResult of kind secret_pending, instead
// of swallowing it as an implicit success. Pre-fix the orchestrator only
// branched on `error`; secret_pending was treated like success and the
// post-loop aggregator read no port writes (the element's executor never
// produced any), filling the aggregate with `undefined` per port.
//
// This test isolates orchestrateFanoutStage with a stub executor that
// returns secret_pending for one element. Asserts the orchestrator returns
// status=secret_pending and the missing-keys list, with no aggregation
// attempt opened on the live port runtime.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { orchestrateFanoutStage } from "./runner-fanout.js";
import { PortRuntime } from "./port-runtime.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageExecutor, ExecuteStageArgs, ExecuteStageResult } from "./executor.js";
import { createActor, fromCallback } from "xstate";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

// Minimal stub dispatcher — orchestrateFanoutStage doesn't dispatch
// anything itself (the live runtime's hooks may, but we stub them out).
const stubDispatcher = createActor(fromCallback(() => {})).start();

class StubExecutor implements StageExecutor {
  constructor(private readonly perElement: (idx: number) => ExecuteStageResult) {}

  async executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
    const idx = args.fanoutElementIdx ?? -1;
    const result = this.perElement(idx);
    // Open a real attempt row so attemptId is valid for downstream
    // readWritesForAttempt — even though we never write any ports for
    // a secret_pending element.
    const { attemptId } = args.portRuntime.startAttempt({
      taskId: args.taskId,
      versionHash: args.versionHash,
      stageName: args.stageName,
      kind: idx >= 0 ? "fanout_element" : "regular",
      fanoutElementIdx: idx >= 0 ? idx : undefined,
      suppressHooks: true,
    });
    if (result.status === "success") {
      args.portRuntime.finishAttempt(attemptId, "success");
    } else if (result.status === "error") {
      args.portRuntime.finishAttempt(attemptId, "error", result.error, { silent: true });
    } else {
      args.portRuntime.finishAttempt(attemptId, "secret_pending", undefined, { silent: true });
    }
    return { ...result, attemptId, attemptIdx: 0 } as ExecuteStageResult;
  }
}

function fanoutIR(): PipelineIR {
  return {
    name: "fanout-secret-pending",
    externalInputs: [{ name: "items", type: "number[]" }],
    stages: [
      {
        name: "F",
        type: "agent",
        fanout: { input: "item" },
        inputs: [{ name: "item", type: "number" }],
        outputs: [{ name: "doubled", type: "number" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { source: "external", port: "items" }, to: { stage: "F", port: "item" } },
    ],
  };
}

describe("F19: orchestrateFanoutStage handles per-element secret_pending", () => {
  it("returns FanoutResult.secret_pending when ANY element pauses on missing envKeys", async () => {
    const db = makeDb();
    const ir = fanoutIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const taskId = "t-fanout-sp";
    const livePortRuntime = new PortRuntime(db, stubDispatcher);

    // Element 1 of 3 returns secret_pending; the others succeed.
    // The orchestrator should NOT proceed to aggregate — it should
    // return secret_pending immediately after the pool drains.
    const executor = new StubExecutor((idx) => {
      if (idx === 1) {
        return {
          attemptId: "x",
          attemptIdx: 0,
          status: "secret_pending",
          missingKeys: ["GITHUB_TOKEN", "OTHER_KEY"],
        };
      }
      return { attemptId: "x", attemptIdx: 0, status: "success" };
    });

    const result = await orchestrateFanoutStage({
      ir,
      stageDef: ir.stages[0]! as Parameters<typeof orchestrateFanoutStage>[0]["stageDef"],
      taskId,
      versionHash: hash,
      basePortValues: { "__external__.items": [10, 20, 30] }, // input array
      handlers: {},
      db,
      livePortRuntime,
      executor,
    });

    expect(result.status).toBe("secret_pending");
    if (result.status !== "secret_pending") return;
    // missingKeys deduplicated + sorted
    expect(result.missingKeys).toEqual(["GITHUB_TOKEN", "OTHER_KEY"]);

    // No fanout_aggregate attempt was created — orchestrator returned
    // before the aggregate-write block.
    const aggregateRows = db.prepare(
      `SELECT COUNT(*) as n FROM stage_attempts WHERE task_id = ? AND kind = 'fanout_aggregate'`,
    ).get(taskId) as { n: number };
    expect(aggregateRows.n).toBe(0);
  });

  it("collects missingKeys from MULTIPLE elements (deduplicated, sorted)", async () => {
    const db = makeDb();
    const ir = fanoutIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const taskId = "t-fanout-sp-multi";
    const livePortRuntime = new PortRuntime(db, stubDispatcher);

    // Two different elements report different (overlapping) missing-key
    // sets. The orchestrator's union must dedupe and sort.
    const executor = new StubExecutor((idx) => {
      if (idx === 0) {
        return {
          attemptId: "x",
          attemptIdx: 0,
          status: "secret_pending",
          missingKeys: ["B_KEY", "A_KEY"],
        };
      }
      if (idx === 1) {
        return {
          attemptId: "x",
          attemptIdx: 0,
          status: "secret_pending",
          missingKeys: ["A_KEY", "C_KEY"],
        };
      }
      return { attemptId: "x", attemptIdx: 0, status: "success" };
    });

    const result = await orchestrateFanoutStage({
      ir,
      stageDef: ir.stages[0]! as Parameters<typeof orchestrateFanoutStage>[0]["stageDef"],
      taskId,
      versionHash: hash,
      basePortValues: { "__external__.items": [1, 2, 3] },
      handlers: {},
      db,
      livePortRuntime,
      executor,
    });

    expect(result.status).toBe("secret_pending");
    if (result.status !== "secret_pending") return;
    expect(result.missingKeys).toEqual(["A_KEY", "B_KEY", "C_KEY"]);
  });
});
