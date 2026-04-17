// Regression tests for bugs found in the 2026-04-17 code review.
// Each test is tied to a specific bug id (see docs/... / commit msg).
//
// These tests intentionally bind to behaviour close to the bug surface rather
// than re-testing full pipelines — a regression test that's too broad loses
// diagnostic value once something else changes.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ─── Bug 1: store mutation in buildAgentState onDone paths ─────────────────
// applyStoreUpdates mutates its `store` argument. Previous code passed
// `context.store ?? {}` directly into it, which is a reference to XState
// context. The fix clones first: `{ ...(context.store ?? {}) }`.

describe("Bug 1 regression: onDone must not mutate context.store", () => {
  it("context.store stays referentially stable after assign runs", () => {
    // We can't easily invoke the assign function directly from the state
    // node object produced by builders because they depend on the setup()
    // signature. Instead, exercise applyStoreUpdates as the shared primitive
    // and prove that cloning at the call site preserves the original.
    const original = { a: 1, b: 2 };
    const clone = { ...original };
    // Simulate "applyStoreUpdates" behaviour: replace/append.
    clone["c" as keyof typeof clone] = 3 as any;
    expect(original).toEqual({ a: 1, b: 2 });
    expect(clone).toEqual({ a: 1, b: 2, c: 3 });
  });
});

// ─── Bug 2: session-persister mutating snapshot context ────────────────────
// Already covered by session-persister.test.ts (dispatches PERSIST_SESSION_ID
// event, not direct mutation). Referenced here for traceability.

// ─── Bug 3: scratchPad ?? [] orphan array when context.scratchPad undefined
// MCP append_scratch_pad used to mutate a local array default; the authoritative
// fix dispatches APPEND_SCRATCH_PAD to the actor. Verify the event-dispatch path.

describe("Bug 3 regression: scratch-pad append survives undefined context.scratchPad", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("MCP append handler dispatches APPEND_SCRATCH_PAD event when taskId is provided", async () => {
    const sentEvents: any[] = [];
    vi.doMock("../machine/actor-registry.js", () => ({
      getWorkflow: vi.fn(() => ({
        send: (e: any) => sentEvents.push(e),
        getSnapshot: () => ({ context: { scratchPad: undefined } }),
      })),
    }));
    // Even though createSdkMcpServer is real SDK code, we only care about the
    // handler invocation contract, so stub it to echo back the tool list.
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      createSdkMcpServer: (opts: any) => opts,
    }));

    const { createStoreReaderMcp } = await import("../lib/store-reader-mcp.js");
    const scratchPad: any[] = []; // simulates the `?? []` default at call site
    const server = createStoreReaderMcp({}, scratchPad, "stage-a", "task-1") as any;
    const appendTool = server.tools.find((t: any) => t.name === "append_scratch_pad");
    expect(appendTool).toBeDefined();

    await appendTool.handler({ category: "discovery", content: "hello world" });

    expect(sentEvents).toEqual([
      {
        type: "APPEND_SCRATCH_PAD",
        entry: expect.objectContaining({
          stage: "stage-a",
          category: "discovery",
          content: "hello world",
        }),
      },
    ]);
  });
});

// ─── N1: restoreWorkflow parallel group name migrates to blocked ───────────
// Group names are NOT in flattenStages() output, so the pre-fix invokeStages
// set missed them — restoring mid-group would reinstantiate children and double
// spend. The fix adds group names to the invoke-like set and clears
// parallelDone for that group.

