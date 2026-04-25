// A2.2 — RealStageExecutor driven by AgentMachine (no real SDK).
//
// We inject a fake `queryFn` that yields a synthetic SDK message stream.
// Port writes happen in the fake (standing in for what the real MCP
// write_port handler would do during tool_use). These tests verify:
//   - Success path: adapter → AgentMachine → done → executor records
//     success + returns status 'success'.
//   - Error path: RESULT_ERROR surfaces as stage_attempt status='error'
//     with the SDK diagnostic message threaded through.
//   - Schema compliance still fails the stage when a declared output
//     port is never written, even if the SDK returns RESULT_SUCCESS.
//
// No subprocess, no CLI, no network.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { RealStageExecutor } from "./real-executor.js";
import { PortRuntime } from "./port-runtime.js";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import type { PipelineIR } from "../ir/schema.js";
import { DbPromptResolver } from "./db-prompt-resolver.js";
import { KernelService } from "../mcp/kernel.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function oneStageIR(): PipelineIR {
  return {
    name: "one-agent",
    stages: [
      {
        name: "S",
        type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "do stuff" },
      },
    ],
    wires: [],
  };
}

// Factory for an SDK-like message async iterable. Ports are written via
// the provided writeCb (stand-in for MCP write_port handler).
function makeFakeStream(
  subtype: "success" | "error_max_turns",
  opts: { writePorts?: () => void; errorMessage?: string } = {},
) {
  async function* gen() {
    yield { type: "system", subtype: "init", uuid: "u0", session_id: "s" };
    yield {
      type: "assistant",
      message: { content: [{ type: "thinking" }] },
      session_id: "s",
    };
    yield {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "w1", name: "write_port", input: {} }] },
      session_id: "s",
    };
    // Simulate MCP handler side-effect mid-tool.
    opts.writePorts?.();
    yield {
      type: "user",
      message: { content: [{ type: "tool_result", id: "w1", content: "ok" }] },
      session_id: "s",
    };
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
      session_id: "s",
    };
    if (subtype === "success") {
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.005,
        num_turns: 3,
        session_id: "s",
      };
    } else {
      yield {
        type: "result",
        subtype,
        error_message: opts.errorMessage ?? "turns exhausted",
        session_id: "s",
      };
    }
  }
  // Match the SDK's Query shape loosely — cast through unknown.
  return gen() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
}