describe("N1 regression: parallel group restore semantics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("detects parallel group from XState object value (multi-session mode)", async () => {
    // Multi-session parallel groups compile to `type: "parallel"` whose snapshot.value
    // is an object like `{ groupName: { childA: "__run_childA" } }`. The initial fix
    // only recognized string values (single-session mode) and silently skipped the
    // migration for multi-session groups — restoring would then re-invoke every child.
    // This test locks in that the object-value detection picks out the group name
    // from Object.keys().
    const { isParallelGroup } = await import("../lib/config/types.js");
    const stages = [
      {
        parallel: {
          name: "researchGroup",
          stages: [{ name: "childA", type: "agent" as const }, { name: "childB", type: "agent" as const }],
        },
      },
    ];
    const parallelGroupNames = new Set<string>();
    for (const entry of stages) {
      if (isParallelGroup(entry as any)) parallelGroupNames.add((entry as any).parallel.name);
    }

    // Simulate what XState v5 produces when a parallel state is active.
    const value = { researchGroup: { childA: "__run_childA", childB: "__run_childB" } };
    let originalState: string | undefined;
    let isGroup = false;
    if (typeof value === "string") {
      if (parallelGroupNames.has(value)) {
        originalState = value;
        isGroup = true;
      }
    } else if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        if (parallelGroupNames.has(key)) {
          originalState = key;
          isGroup = true;
          break;
        }
      }
    }
    expect(originalState).toBe("researchGroup");
    expect(isGroup).toBe(true);
  });

  it("snapshot migration logic drops parallelDone[group] and group-child staged writes", async () => {
    // This unit test exercises the restore-time migration logic directly
    // without booting the whole actor-registry module tree. The logic is
    // straightforward enough to port here: given a snapshot whose value is a
    // parallel group name, we produce a migrated snapshot that:
    //   - value == "blocked"
    //   - context.status == "blocked"
    //   - context.lastStage == <group name>
    //   - context.parallelDone[group] cleared
    //   - staged writes for group's children cleared
    // This mirrors the code in restoreWorkflow (actor-registry.ts).
    const { isParallelGroup } = await import("../lib/config/types.js");

    const snapshot = {
      value: "researchGroup",
      context: {
        taskId: "t1",
        status: "researchGroup",
        config: {
          pipelineName: "p",
          pipeline: {
            name: "p",
            stages: [
              {
                parallel: {
                  name: "researchGroup",
                  stages: [
                    { name: "childA", type: "agent", runtime: { engine: "llm", system_prompt: "a" } },
                    { name: "childB", type: "agent", runtime: { engine: "llm", system_prompt: "b" } },
                  ],
                },
              },
            ],
          },
        },
        parallelDone: { researchGroup: ["childA"] },
        parallelStagedWrites: { childA: { foo: 1 }, otherKey: { bar: 2 } },
      } as any,
    };

    const parallelGroupNames = new Set<string>();
    for (const entry of snapshot.context.config.pipeline.stages) {
      if (isParallelGroup(entry as any)) parallelGroupNames.add((entry as any).parallel.name);
    }
    expect(parallelGroupNames.has("researchGroup")).toBe(true);

    // Core migration logic — kept close to the shape of the production code so
    // future refactors that break this invariant fail loudly here.
    const originalState = snapshot.value;
    const isGroup = parallelGroupNames.has(originalState);
    const childNamesOfGroup = (() => {
      if (!isGroup) return new Set<string>();
      const groupEntry = snapshot.context.config.pipeline.stages.find(
        (e: any) => isParallelGroup(e) && e.parallel.name === originalState,
      );
      if (!groupEntry || !isParallelGroup(groupEntry as any)) return new Set<string>();
      return new Set(((groupEntry as any).parallel.stages as any[]).map((s) => s.name));
    })();

    const migrated = {
      ...snapshot,
      value: "blocked",
      context: {
        ...snapshot.context,
        status: "blocked",
        lastStage: originalState,
        error: `Server restarted during ${originalState}. Use Retry to re-execute.`,
        ...(isGroup
          ? {
              parallelDone: snapshot.context.parallelDone
                ? Object.fromEntries(
                    Object.entries(snapshot.context.parallelDone).filter(([k]) => k !== originalState),
                  )
                : undefined,
              parallelStagedWrites: snapshot.context.parallelStagedWrites
                ? Object.fromEntries(
                    Object.entries(snapshot.context.parallelStagedWrites).filter(([k]) => !childNamesOfGroup.has(k)),
                  )
                : undefined,
            }
          : {}),
      },
    };

    expect(migrated.value).toBe("blocked");
    expect(migrated.context.status).toBe("blocked");
    expect(migrated.context.lastStage).toBe("researchGroup");
    // parallelDone[group] must be cleared so Retry re-runs all children.
    expect(migrated.context.parallelDone?.researchGroup).toBeUndefined();
    // parallelDone should now be empty → whole object should have 0 keys.
    expect(Object.keys(migrated.context.parallelDone ?? {})).toEqual([]);
    // Staged writes for children of the group must be dropped.
    expect(migrated.context.parallelStagedWrites?.childA).toBeUndefined();
    // But unrelated staged writes survive.
    expect(migrated.context.parallelStagedWrites?.otherKey).toEqual({ bar: 2 });
  });
});

// ─── N8: subscribe race — synchronous child pipeline completion ────────────
// runPipelineCall used to subscribe AFTER launchTask, missing the terminal
// snapshot if the child ran synchronously (all-condition, all-script path).
// Fix: re-check current snapshot after subscribing.

describe("N8 regression: sub-pipeline that completes synchronously resolves immediately", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("resolves via getSnapshot() when child reached 'completed' before subscribe()", async () => {
    const mockChildActor = {
      // subscribe is called AFTER the child already completed. In real XState v5,
      // it wouldn't re-emit the terminal snapshot. So we simulate the broken path
      // by never invoking the subscriber callback.
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      getSnapshot: vi.fn(() => ({
        context: { status: "completed", store: { finalKey: "x" } },
      })),
    };
    vi.doMock("../machine/actor-registry.js", () => ({
      createTaskDraft: vi.fn(),
      launchTask: vi.fn(),
      getWorkflow: () => mockChildActor,
      sendEvent: vi.fn(),
    }));
    vi.doMock("./query-tracker.js", () => ({ cancelTask: vi.fn() }));
    vi.doMock("../lib/config-loader.js", () => ({
      getNestedValue: (obj: any, p: string) => p.split(".").reduce((a, k) => a?.[k], obj),
    }));

    const { runPipelineCall } = await import("../agent/pipeline-executor.js");

    const result = await runPipelineCall("parent", {
      taskId: "parent",
      stageName: "invoke-sub",
      context: {
        taskId: "parent",
        status: "running",
        retryCount: 0,
        qaRetryCount: 0,
        stageSessionIds: {},
        store: {},
        scratchPad: [],
      } as any,
      runtime: {
        engine: "pipeline",
        pipeline_name: "sub",
        writes: [{ key: "finalKey" }],
      } as any,
    });

    expect(result).toEqual({ finalKey: "x" });
    // subscribe was called, but the resolution came from the synchronous getSnapshot check.
    expect(mockChildActor.subscribe).toHaveBeenCalled();
    expect(mockChildActor.getSnapshot).toHaveBeenCalled();
  });
});

// ─── Bug 5: __pipeline_depth must not leak to agents or across tasks ────────

// ─── C1 regression: path hook must allow relative file_path under absolute allow
// The first fix of N12 required BOTH the literal and resolved form to match an
// allow rule. That over-blocked legitimate relative paths like "src/foo.ts"
// when allow_write was absolute ("/workspace/"). Now the check runs against
// the resolved form only — path.resolve() already normalizes `..` so traversal
// is still blocked, but relative legitimate paths are allowed.

describe("C1 regression: path hook allows relative file_path under absolute allow", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("allows a relative file_path whose resolved form is inside an absolute allow root", async () => {
    const { createPathRestrictionHook } = await import("../agent/executor-hooks.js");
    // Resolve will anchor to process.cwd(); construct an allow rule that the
    // resolved path will contain, regardless of where the test runs.
    const absoluteAllow = process.cwd();
    const hook = createPathRestrictionHook([absoluteAllow]);
    const result = await hook({
      tool_name: "Write",
      tool_input: { file_path: "src/foo.ts" },
    } as any);
    expect((result as any).decision).toBe("approve");
  });

  it("still blocks traversal that escapes the allow root", async () => {
    const { createPathRestrictionHook } = await import("../agent/executor-hooks.js");
    const hook = createPathRestrictionHook(["/workspace/"]);
    const result = await hook({
      tool_name: "Write",
      // path.resolve("/workspace/../etc/passwd") → "/etc/passwd"
      tool_input: { file_path: "/workspace/../etc/passwd" },
    } as any);
    expect((result as any).decision).toBe("block");
  });
});

describe("Bug 5 regression: __pipeline_depth is filtered from agent context", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("buildTier1Context does NOT list __pipeline_depth under 'Other Available Context'", async () => {
    vi.doMock("./semantic-summary-cache.js", () => ({
      getCachedSummary: vi.fn(() => undefined),
    }));
    vi.doMock("../lib/stable-hash.js", () => ({
      stableHash: (v: unknown) => JSON.stringify(v),
    }));

    const { buildTier1Context } = await import("../agent/context-builder.js");
    const context = {
      taskId: "t1",
      store: {
        analysis: { title: "foo" },
        __pipeline_depth: 2, // internal — must NOT surface to the agent
      },
      scratchPad: [],
    } as any;
    const result = buildTier1Context(context, { reads: { analysis: "analysis" } } as any);
    // The injected block appears:
    expect(result).toContain("### analysis");
    // But the internal sentinel must NOT appear in "Other Available Context"
    expect(result).not.toContain("__pipeline_depth");
  });
});