describe("RealStageExecutor — AgentMachine-driven (A2.2)", () => {
  it("success: RESULT_SUCCESS + declared port written → stage returns status=success", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    // Inert dispatcher (no machine listening).
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    let writeSideEffect: (() => void) | null = null;
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_args: any) => makeFakeStream("success", {
        writePorts: () => writeSideEffect?.(),
      })) as never,
    });

    // Hook: once startAttempt runs inside executeStage, we'll need the
    // attemptId to write the port. Do this by patching writeSideEffect
    // right before invocation, reading attemptId from the most-recent row.
    writeSideEffect = () => {
      const row = db.prepare(
        `SELECT attempt_id FROM stage_attempts WHERE stage_name = 'S' ORDER BY attempt_idx DESC LIMIT 1`,
      ).get() as { attempt_id: string } | undefined;
      if (!row) return;
      portRuntime.writePort({
        attemptId: row.attempt_id,
        stageName: "S",
        portName: "x",
        value: 42,
      });
    };

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t1", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toBe("success");
    const row = db.prepare(
      `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
    ).get(result.attemptId) as { status: string };
    expect(row.status).toBe("success");
    db.close();
  });

  it("error: RESULT_ERROR surfaces as stage error with diagnostic message", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_args: any) => makeFakeStream("error_max_turns", {
        errorMessage: "turn cap hit",
      })) as never,
    });

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t1", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("turn cap hit");
    db.close();
  });

  it("success but port missing → schema non-compliance error", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // No writePorts callback — agent "finished" without producing x.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_args: any) => makeFakeStream("success")) as never,
    });

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t1", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/schema non-compliant.*'x'/);
    db.close();
  });
});

// A2.3.3 — external INTERRUPT via AbortSignal. The TaskMachine wires
// INTERRUPT{stage} to a fromCallback child, which aborts the signal we
// pass here. RealStageExecutor must translate that abort into an
// INTERRUPT event for the nested AgentMachine so the §4.2 matrix runs.
describe("RealStageExecutor — AbortSignal INTERRUPT bridge (A2.3.3)", () => {
  // Stream that pauses after init and only resumes when a gate is
  // released. Lets the test fire abort() while the AgentMachine is
  // parked in `waiting_for_claude`.
  function makePausableStream(gate: Promise<"success" | "no-more">) {
    async function* gen() {
      yield { type: "system", subtype: "init", uuid: "u0", session_id: "s" };
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "thinking..." }] },
        session_id: "s",
      };
      // Await external signal — after abort landed on agentActor (via the
      // signal bridge), sending RESULT_SUCCESS now should still produce
      // status='done' per §4.2: RESULT_SUCCESS in waiting_for_claude wins
      // even after INTERRUPT armed, because the machine hasn't re-entered
      // waiting yet (no tool loop between).
      const resume = await gate;
      if (resume === "success") {
        yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" };
      } else {
        // Force timeout on summary turn: emit RESULT_ERROR instead so the
        // §4.2 matrix yields status='interrupted' via the error path
        // (summary turn failed).
        yield { type: "result", subtype: "error_max_turns", error_message: "timeout after interrupt", session_id: "s" };
      }
    }
    return gen() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
  }

  it("abort + clean RESULT_SUCCESS still lands as success (§4.2 summary-turn-wins)", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    let gateResolve!: (v: "success" | "no-more") => void;
    const gate = new Promise<"success" | "no-more">((resolve) => {
      gateResolve = resolve;
    });

    const ac = new AbortController();
    // Fire abort on the next tick after starting executeStage. The stream
    // is paused at `await gate` so abort lands during waiting_for_claude.
    setTimeout(() => {
      ac.abort();
      // Then resume with success — armed INTERRUPT is still in waiting,
      // has not consumed summary-turn slot, RESULT_SUCCESS wins.
      gateResolve("success");
    }, 10);

    let writeSideEffect: (() => void) | null = null;
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_args: any) => makePausableStream(gate)) as never,
    });
    // Port write must happen for schema compliance; hook it to fire
    // before RESULT arrives (i.e. before gate resolves). Simplest: fire
    // once gate resolves with 'success' — we know the stream only emits
    // the result after the gate, so port MUST be written beforehand by
    // a separate side-effect path. Here the mock agent has no tool_use,
    // so the stage will fail schema check UNLESS we write port manually.
    writeSideEffect = () => {
      const row = db.prepare(
        `SELECT attempt_id FROM stage_attempts WHERE stage_name = 'S' ORDER BY attempt_idx DESC LIMIT 1`,
      ).get() as { attempt_id: string } | undefined;
      if (!row) return;
      portRuntime.writePort({
        attemptId: row.attempt_id, stageName: "S", portName: "x", value: 42,
      });
    };
    // Fire port write just before resolving the gate with success.
    setTimeout(() => writeSideEffect?.(), 5);

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t-int", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime, signal: ac.signal,
    });

    // The test's primary invariant: executeStage returns without hanging
    // AND the abort was delivered to the AgentMachine (agentActor
    // received INTERRUPT). Status is success here because summary-turn
    // (§4.2) produced RESULT_SUCCESS before any re-entry to waiting.
    expect(result.status).toBe("success");
    db.close();
  });

  it("pre-aborted signal still completes without hanging", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    const ac = new AbortController();
    ac.abort(); // Already aborted before executeStage runs.

    // Use a normal fake stream: success path with port write.
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_args: any) => makeFakeStream("success", {
        writePorts: () => {
          const row = db.prepare(
            `SELECT attempt_id FROM stage_attempts WHERE stage_name = 'S' ORDER BY attempt_idx DESC LIMIT 1`,
          ).get() as { attempt_id: string } | undefined;
          if (!row) return;
          portRuntime.writePort({
            attemptId: row.attempt_id, stageName: "S", portName: "x", value: 99,
          });
        },
      })) as never,
    });

    const result = await executor.executeStage({
      ir, stageName: "S", taskId: "t-preint", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime, signal: ac.signal,
    });

    // Pre-aborted signal sends INTERRUPT before SDK_INIT — §4.2 says this
    // finalises as 'interrupted' from 'starting'. The stage returns error
    // with a diagnostic message.
    expect(result.status).toBe("error");
    expect(result.error).toContain("interrupted");
    db.close();
  });
});

describe("RealStageExecutor subAgents pass-through", () => {
  it("passes stage.config.subAgents into SDK options.agents", async () => {
    const db = makeDb();
    // Build an IR with an agent stage that declares one sub-agent.
    const ir: PipelineIR = {
      name: "sub-agent-test",
      stages: [
        {
          name: "S",
          type: "agent",
          inputs: [],
          outputs: [],
          config: {
            promptRef: "do stuff",
            subAgents: [
              {
                name: "writer",
                description: "Writes prompts",
                prompt: "You are a writer",
                tools: ["Read", "Write"],
                model: "sonnet" as const,
                maxTurns: 20,
              },
            ],
          },
        },
      ],
      wires: [],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    // Capture the options the SDK query was called with.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturedOptions: any[] = [];
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        capturedOptions.push(args.options);
        // Use the shared makeFakeStream("error_max_turns", ...) helper so
        // the executor's AgentMachine reaches `done` cleanly instead of
        // waiting out the 5s waitFor timeout on a single-message stream.
        return makeFakeStream("error_max_turns", { errorMessage: "test short-circuit" });
      }) as never,
    });

    await executor.executeStage({
      ir, stageName: "S", taskId: "t-sa", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].agents).toEqual({
      writer: {
        description: "Writes prompts",
        prompt: "You are a writer",
        tools: ["Read", "Write"],
        model: "sonnet",
        maxTurns: 20,
      },
    });
    db.close();
  });

  it("omits options.agents when subAgents is absent", async () => {
    const db = makeDb();
    const ir = oneStageIR(); // no subAgents
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturedOptions: any[] = [];
    let writeSideEffect: (() => void) | null = null;
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        capturedOptions.push(args.options);
        return makeFakeStream("success", { writePorts: () => writeSideEffect?.() });
      }) as never,
    });

    // Write the declared output port so schema check passes.
    writeSideEffect = () => {
      const row = db.prepare(
        `SELECT attempt_id FROM stage_attempts WHERE stage_name = 'S' ORDER BY attempt_idx DESC LIMIT 1`,
      ).get() as { attempt_id: string } | undefined;
      if (!row) return;
      portRuntime.writePort({
        attemptId: row.attempt_id, stageName: "S", portName: "x", value: 0,
      });
    };

    await executor.executeStage({
      ir, stageName: "S", taskId: "t-no-sa", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].agents).toBeUndefined();
    db.close();
  });
});

// F3 — per-task workspace cwd. agent SDK default cwd is process.cwd()
// (the server's launch dir), which has historically caused agents to
// write files into the repo root when prompts use relative paths
// (P6-3). RealStageExecutor now accepts an optional workspaceDir option
// and forwards it as SDK options.cwd so each task runs in its own
// sandbox when the caller supplies one.
describe("RealStageExecutor workspaceDir (F3)", () => {
  it("passes workspaceDir to SDK options.cwd when provided", async () => {
    const db = makeDb();
    // Empty-outputs fixture lets us short-circuit with error_max_turns
    // and skip port writes — we only care about the captured SDK options.
    const ir: PipelineIR = {
      name: "f3-cwd-set",
      // Placate EMPTY_DATAFLOW validator: any external input declaration
      // flips hasExternals=true without wiring requirements.
      externalInputs: [{ name: "unused", type: "unknown" }],
      stages: [{ name: "S", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } }],
      wires: [],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturedOptions: any[] = [];
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      workspaceDir: "/tmp/f3-workspace",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        capturedOptions.push(args.options);
        return makeFakeStream("error_max_turns");
      }) as never,
    });

    await executor.executeStage({
      ir, stageName: "S", taskId: "t-f3", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].cwd).toBe("/tmp/f3-workspace");
    db.close();
  });

  it("omits options.cwd when workspaceDir is not provided (SDK default stays)", async () => {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "f3-cwd-absent",
      externalInputs: [{ name: "unused", type: "unknown" }],
      stages: [{ name: "S", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } }],
      wires: [],
    };
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturedOptions: any[] = [];
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // no workspaceDir
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        capturedOptions.push(args.options);
        return makeFakeStream("error_max_turns");
      }) as never,
    });

    await executor.executeStage({
      ir, stageName: "S", taskId: "t-f3n", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].cwd).toBeUndefined();
    db.close();
  });
});

// Stage 6 — execution-record sidecar integration. Every agent-stage
// attempt writes exactly one agent_execution_details row populated
// with prompt context + lifecycle metadata.
describe("RealStageExecutor sidecar integration", () => {
  it("writes an agent_execution_details row per attempt with populated prompt content", async () => {
    const db = makeDb();

    // Seed a pipeline with the DbPromptResolver path (the one used in
    // production). KernelService.submit persists pipeline_versions +
    // prompt_contents + pipeline_prompt_refs for the resolver to look
    // up. skipTypeCheck avoids spawning tsc in the test harness.
    // P6-8: validator now rejects fully empty-shell pipelines. Declare
    // a dummy externalInput (not wired anywhere) so hasExternals is
    // true; EMPTY_DATAFLOW then doesn't fire. The stage still has
    // inputs=[] outputs=[] so the fake handler that produces neither
    // reaches success without hitting port schema checks.
    const ir: PipelineIR = {
      name: "sidecar-p1",
      externalInputs: [{ name: "unused", type: "unknown" }],
      stages: [
        {
          name: "S",
          type: "agent",
          inputs: [],
          outputs: [],
          config: { promptRef: "p1prompt" },
        },
      ],
      wires: [],
    };
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitRes = await svc.submit(ir, { prompts: { p1prompt: "hello world" } });
    expect(submitRes.ok).toBe(true);
    if (!submitRes.ok) return;

    // Fake queryFn that emits an init + a success result with cost + usage
    // + session_id. No tool_use, no declared outputs → schema check
    // trivially passes because stage.outputs is empty.
    const queryFn = (() =>
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-test-xyz",
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "done thinking" }],
          },
          session_id: "sess-test-xyz",
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "sess-test-xyz",
          total_cost_usd: 0.0123,
          usage: { input_tokens: 17, output_tokens: 9 },
          num_turns: 1,
        };
      })()) as never;

    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      model: "claude-haiku-4-5",
      queryFn,
      promptResolver: new DbPromptResolver(db, submitRes.versionHash),
    });

    const result = await executor.executeStage({
      ir,
      stageName: "S",
      taskId: "tk-sidecar",
      versionHash: submitRes.versionHash,
      portValues: {},
      handlers: {},
      portRuntime,
    });

    expect(result.status).toBe("success");

    const row = db.prepare(
      `SELECT * FROM agent_execution_details WHERE attempt_id = ?`,
    ).get(result.attemptId) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.prompt_ref).toBe("p1prompt");
    // DbPromptResolver returns the normalized (trailing LF) content,
    // and the writer stores it as-is so the row is self-contained.
    expect(row!.prompt_content).toBe("hello world\n");
    expect(row!.model).toBe("claude-haiku-4-5");
    expect(row!.ended_at).not.toBeNull();
    expect(row!.termination_reason).toBe("natural_completion");
    expect(row!.session_id).toBe("sess-test-xyz");
    expect(Number(row!.cost_usd)).toBeCloseTo(0.0123, 4);
    expect(row!.token_input).toBe(17);
    expect(row!.token_output).toBe(9);

    const stream = JSON.parse(row!.agent_stream_json as string) as Array<{
      type: string;
      text: string;
    }>;
    // At minimum the "done thinking" text should land; the adapter may
    // also emit other items. Just assert presence.
    expect(stream.some((e) => e.type === "text" && e.text === "done thinking"))
      .toBe(true);

    db.close();
  });
});

describe("RealStageExecutor segmentContinuation (single-session mode)", () => {
  it("uses segmentContinuation.resumeSessionId for options.resume and clamps maxTurns by segment-wide priorNumTurns", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturedOptions: any[] = [];
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      maxTurns: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        capturedOptions.push(args.options);
        return makeFakeStream("error_max_turns", { errorMessage: "test short-circuit" });
      }) as never,
    });

    await executor.executeStage({
      ir, stageName: "S", taskId: "t-seg-cont", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
      segmentContinuation: {
        resumeSessionId: "seg-sess-1",
        priorNumTurns: 4,
        priorAttempts: ["a-prior"],
        isContinuationStage: true,
      },
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].resume).toBe("seg-sess-1");
    // 10 - 4 = 6
    expect(capturedOptions[0].maxTurns).toBe(6);
    db.close();
  });

  it("segmentContinuation takes precedence over args.resumeSessionId / priorNumTurns", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturedOptions: any[] = [];
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      maxTurns: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        capturedOptions.push(args.options);
        return makeFakeStream("error_max_turns", { errorMessage: "test short-circuit" });
      }) as never,
    });

    await executor.executeStage({
      ir, stageName: "S", taskId: "t-prec", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
      // M-R5 fields
      resumeSessionId: "stage-sess",
      priorNumTurns: 2,
      // Segment fields — should win
      segmentContinuation: {
        resumeSessionId: "segment-sess",
        priorNumTurns: 7,
        priorAttempts: [],
        isContinuationStage: true,
      },
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].resume).toBe("segment-sess");
    expect(capturedOptions[0].maxTurns).toBe(3); // 10 - 7
    db.close();
  });

  it("isContinuationStage=false → resumes session but renders FULL prompt form (cross-segment per spec §8.4)", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturedOptions: any[] = [];
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      maxTurns: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        capturedOptions.push(args.options);
        return makeFakeStream("error_max_turns", { errorMessage: "test short-circuit" });
      }) as never,
    });

    await executor.executeStage({
      ir, stageName: "S", taskId: "t-cross-seg", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
      segmentContinuation: {
        resumeSessionId: "prior-seg-sess",
        priorNumTurns: 0,
        priorAttempts: [],
        isContinuationStage: false,  // segment-first stage that resumes
      },
    });

    expect(capturedOptions).toHaveLength(1);
    // Resume happens regardless of prompt form.
    expect(capturedOptions[0].resume).toBe("prior-seg-sess");
    // Full prompt form: contains "Stage contract" overview block
    // (spec §4.1: this block is dropped only in continuation form).
    const sysAppend = capturedOptions[0].systemPrompt?.append ?? "";
    expect(sysAppend).toContain("Stage contract");
    db.close();
  });

  it("isContinuationStage=true → continuation prompt form (drops Stage-contract overview)", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturedOptions: any[] = [];
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      maxTurns: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        capturedOptions.push(args.options);
        return makeFakeStream("error_max_turns", { errorMessage: "test short-circuit" });
      }) as never,
    });

    await executor.executeStage({
      ir, stageName: "S", taskId: "t-in-seg", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
      segmentContinuation: {
        resumeSessionId: "in-seg-sess",
        priorNumTurns: 2,
        priorAttempts: [],
        isContinuationStage: true,  // mid-segment continuation stage
      },
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].resume).toBe("in-seg-sess");
    // Continuation form: Stage-contract block dropped (SDK already
    // saw the segment-first stage's full prompt in this same query).
    const sysAppend = capturedOptions[0].systemPrompt?.append ?? "";
    expect(sysAppend).not.toContain("Stage contract");
    db.close();
  });

  it("no segmentContinuation → behaves identically to before (no resume, no clamp)", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const portRuntime = new PortRuntime(db, { send: () => { /* inert */ } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturedOptions: any[] = [];
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      maxTurns: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((args: any) => {
        capturedOptions.push(args.options);
        return makeFakeStream("error_max_turns", { errorMessage: "test short-circuit" });
      }) as never,
    });

    await executor.executeStage({
      ir, stageName: "S", taskId: "t-fresh", versionHash: hash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].resume).toBeUndefined();
    expect(capturedOptions[0].maxTurns).toBe(10);
    db.close();
  });
});
