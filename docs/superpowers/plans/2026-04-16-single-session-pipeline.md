# Single Session Pipeline Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable pipelines to run all agent stages in a single Claude SDK session via `session_mode: "single"` in pipeline.yaml, while preserving full backward compatibility.

**Architecture:** A new `SessionManager` class manages a persistent V1 `query()` with `AsyncIterable<SDKUserMessage>` prompt. Each XState agent stage invoke routes to `SessionManager.executeStage()` instead of creating an independent query. XState retains full control of guards, retries, and transitions. The `AgentResult` shape is identical, so all existing onDone logic works unchanged.

**Tech Stack:** Claude Agent SDK V1 `query()` + `AsyncIterable`, XState, TypeScript, Vitest

---

### Task 1: Config — Add session_mode to PipelineConfig

**Files:**
- Modify: `apps/server/src/lib/config/types.ts:242-265`
- Modify: `apps/server/src/lib/config/schema.ts:283-310`
- Test: `apps/server/src/lib/config/schema.test.ts`

- [ ] **Step 1: Write failing test — session_mode validation**

In `apps/server/src/lib/config/schema.test.ts`, add:

```typescript
describe("session_mode validation", () => {
  it("accepts pipeline without session_mode (defaults to multi)", () => {
    const base = { name: "test", stages: [{ name: "s1", type: "agent", runtime: { engine: "llm", system_prompt: "test" } }] };
    const result = validatePipelineConfig(base);
    expect(result.success).toBe(true);
  });

  it("accepts session_mode: multi", () => {
    const base = { name: "test", session_mode: "multi", stages: [{ name: "s1", type: "agent", runtime: { engine: "llm", system_prompt: "test" } }] };
    const result = validatePipelineConfig(base);
    expect(result.success).toBe(true);
  });

  it("accepts session_mode: single with engine: claude", () => {
    const base = { name: "test", session_mode: "single", engine: "claude", stages: [{ name: "s1", type: "agent", runtime: { engine: "llm", system_prompt: "test" } }] };
    const result = validatePipelineConfig(base);
    expect(result.success).toBe(true);
  });

  it("rejects session_mode: single with engine: gemini", () => {
    const base = { name: "test", session_mode: "single", engine: "gemini", stages: [{ name: "s1", type: "agent", runtime: { engine: "llm", system_prompt: "test" } }] };
    const result = validatePipelineConfig(base);
    expect(result.success).toBe(false);
  });

  it("accepts session_idle_timeout_sec", () => {
    const base = { name: "test", session_mode: "single", engine: "claude", session_idle_timeout_sec: 3600, stages: [{ name: "s1", type: "agent", runtime: { engine: "llm", system_prompt: "test" } }] };
    const result = validatePipelineConfig(base);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/lib/config/schema.test.ts --reporter=verbose`
Expected: FAIL — `session_mode` not recognized by schema

- [ ] **Step 3: Add session_mode to PipelineConfig type**

In `apps/server/src/lib/config/types.ts`, add two fields after `inline_prompts`:

```typescript
export interface PipelineConfig {
  name: string;
  description?: string;
  engine?: "claude" | "gemini" | "codex" | "mixed";
  use_cases?: string[];
  default_execution_mode?: "auto" | "edge";
  official?: boolean;
  stages: PipelineStageEntry[];
  hooks?: string[];
  skills?: string[];
  claude_md?: { global?: string };
  gemini_md?: { global?: string };
  codex_md?: { global?: string };
  display?: { title_path?: string; completion_summary_path?: string };
  integrations?: { notion_page_id_path?: string };
  store_persistence?: {
    inherit_from: "last_completed" | "none";
    inherit_keys: string[] | "*";
  };
  store_schema?: StoreSchema;
  // Pipeline-level invariants applied to ALL agent stages
  invariants?: string[];
  inline_prompts?: Record<string, string>;
  session_mode?: "multi" | "single";
  session_idle_timeout_sec?: number;
}
```

- [ ] **Step 4: Add session_mode to PipelineConfigSchema**

In `apps/server/src/lib/config/schema.ts`, add to `PipelineConfigSchema` (after `inline_prompts`):

```typescript
export const PipelineConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  engine: z.enum(["claude", "gemini", "codex", "mixed"]).optional(),
  use_cases: z.array(z.string()).optional(),
  default_execution_mode: z.enum(["auto", "edge"]).optional(),
  official: z.boolean().optional(),
  stages: z.array(PipelineStageEntrySchema),
  hooks: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  claude_md: z.object({ global: z.string().optional() }).optional(),
  gemini_md: z.object({ global: z.string().optional() }).optional(),
  codex_md: z.object({ global: z.string().optional() }).optional(),
  display: z
    .object({
      title_path: z.string().optional(),
      completion_summary_path: z.string().optional(),
    })
    .optional(),
  integrations: z
    .object({
      notion_page_id_path: z.string().optional(),
    })
    .optional(),
  store_persistence: StorePersistenceSchema.optional(),
  store_schema: StoreSchemaSchema.optional(),
  inline_prompts: z.record(z.string(), z.string()).optional(),
  session_mode: z.enum(["multi", "single"]).optional(),
  session_idle_timeout_sec: z.number().positive().optional(),
}).refine(
  (data) => {
    if (data.session_mode === "single" && data.engine && data.engine !== "claude") {
      return false;
    }
    return true;
  },
  { message: "session_mode: 'single' requires engine: 'claude' (or omitted)" },
);
```

- [ ] **Step 5: Run tests**

Run: `cd apps/server && npx vitest run src/lib/config/schema.test.ts --reporter=verbose`
Expected: All pass

- [ ] **Step 6: Run type check**

Run: `cd apps/server && ./node_modules/.bin/tsc --noEmit`
Expected: Clean (only pre-existing errors)

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/lib/config/types.ts apps/server/src/lib/config/schema.ts apps/server/src/lib/config/schema.test.ts
git commit -m "feat: add session_mode and session_idle_timeout_sec to PipelineConfig"
```

---

### Task 2: AsyncQueue — Reusable async message queue

**Files:**
- Create: `apps/server/src/agent/async-queue.ts`
- Create: `apps/server/src/agent/async-queue.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/server/src/agent/async-queue.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { AsyncQueue } from "./async-queue.js";

describe("AsyncQueue", () => {
  it("yields items in order", async () => {
    const q = new AsyncQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    q.finish();

    const items: number[] = [];
    for await (const item of q) {
      items.push(item);
    }
    expect(items).toEqual([1, 2]);
  });

  it("waits for enqueue when queue is empty", async () => {
    const q = new AsyncQueue<string>();

    const promise = q[Symbol.asyncIterator]().next();
    // Queue is empty, next() is pending
    q.enqueue("hello");
    const result = await promise;
    expect(result).toEqual({ value: "hello", done: false });
  });

  it("finish signals done", async () => {
    const q = new AsyncQueue<string>();
    q.finish();

    const result = await q[Symbol.asyncIterator]().next();
    expect(result).toEqual({ value: undefined, done: true });
  });

  it("drains remaining items before done", async () => {
    const q = new AsyncQueue<number>();
    q.enqueue(10);
    q.enqueue(20);
    q.finish();

    const iter = q[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ value: 10, done: false });
    expect(await iter.next()).toEqual({ value: 20, done: false });
    expect(await iter.next()).toEqual({ value: undefined, done: true });
  });

  it("can be iterated only once", async () => {
    const q = new AsyncQueue<number>();
    q.finish();

    const iter1 = q[Symbol.asyncIterator]();
    await iter1.next(); // consume

    // Second iterator should throw
    expect(() => q[Symbol.asyncIterator]()).toThrow("already been iterated");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/agent/async-queue.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AsyncQueue**

Create `apps/server/src/agent/async-queue.ts`:

```typescript
/**
 * Simple async queue that implements AsyncIterable.
 * Items can be enqueued from producers and consumed via for-await or .next().
 * Equivalent to SDK's internal q4 class.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private isDone = false;
  private started = false;

  enqueue(item: T): void {
    if (this.isDone) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  finish(): void {
    this.isDone = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.started) throw new Error("AsyncQueue has already been iterated");
    this.started = true;

    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.isDone) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && npx vitest run src/agent/async-queue.test.ts --reporter=verbose`
Expected: All 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/async-queue.ts apps/server/src/agent/async-queue.test.ts
git commit -m "feat: add AsyncQueue for single-session message passing"
```

---

### Task 3: SessionManager — Core class with executeStage and consumeUntilResult

**Files:**
- Create: `apps/server/src/agent/session-manager.ts`
- Create: `apps/server/src/agent/session-manager.test.ts`

This is the largest task. The SessionManager is the heart of single-session mode.

- [ ] **Step 1: Write failing tests**

Create `apps/server/src/agent/session-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before imports
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../sse/manager.js", () => ({
  sseManager: { pushMessage: vi.fn() },
}));

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("./session-persister.js", () => ({
  persistSessionId: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { SessionManager, type SessionManagerConfig } from "./session-manager.js";

function makeConfig(overrides?: Partial<SessionManagerConfig>): SessionManagerConfig {
  return {
    taskId: "test-task",
    claudePath: "claude",
    idleTimeoutMs: 7200_000,
    cwd: "/tmp/test",
    ...overrides,
  };
}

// Helper: create a fake query iterator that yields messages in sequence
function createFakeQuery(messages: Array<Record<string, unknown>>) {
  let index = 0;
  const iterator = {
    next: () => {
      if (index >= messages.length) return Promise.resolve({ value: undefined, done: true });
      return Promise.resolve({ value: messages[index++], done: false });
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
    throw: (e: unknown) => Promise.reject(e),
  };
  const q = {
    [Symbol.asyncIterator]: () => iterator,
    setModel: vi.fn().mockResolvedValue(undefined),
    setMcpServers: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    sessionId: "fake-session-123",
  };
  return q;
}

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates query on first executeStage and returns AgentResult", async () => {
    const fakeQ = createFakeQuery([
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "assistant", message: { content: [{ type: "text", text: '{"analysis": {"summary": "ok"}}' }] }, session_id: "sess-1" },
      { type: "result", subtype: "success", result: '{"analysis": {"summary": "ok"}}', total_cost_usd: 0.05, duration_ms: 1000, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, session_id: "sess-1" },
    ]);
    vi.mocked(query).mockReturnValue(fakeQ as any);

    const mgr = new SessionManager(makeConfig());
    const result = await mgr.executeStage({
      taskId: "test-task",
      stageName: "analyzing",
      tier1Context: "Task: do something",
      stagePrompt: "Analyze the task",
      stageConfig: { model: "claude-sonnet-4-6", mcpServices: [], permissionMode: "bypassPermissions", maxTurns: 30, maxBudgetUsd: 2, thinking: { type: "disabled" } },
      worktreePath: "/tmp/test",
      interactive: false,
      runtime: { engine: "llm" as const, system_prompt: "analyzing" },
      context: { taskId: "test-task", store: {}, status: "running", stageSessionIds: {}, retryCount: 0, qaRetryCount: 0 } as any,
    });

    expect(result.sessionId).toBe("sess-1");
    expect(result.costUsd).toBe(0.05);
    expect(result.resultText).toContain("analysis");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("reuses query on second executeStage and computes differential cost", async () => {
    const fakeQ = createFakeQuery([
      { type: "system", subtype: "init", session_id: "sess-1" },
      // Stage 1 result
      { type: "result", subtype: "success", result: '{"a": 1}', total_cost_usd: 0.05, duration_ms: 500, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, session_id: "sess-1" },
      // Stage 2 result (cumulative cost)
      { type: "result", subtype: "success", result: '{"b": 2}', total_cost_usd: 0.12, duration_ms: 800, usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 50 }, session_id: "sess-1" },
    ]);
    vi.mocked(query).mockReturnValue(fakeQ as any);

    const mgr = new SessionManager(makeConfig());
    const baseParams = {
      taskId: "test-task",
      worktreePath: "/tmp/test",
      interactive: false,
      runtime: { engine: "llm" as const, system_prompt: "test" },
      context: { taskId: "test-task", store: {}, status: "running", stageSessionIds: {}, retryCount: 0, qaRetryCount: 0 } as any,
    };

    const r1 = await mgr.executeStage({
      ...baseParams,
      stageName: "stage1",
      tier1Context: "ctx",
      stagePrompt: "prompt1",
      stageConfig: { model: "claude-sonnet-4-6", mcpServices: [], permissionMode: "bypassPermissions", maxTurns: 30, maxBudgetUsd: 2, thinking: { type: "disabled" } },
    });

    const r2 = await mgr.executeStage({
      ...baseParams,
      stageName: "stage2",
      tier1Context: "ctx",
      stagePrompt: "prompt2",
      stageConfig: { model: "claude-sonnet-4-6", mcpServices: [], permissionMode: "bypassPermissions", maxTurns: 30, maxBudgetUsd: 2, thinking: { type: "disabled" } },
    });

    // query created only once
    expect(query).toHaveBeenCalledTimes(1);
    // Differential cost
    expect(r1.costUsd).toBe(0.05);
    expect(r2.costUsd).toBeCloseTo(0.07, 4);
  });

  it("calls setModel when model changes between stages", async () => {
    const fakeQ = createFakeQuery([
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", subtype: "success", result: "{}", total_cost_usd: 0.01, duration_ms: 100, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }, session_id: "sess-1" },
      { type: "result", subtype: "success", result: "{}", total_cost_usd: 0.02, duration_ms: 100, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }, session_id: "sess-1" },
    ]);
    vi.mocked(query).mockReturnValue(fakeQ as any);

    const mgr = new SessionManager(makeConfig());
    const baseParams = {
      taskId: "test-task", worktreePath: "/tmp/test", interactive: false, tier1Context: "ctx", stagePrompt: "p",
      runtime: { engine: "llm" as const, system_prompt: "test" },
      context: { taskId: "test-task", store: {}, status: "running", stageSessionIds: {}, retryCount: 0, qaRetryCount: 0 } as any,
    };

    await mgr.executeStage({ ...baseParams, stageName: "s1", stageConfig: { model: "claude-sonnet-4-6", mcpServices: [], permissionMode: "bypassPermissions", maxTurns: 30, maxBudgetUsd: 2, thinking: { type: "disabled" } } });
    await mgr.executeStage({ ...baseParams, stageName: "s2", stageConfig: { model: "claude-opus-4-6", mcpServices: [], permissionMode: "bypassPermissions", maxTurns: 30, maxBudgetUsd: 2, thinking: { type: "disabled" } } });

    expect(fakeQ.setModel).toHaveBeenCalledWith("claude-opus-4-6");
  });

  it("yields feedback prompt on retry (resumeInfo present)", async () => {
    const fakeQ = createFakeQuery([
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", subtype: "success", result: '{"incomplete": true}', total_cost_usd: 0.05, duration_ms: 500, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, session_id: "sess-1" },
      { type: "result", subtype: "success", result: '{"complete": true}', total_cost_usd: 0.10, duration_ms: 500, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, session_id: "sess-1" },
    ]);
    vi.mocked(query).mockReturnValue(fakeQ as any);

    const mgr = new SessionManager(makeConfig());
    const baseParams = {
      taskId: "test-task", worktreePath: "/tmp/test", interactive: false, tier1Context: "ctx", stagePrompt: "p",
      stageConfig: { model: "claude-sonnet-4-6", mcpServices: [], permissionMode: "bypassPermissions", maxTurns: 30, maxBudgetUsd: 2, thinking: { type: "disabled" } },
      runtime: { engine: "llm" as const, system_prompt: "test" },
      context: { taskId: "test-task", store: {}, status: "running", stageSessionIds: {}, retryCount: 0, qaRetryCount: 0 } as any,
    };

    // First call
    await mgr.executeStage({ ...baseParams, stageName: "s1" });
    // Retry call with feedback
    const r2 = await mgr.executeStage({ ...baseParams, stageName: "s1", resumeInfo: { feedback: "Missing required fields" } });

    expect(r2.resultText).toContain("complete");
    expect(query).toHaveBeenCalledTimes(1); // still same query
  });

  it("close() terminates the query", async () => {
    const fakeQ = createFakeQuery([
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", subtype: "success", result: "{}", total_cost_usd: 0.01, duration_ms: 100, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }, session_id: "sess-1" },
    ]);
    vi.mocked(query).mockReturnValue(fakeQ as any);

    const mgr = new SessionManager(makeConfig());
    await mgr.executeStage({
      taskId: "test-task", stageName: "s1", tier1Context: "ctx", stagePrompt: "p", worktreePath: "/tmp/test", interactive: false,
      stageConfig: { model: "claude-sonnet-4-6", mcpServices: [], permissionMode: "bypassPermissions", maxTurns: 30, maxBudgetUsd: 2, thinking: { type: "disabled" } },
      runtime: { engine: "llm" as const, system_prompt: "test" },
      context: { taskId: "test-task", store: {}, status: "running", stageSessionIds: {}, retryCount: 0, qaRetryCount: 0 } as any,
    });

    mgr.close();
    expect(fakeQ.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/agent/session-manager.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SessionManager**

Create `apps/server/src/agent/session-manager.ts`. This is a large file — the core of single-session mode. Key implementation details:

1. `executeStage()` — three paths: first call (create query), subsequent call (reuse query + dynamic config switch), retry call (yield feedback)
2. `consumeUntilResult()` — manual `.next()` iteration (NOT `for await`), differential cost, SSE forwarding
3. `buildUserMessage()` — constructs `SDKUserMessage` from plain string
4. `buildStagePrompt()` — full Tier 1 on first call, incremental on subsequent calls
5. Idle timer management

The file should import from `./async-queue.js`, `@anthropic-ai/claude-agent-sdk`, `../sse/manager.js`, `../lib/logger.js`, `./session-persister.js`.

```typescript
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Query, Options as SdkOptions, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./async-queue.js";
import { sseManager } from "../sse/manager.js";
import { taskLogger } from "../lib/logger.js";
import { persistSessionId } from "./session-persister.js";
import type { SSEMessage } from "../types/index.js";
import type { AgentRuntimeConfig } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";
import type { StageTokenUsage } from "@workflow-control/shared";
import { buildMcpServers } from "../lib/mcp-config.js";
import { buildChildEnv } from "../lib/child-env.js";
import { createAskUserQuestionInterceptor, createPathRestrictionHook } from "./executor-hooks.js";
import { loadSystemSettings } from "../lib/config-loader.js";
import { buildSystemAppendPrompt, buildStaticPromptPrefix, generateSchemaPrompt } from "./prompt-builder.js";
import { outputSchemaToJsonSchema } from "./output-schema.js";
import { RedFlagAccumulator } from "./red-flag-detector.js";

export interface SessionManagerConfig {
  taskId: string;
  claudePath: string;
  idleTimeoutMs: number;
  cwd: string;
}

export interface ExecuteStageParams {
  taskId: string;
  stageName: string;
  tier1Context: string;
  stagePrompt: string;
  stageConfig: {
    model?: string;
    mcpServices: string[];
    permissionMode: string;
    maxTurns: number;
    maxBudgetUsd: number;
    thinking: SdkOptions["thinking"];
  };
  resumeInfo?: { feedback: string };
  worktreePath: string;
  interactive: boolean;
  runtime: AgentRuntimeConfig;
  context: WorkflowContext;
  parallelGroup?: { name: string; stages: any[] };
}

interface AgentResult {
  resultText: string;
  sessionId: string | undefined;
  costUsd: number;
  durationMs: number;
  tokenUsage: StageTokenUsage | undefined;
  cwd?: string;
}

function createSSEMessage(taskId: string, type: SSEMessage["type"], data: unknown): SSEMessage {
  return { type, taskId, timestamp: new Date().toISOString(), data };
}

function buildUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage;
}

export class SessionManager {
  private query: Query | null = null;
  private queryIterator: AsyncIterator<SDKMessage> | null = null;
  private inputQueue: AsyncQueue<SDKUserMessage> | null = null;
  private sessionId: string | undefined;
  private queryClosed = false;

  // Differential cost/usage tracking
  private cumulativeCostUsd = 0;
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  private cumulativeCacheReadTokens = 0;

  // Per-stage tracking
  private stageTurnCount = 0;

  // Incremental context
  private knownStoreKeys = new Set<string>();

  // Previous stage config (for change detection)
  private prevModel: string | undefined;
  private prevPermissionMode: string | undefined;

  // Idle timeout
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly config: SessionManagerConfig;

  constructor(config: SessionManagerConfig) {
    this.config = config;
  }

  async executeStage(params: ExecuteStageParams): Promise<AgentResult> {
    const log = taskLogger(params.taskId, params.stageName);

    // Reset idle timer
    this.clearIdleTimer();

    // Parallel group dispatch
    if (params.parallelGroup) {
      return this.executeParallelGroup(params);
    }

    // Retry path: yield feedback prompt
    if (params.resumeInfo?.feedback && this.query && !this.queryClosed) {
      log.info("Single-session retry: yielding feedback prompt");
      this.inputQueue!.enqueue(buildUserMessage(params.resumeInfo.feedback));
      return this.consumeUntilResult(params);
    }

    // First call: create query
    if (!this.query || this.queryClosed) {
      log.info({ isResume: this.queryClosed }, "Creating single-session query");
      await this.createQuery(params);
      const prompt = this.buildStagePrompt(params, true);
      this.inputQueue!.enqueue(buildUserMessage(prompt));
      return this.consumeUntilResult(params);
    }

    // Subsequent call: dynamic config switch + yield new prompt
    log.info("Single-session continuing: yielding stage prompt");
    await this.switchStageConfig(params);
    const prompt = this.buildStagePrompt(params, false);
    this.inputQueue!.enqueue(buildUserMessage(prompt));
    return this.consumeUntilResult(params);
  }

  private async createQuery(params: ExecuteStageParams): Promise<void> {
    this.inputQueue = new AsyncQueue<SDKUserMessage>();

    const settings = loadSystemSettings();
    const sandboxFs = (params.context.config?.sandbox ?? settings.sandbox)?.filesystem;
    const pathHook = createPathRestrictionHook(sandboxFs?.allow_write, sandboxFs?.deny_write);

    const hooks: SdkOptions["hooks"] = {
      PreToolUse: [{ hooks: [pathHook] }],
    };

    // Build initial MCP servers from first stage's config
    const localMcp = buildMcpServers(params.stageConfig.mcpServices, "claude");

    const options: SdkOptions = {
      systemPrompt: { type: "preset", preset: "claude_code", append: await this.buildSystemAppend(params) },
      pathToClaudeCodeExecutable: this.config.claudePath,
      settingSources: [],
      thinking: params.stageConfig.thinking,
      model: params.stageConfig.model,
      permissionMode: (params.stageConfig.permissionMode ?? "bypassPermissions") as SdkOptions["permissionMode"],
      ...(params.stageConfig.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      maxTurns: 500,      // session-level ceiling; per-stage soft limit in consumeUntilResult
      maxBudgetUsd: 50,   // session-level ceiling; per-stage soft limit tracked differentially
      includePartialMessages: true,
      disallowedTools: ["ToolSearch", "mcp__claude_ai_*"],
      hooks,
      canUseTool: createAskUserQuestionInterceptor(params.taskId),
      cwd: this.config.cwd,
      env: { ...buildChildEnv({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }), CLAUDECODE: "", CI: "true" },
      ...(this.queryClosed && this.sessionId ? { resume: this.sessionId } : {}),
    };

    this.query = sdkQuery({ prompt: this.inputQueue, options });
    this.queryIterator = null; // will be set in consumeUntilResult
    this.queryClosed = false;

    // Track initial config for change detection
    this.prevModel = params.stageConfig.model;
    this.prevPermissionMode = params.stageConfig.permissionMode;
  }

  private async buildSystemAppend(params: ExecuteStageParams): Promise<string> {
    // Build append prompt with fragment superset (same as multi-session, but only once)
    const result = await buildSystemAppendPrompt({
      taskId: params.taskId,
      stageName: params.stageName,
      runtime: params.runtime,
      privateConfig: params.context.config,
      stageConfig: { ...params.stageConfig, mcpServices: params.stageConfig.mcpServices },
      cwd: params.worktreePath,
    });

    const staticPrefix = buildStaticPromptPrefix(params.context.config, "claude", result.fragmentIds);
    return staticPrefix ? `${staticPrefix}\n\n${result.prompt}` : result.prompt;
  }

  private async switchStageConfig(params: ExecuteStageParams): Promise<void> {
    if (!this.query) return;

    if (params.stageConfig.model && params.stageConfig.model !== this.prevModel) {
      await this.query.setModel(params.stageConfig.model);
      this.prevModel = params.stageConfig.model;
    }

    if (params.stageConfig.permissionMode !== this.prevPermissionMode) {
      await this.query.setPermissionMode(params.stageConfig.permissionMode as any);
      this.prevPermissionMode = params.stageConfig.permissionMode;
    }

    // MCP switching: set to new stage's MCP set
    const newMcp = buildMcpServers(params.stageConfig.mcpServices, "claude");
    if (Object.keys(newMcp).length > 0) {
      await this.query.setMcpServers(newMcp as any);
    }
  }

  private buildStagePrompt(params: ExecuteStageParams, isFirst: boolean): string {
    const parts: string[] = [];

    parts.push(`\n--- Stage: ${params.stageName} ---\n`);

    if (isFirst) {
      // Full Tier 1 context
      parts.push(params.tier1Context);
    } else {
      // Incremental: only new store data
      const store = params.context.store ?? {};
      const newKeys = Object.keys(store).filter(k => !this.knownStoreKeys.has(k) && !k.includes(".__summary") && !k.includes(".__semantic_summary"));
      if (newKeys.length > 0) {
        parts.push("\n## New Context (from previous stages)\n");
        for (const key of newKeys) {
          const val = store[key];
          if (val !== undefined) {
            parts.push(`### ${key}\n\`\`\`json\n${JSON.stringify(val, null, 2)}\n\`\`\`\n`);
          }
        }
      }
    }

    // Stage-specific instructions
    parts.push(`\n## Your Task\n${params.stagePrompt}\n`);

    // Update known store keys
    const store = params.context.store ?? {};
    for (const key of Object.keys(store)) {
      this.knownStoreKeys.add(key);
    }
    for (const w of params.runtime.writes ?? []) {
      this.knownStoreKeys.add(typeof w === "string" ? w : w.key);
    }

    return parts.join("\n");
  }

  private async consumeUntilResult(params: ExecuteStageParams): Promise<AgentResult> {
    if (!this.queryIterator) {
      this.queryIterator = this.query![Symbol.asyncIterator]();
    }

    this.stageTurnCount = 0;
    let resultText = "";
    let toolCallCount = 0;
    const startTime = Date.now();
    const log = taskLogger(params.taskId, params.stageName);
    const redFlagAccumulator = new RedFlagAccumulator();

    // SSE: stage_change
    sseManager.pushMessage(params.taskId, createSSEMessage(params.taskId, "stage_change", { stage: params.stageName }));

    while (true) {
      const { value: message, done } = await this.queryIterator.next();
      if (done) {
        throw new Error(`Single-session query ended unexpectedly during stage "${params.stageName}"`);
      }

      this.clearIdleTimer();

      const msg = message as Record<string, unknown>;
      const msgSessionId = msg.session_id as string | undefined;
      if (msgSessionId && !this.sessionId) {
        this.sessionId = msgSessionId;
        await persistSessionId(params.taskId, params.stageName, this.sessionId);
      }

      switch ((message as any).type) {
        case "assistant": {
          const content = (message as any).message?.content;
          if (!content) break;
          for (const block of content) {
            if (block.type === "text" && block.text) {
              sseManager.pushMessage(params.taskId, createSSEMessage(params.taskId, "agent_text", { text: block.text }));
              if (resultText.length < 5 * 1024 * 1024) {
                resultText += block.text;
              }
              const newFlags = redFlagAccumulator.append(block.text);
              if (newFlags.length > 0) {
                sseManager.pushMessage(params.taskId, createSSEMessage(params.taskId, "agent_red_flag", {
                  flags: newFlags.map(f => ({ category: f.category, description: f.description, matched: f.matchedText })),
                }));
              }
            }
            if (block.type === "thinking" && block.thinking) {
              sseManager.pushMessage(params.taskId, createSSEMessage(params.taskId, "agent_thinking", { text: block.thinking }));
            }
            if (block.type === "tool_use") {
              sseManager.pushMessage(params.taskId, createSSEMessage(params.taskId, "agent_tool_use", { toolName: block.name, input: block.input }));
              toolCallCount++;
              this.stageTurnCount++;
            }
          }
          break;
        }

        case "result": {
          const r = msg;
          const totalCost = (r.total_cost_usd as number) ?? 0;
          const stageCost = totalCost - this.cumulativeCostUsd;
          this.cumulativeCostUsd = totalCost;

          const durationMs = Date.now() - startTime;

          // Differential token usage
          const usage = r.usage as Record<string, number> | undefined;
          let tokenUsage: StageTokenUsage | undefined;
          if (usage) {
            const inputTokens = (usage.input_tokens ?? 0) - this.cumulativeInputTokens;
            const outputTokens = (usage.output_tokens ?? 0) - this.cumulativeOutputTokens;
            const cacheReadTokens = (usage.cache_read_input_tokens ?? 0) - this.cumulativeCacheReadTokens;
            this.cumulativeInputTokens = usage.input_tokens ?? 0;
            this.cumulativeOutputTokens = usage.output_tokens ?? 0;
            this.cumulativeCacheReadTokens = usage.cache_read_input_tokens ?? 0;
            tokenUsage = { inputTokens, outputTokens, cacheReadTokens, totalTokens: inputTokens + outputTokens };
          }

          // Handle result text
          const subtype = r.subtype as string | undefined;
          if (subtype === "success") {
            if (r.structured_output) {
              resultText = JSON.stringify(r.structured_output);
            } else if (r.result) {
              resultText = r.result as string;
            }
          } else if (subtype && subtype.startsWith("error_")) {
            const errMsg = String(r.error_message ?? r.result ?? "Agent error");
            log.warn({ subtype, errorMessage: errMsg }, "Single-session stage ended with error result");
            throw new Error(errMsg);
          }

          if (this.sessionId) {
            await persistSessionId(params.taskId, params.stageName, this.sessionId);
          }

          // Start idle timer for gap until next stage
          this.startIdleTimer();

          log.info({ costUsd: stageCost.toFixed(3), durationMs, sessionId: this.sessionId ?? "none", resultTextLength: resultText.length }, "Single-session stage DONE");

          return {
            resultText,
            sessionId: this.sessionId,
            costUsd: stageCost,
            durationMs,
            tokenUsage,
            cwd: params.worktreePath,
          };
        }

        case "system":
          log.debug({ subtype: msg.subtype }, "system message");
          break;
      }

      // Soft turn limit
      if (this.stageTurnCount > 0 && this.stageTurnCount >= params.stageConfig.maxTurns) {
        log.warn({ turns: this.stageTurnCount, limit: params.stageConfig.maxTurns }, "Stage turn limit reached, requesting stop");
        this.inputQueue!.enqueue(buildUserMessage(
          "You have exceeded the turn limit for this stage. Stop working and output your current progress as the required JSON immediately."
        ));
        this.stageTurnCount = -999; // prevent re-sending
      }
    }
  }

  private async executeParallelGroup(params: ExecuteStageParams): Promise<AgentResult> {
    const group = params.parallelGroup!;
    const log = taskLogger(params.taskId, params.stageName);

    // Set MCP servers to union of all child stage MCPs
    const allMcps = new Set<string>();
    for (const stage of group.stages) {
      for (const mcp of (stage.mcps ?? []) as string[]) allMcps.add(mcp);
    }
    if (allMcps.size > 0 && this.query) {
      const mcpConfig = buildMcpServers([...allMcps], "claude");
      await this.query.setMcpServers(mcpConfig as any);
    }

    // Build parallel dispatch prompt
    const promptParts: string[] = [
      `\n--- Parallel Stage: ${group.name} ---\n`,
      `You need to execute ${group.stages.length} tasks IN PARALLEL using the Agent tool.`,
      `Dispatch ALL of them in a SINGLE message (multiple Agent tool calls).`,
      `After all agents complete, combine their results into a single JSON object.\n`,
    ];

    for (const stage of group.stages) {
      const runtime = stage.runtime as AgentRuntimeConfig;
      const writeKeys = (runtime.writes ?? []).map((w: any) => typeof w === "string" ? w : w.key);
      promptParts.push(`### Task: ${stage.name}`);
      promptParts.push(`Instructions: ${runtime.system_prompt}`);
      promptParts.push(`Output JSON keys: ${writeKeys.join(", ")}`);
      if ((stage.mcps as string[] | undefined)?.length) {
        promptParts.push(`Available MCP servers: ${(stage.mcps as string[]).join(", ")}`);
      }
      promptParts.push("");
    }

    // Combined output schema
    const allWriteKeys: string[] = [];
    for (const stage of group.stages) {
      const runtime = stage.runtime as AgentRuntimeConfig;
      for (const w of runtime.writes ?? []) {
        allWriteKeys.push(typeof w === "string" ? w : w.key);
      }
    }
    promptParts.push(`## Required Combined Output`);
    promptParts.push(`Return a single JSON object with these top-level keys: ${allWriteKeys.join(", ")}`);

    const prompt = promptParts.join("\n");
    log.info({ group: group.name, childCount: group.stages.length, mcps: [...allMcps] }, "Dispatching parallel group via subagents");

    this.inputQueue!.enqueue(buildUserMessage(prompt));
    return this.consumeUntilResult(params);
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      taskLogger(this.config.taskId).warn({ timeoutMs: this.config.idleTimeoutMs }, "Single-session idle timeout — closing query");
      this.queryClosed = true;
      this.query?.close();
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  close(): void {
    this.clearIdleTimer();
    if (this.query) {
      this.query.close();
      this.query = null;
      this.queryIterator = null;
      this.queryClosed = true;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && npx vitest run src/agent/session-manager.test.ts --reporter=verbose`
Expected: All 5 tests pass

- [ ] **Step 5: Run type check**

Run: `cd apps/server && ./node_modules/.bin/tsc --noEmit`
Expected: Clean (only pre-existing errors)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent/session-manager.ts apps/server/src/agent/session-manager.test.ts
git commit -m "feat: add SessionManager for single-session pipeline execution"
```

---

### Task 4: SessionManager Registry — Per-task lifecycle management

**Files:**
- Create: `apps/server/src/agent/session-manager-registry.ts`
- Create: `apps/server/src/agent/session-manager-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/server/src/agent/session-manager-registry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./session-manager.js", () => ({
  SessionManager: vi.fn().mockImplementation(() => ({
    close: vi.fn(),
    executeStage: vi.fn(),
  })),
}));

import { getOrCreateSessionManager, getSessionManager, closeSessionManager, closeAllSessionManagers } from "./session-manager-registry.js";
import { SessionManager } from "./session-manager.js";

beforeEach(() => {
  closeAllSessionManagers();
  vi.clearAllMocks();
});

describe("SessionManager Registry", () => {
  it("creates a new SessionManager on first call", () => {
    const mgr = getOrCreateSessionManager("task-1", { taskId: "task-1", claudePath: "claude", idleTimeoutMs: 7200_000, cwd: "/tmp" });
    expect(mgr).toBeDefined();
    expect(SessionManager).toHaveBeenCalledTimes(1);
  });

  it("returns same instance on subsequent calls", () => {
    const cfg = { taskId: "task-1", claudePath: "claude", idleTimeoutMs: 7200_000, cwd: "/tmp" };
    const mgr1 = getOrCreateSessionManager("task-1", cfg);
    const mgr2 = getOrCreateSessionManager("task-1", cfg);
    expect(mgr1).toBe(mgr2);
    expect(SessionManager).toHaveBeenCalledTimes(1);
  });

  it("getSessionManager returns undefined for unknown task", () => {
    expect(getSessionManager("unknown")).toBeUndefined();
  });

  it("closeSessionManager calls close and removes from registry", () => {
    const cfg = { taskId: "task-1", claudePath: "claude", idleTimeoutMs: 7200_000, cwd: "/tmp" };
    const mgr = getOrCreateSessionManager("task-1", cfg);
    closeSessionManager("task-1");
    expect(mgr.close).toHaveBeenCalled();
    expect(getSessionManager("task-1")).toBeUndefined();
  });

  it("closeSessionManager is safe for unknown task", () => {
    expect(() => closeSessionManager("unknown")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/agent/session-manager-registry.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement registry**

Create `apps/server/src/agent/session-manager-registry.ts`:

```typescript
import { SessionManager, type SessionManagerConfig } from "./session-manager.js";

const managers = new Map<string, SessionManager>();

export function getOrCreateSessionManager(taskId: string, config: SessionManagerConfig): SessionManager {
  let mgr = managers.get(taskId);
  if (!mgr) {
    mgr = new SessionManager(config);
    managers.set(taskId, mgr);
  }
  return mgr;
}

export function getSessionManager(taskId: string): SessionManager | undefined {
  return managers.get(taskId);
}

export function closeSessionManager(taskId: string): void {
  const mgr = managers.get(taskId);
  if (mgr) {
    mgr.close();
    managers.delete(taskId);
  }
}

export function closeAllSessionManagers(): void {
  for (const [taskId, mgr] of managers) {
    mgr.close();
  }
  managers.clear();
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && npx vitest run src/agent/session-manager-registry.test.ts --reporter=verbose`
Expected: All 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/session-manager-registry.ts apps/server/src/agent/session-manager-registry.test.ts
git commit -m "feat: add SessionManager registry for per-task lifecycle"
```

---

### Task 5: Executor — Add runAgentSingleSession entry point

**Files:**
- Modify: `apps/server/src/agent/executor.ts:40-48` (add export)
- Test: `apps/server/src/agent/executor.test.ts`

- [ ] **Step 1: Write failing test**

In `apps/server/src/agent/executor.test.ts`, add a test for the new function (after existing tests):

```typescript
describe("runAgentSingleSession", () => {
  it("is exported as a function", async () => {
    const mod = await import("./executor.js");
    expect(typeof mod.runAgentSingleSession).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/agent/executor.test.ts --reporter=verbose`
Expected: FAIL — `runAgentSingleSession` is not exported

- [ ] **Step 3: Implement runAgentSingleSession**

In `apps/server/src/agent/executor.ts`, add the import and function. After the existing `runAgent` function (around line 134), add:

```typescript
import { getOrCreateSessionManager } from "./session-manager-registry.js";
import type { PipelineConfig } from "../lib/config-loader.js";

export async function runAgentSingleSession(
  taskId: string,
  input: {
    stageName: string;
    worktreePath: string;
    tier1Context: string;
    enabledSteps?: string[];
    attempt: number;
    resumeInfo?: { sessionId: string; feedback?: string; sync?: boolean };
    interactive?: boolean;
    runtime: AgentRuntimeConfig;
    context?: WorkflowContext;
    parallelGroup?: { name: string; stages: any[] };
  }
): Promise<AgentResult> {
  if (process.env.MOCK_EXECUTOR === "true") {
    const delayMs = Number(process.env.MOCK_EXECUTOR_DELAY_MS ?? 300);
    await new Promise(r => setTimeout(r, delayMs));
    const writes = (input.runtime.writes ?? []).map(w => typeof w === "string" ? w : w.key);
    const mockData = _buildMockWrites(writes);
    return {
      resultText: JSON.stringify(mockData),
      costUsd: 0.001,
      durationMs: delayMs,
      sessionId: `mock-single-${taskId}-${input.stageName}-${Date.now()}`,
      tokenUsage: undefined,
    };
  }

  const { stageName, worktreePath, tier1Context, resumeInfo, interactive, runtime, context: inputContext } = input;
  if (!inputContext) throw new Error(`No workflow context for task ${taskId}`);

  const settings = loadSystemSettings();
  const claudePath = settings.paths?.claude_executable || "claude";
  const pipeline = inputContext.config?.pipeline;
  const idleTimeoutMs = ((pipeline as any)?.session_idle_timeout_sec ?? 7200) * 1000;

  const mgr = getOrCreateSessionManager(taskId, {
    taskId,
    claudePath,
    idleTimeoutMs,
    cwd: worktreePath,
  });

  const privateStage = pipeline?.stages
    ? flattenStages(pipeline.stages).find((s) => s.name === stageName)
    : undefined;

  const stageConfig = {
    model: privateStage?.model || settings.agent?.claude_model,
    mcpServices: (privateStage?.mcps ?? []) as string[],
    permissionMode: (privateStage?.permission_mode ?? "bypassPermissions"),
    maxTurns: privateStage?.max_turns ?? 30,
    maxBudgetUsd: privateStage?.max_budget_usd ?? 2,
    thinking: privateStage?.thinking
      ? { type: privateStage.thinking.type as "enabled" | "disabled" | "adaptive" }
      : { type: "disabled" as const },
  };

  const result = await mgr.executeStage({
    taskId,
    stageName,
    tier1Context,
    stagePrompt: runtime.system_prompt,
    stageConfig,
    resumeInfo: resumeInfo?.feedback ? { feedback: resumeInfo.feedback } : undefined,
    worktreePath,
    interactive: interactive ?? false,
    runtime,
    context: inputContext,
    parallelGroup: input.parallelGroup,
  });

  // Run verify commands if configured (same as runAgent)
  const stageConf = findStageConfig(inputContext.config?.pipeline?.stages, stageName);
  const verifyCommands = stageConf?.verify_commands as string[] | undefined;
  const verifyPolicy = (stageConf?.verify_policy ?? "must_pass") as string;

  if (verifyCommands?.length && verifyPolicy !== "skip") {
    const { allPassed, results: verifyResults } = await runVerifyCommands(taskId, stageName, verifyCommands, worktreePath);
    if (!allPassed) {
      if (verifyPolicy === "must_pass") {
        return { ...result, verifyFailed: true, verifyResults } as any;
      }
      taskLogger(taskId, stageName).warn({ failures: formatVerifyFailures(verifyResults).slice(0, 1000) }, "Verify commands failed (warn policy, continuing)");
    }
    return { ...result, verifyResults } as any;
  }

  return result;
}
```

Also add the missing import at the top of the file (if not already present):

```typescript
import { flattenStages } from "../lib/config-loader.js";
import { findStageConfig } from "../lib/config/stage-lookup.js";
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && npx vitest run src/agent/executor.test.ts --reporter=verbose`
Expected: All pass

- [ ] **Step 5: Run type check**

Run: `cd apps/server && ./node_modules/.bin/tsc --noEmit`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent/executor.ts apps/server/src/agent/executor.test.ts
git commit -m "feat: add runAgentSingleSession entry point in executor"
```

---

### Task 6: XState Integration — Wire single session into state machine

**Files:**
- Modify: `apps/server/src/machine/machine.ts:1-36`
- Modify: `apps/server/src/machine/state-builders.ts:148-161`
- Modify: `apps/server/src/machine/stage-registry.ts`
- Modify: `apps/server/src/machine/pipeline-builder.ts:100,233-286`
- Modify: `apps/server/src/machine/side-effects.ts:84-105,156-161`

- [ ] **Step 1: Add runAgentSingleSession actor to machine.ts**

In `apps/server/src/machine/machine.ts`, add import and actor:

```typescript
// Add to imports (line 4)
import { runAgent, runScript, runAgentSingleSession } from "../agent/executor.js";

// Add to actors (after runEdgeAgent, around line 29)
    runAgentSingleSession: loggedActor("agent-single", (input: { taskId: string; stageName: string; worktreePath: string; tier1Context: string; enabledSteps?: string[]; attempt: number; resumeInfo?: { sessionId: string; feedback?: string; sync?: boolean }; interactive?: boolean; runtime: AgentRuntimeConfig; context?: WorkflowContext; parallelGroup?: { name: string; stages: any[] } }) =>
      runAgentSingleSession(input.taskId, input)),
```

- [ ] **Step 2: Add session_mode parameter to buildAgentState**

In `apps/server/src/machine/state-builders.ts`, modify `buildAgentState` signature to accept pipeline session mode. Change the `opts` type:

```typescript
export function buildAgentState(
  nextTarget: string,
  _prevAgentTarget: string,
  stage: AgentStageConfig,
  opts?: { blockedTarget?: string; statePrefix?: string; childToGroup?: Map<string, string>; sessionMode?: "multi" | "single" },
): StateNode {
```

Then modify the invoke src selection (line ~161):

```typescript
    invoke: {
      src: (stage.execution_mode === "edge" || stage.execution_mode === "any")
        ? "runEdgeAgent"
        : (opts?.sessionMode === "single" ? "runAgentSingleSession" : "runAgent"),
```

- [ ] **Step 3: Update stage-registry to pass sessionMode through**

In `apps/server/src/machine/stage-registry.ts`, update the `StageBuilderOpts` type and the agent builder call:

```typescript
export type StageBuilderOpts = { blockedTarget?: string; statePrefix?: string; childToGroup?: Map<string, string>; sessionMode?: "multi" | "single" };

// In getStageBuilder, agent case (line 9):
    return (next, prev, cfg, opts) => buildAgentState(next, prev, cfg as AgentStageConfig, opts);
```

No change needed here — `opts` is already passed through. The `sessionMode` field will flow from pipeline-builder.

- [ ] **Step 4: Thread sessionMode through pipeline-builder**

In `apps/server/src/machine/pipeline-builder.ts`, modify the builder call for non-parallel stages (around line 407):

```typescript
      const builder = getStageBuilder(stage);
      if (builder) {
        states[stateName] = builder(nextStateName, prevAgentStateForGate, stage, { childToGroup, sessionMode: pipeline.session_mode });
        taskLogger("pipeline").info({ stage: stage.name, type: stage.type, next: nextStateName }, "State built");
```

For parallel group in single-session mode (around line 233), add the branching:

```typescript
    if (isParallelGroup(entry)) {
      // ... existing validation code ...

      if (pipeline.session_mode === "single") {
        states[entry.parallel.name] = buildSingleSessionParallelState(
          entry.parallel, nextStateName, prevAgentState
        );
        taskLogger("pipeline").info({ group: entry.parallel.name, next: nextStateName, mode: "single-session" }, "Single-session parallel group built");
      } else {
        states[entry.parallel.name] = buildParallelGroupState(
          entry.parallel, nextStateName, prevAgentState
        );
        taskLogger("pipeline").info({ group: entry.parallel.name, children: entry.parallel.stages.map(s => s.name), next: nextStateName }, "Parallel group built");
      }
```

- [ ] **Step 5: Add buildSingleSessionParallelState to state-builders.ts**

At the end of `apps/server/src/machine/state-builders.ts`, add:

```typescript
/**
 * Single-session parallel: dispatches child stages as subagents within
 * the shared session. Generates a single invoke state (not XState parallel).
 */
export function buildSingleSessionParallelState(
  group: { name: string; stages: PipelineStageConfig[] },
  nextTarget: string,
  prevAgentTarget: string,
): StateNode {
  const groupName = group.name;

  // Combine writes from all child stages
  const combinedWrites: WriteDeclaration[] = [];
  for (const stage of group.stages) {
    const runtime = stage.runtime as AgentRuntimeConfig | undefined;
    if (runtime?.writes) combinedWrites.push(...runtime.writes);
  }

  const combinedRuntime: AgentRuntimeConfig = {
    engine: "llm",
    system_prompt: "",
    writes: combinedWrites,
  };

  return {
    entry: statusEntry(groupName),
    invoke: {
      src: "runAgentSingleSession",
      input: ({ context }: { context: WorkflowContext }) => ({
        taskId: context.taskId,
        stageName: groupName,
        worktreePath: context.worktreePath ?? "",
        tier1Context: buildTier1Context(context, combinedRuntime),
        attempt: context.retryCount,
        resumeInfo: context.resumeInfo,
        runtime: combinedRuntime,
        context,
        parallelGroup: group,
      }),
      onDone: [
        // Writes validation guard (retry on missing keys)
        {
          guard: ({ event, context }: { event: { output: { resultText: string } }; context: WorkflowContext }) => {
            if (combinedWrites.length === 0) return false;
            if (getStageRetryCount(context, groupName) >= 2) return false;
            if (!event.output.resultText) return true;
            const parsed = getCachedParse(event.output);
            if (!parsed) return true;
            const writeKeys = combinedWrites.map((w: WriteDeclaration) => typeof w === "string" ? w : w.key);
            return !writeKeys.every((field: string) => parsed[field] !== undefined);
          },
          target: groupName,
          reenter: true,
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => ({
              retryCount: context.retryCount + 1,
              stageRetryCount: incrementStageRetryCount(context, groupName),
              totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
              totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
              stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [groupName]: event.output.tokenUsage } : context.stageTokenUsages,
              stageSessionIds: { ...context.stageSessionIds, [groupName]: event.output?.sessionId ?? context.stageSessionIds?.[groupName] },
              resumeInfo: event.output?.sessionId
                ? { sessionId: event.output.sessionId, feedback: `Your previous output was missing required JSON fields. Output ALL keys: ${combinedWrites.map((w: WriteDeclaration) => typeof w === "string" ? w : w.key).join(", ")}` }
                : undefined,
            })),
          ],
        },
        // Success path
        {
          target: nextTarget,
          actions: [
            assign(({ event, context }: { event: DoneEvent; context: WorkflowContext }) => {
              let store = { ...context.store };
              if (event.output?.resultText) {
                const parsed = getCachedParse(event.output);
                if (parsed) {
                  const writeStrategies = buildWriteStrategies(combinedWrites);
                  const filtered = filterStoreWrites(parsed, combinedWrites, groupName, context.taskId);
                  applyStoreUpdates(store, filtered, writeStrategies);
                }
              }
              return {
                store,
                retryCount: 0,
                stageRetryCount: resetStageRetryCount(context, groupName),
                resumeInfo: undefined,
                totalCostUsd: (context.totalCostUsd ?? 0) + (event.output?.costUsd ?? 0),
                totalTokenUsage: accumulateTokenUsage(context.totalTokenUsage, event.output?.tokenUsage),
                stageTokenUsages: event.output?.tokenUsage ? { ...context.stageTokenUsages, [groupName]: event.output.tokenUsage } : context.stageTokenUsages,
                stageSessionIds: { ...context.stageSessionIds, [groupName]: event.output?.sessionId ?? context.stageSessionIds?.[groupName] },
                completedStages: [...(context.completedStages ?? []), groupName],
                executionHistory: [...(context.executionHistory ?? []), { stage: groupName, action: "completed" as const, timestamp: new Date().toISOString() }],
                parallelDone: { ...context.parallelDone, [groupName]: group.stages.map(s => s.name) },
              };
            }),
            emitStatus(groupName + " completed"),
            emitTaskListUpdate(),
          ],
        },
      ],
      onError: handleStageError(groupName),
    },
  };
}
```

You'll need to add the import for `PipelineStageConfig` at the top of state-builders.ts if not already imported.

- [ ] **Step 6: Add cleanup to side-effects.ts**

In `apps/server/src/machine/side-effects.ts`, add two lines:

After the existing cleanup in `wf.streamClose` handler (after line 95):

```typescript
    import("../agent/session-manager-registry.js").then(({ closeSessionManager }) => {
      closeSessionManager(event.taskId);
    }).catch(() => {});
```

In the `wf.cancelAgent` handler (after line 161):

```typescript
    import("../agent/session-manager-registry.js").then(({ closeSessionManager }) => {
      closeSessionManager(event.taskId);
    }).catch(() => {});
```

- [ ] **Step 7: Run type check**

Run: `cd apps/server && ./node_modules/.bin/tsc --noEmit`
Expected: Clean

- [ ] **Step 8: Run full test suite**

Run: `cd apps/server && npx vitest run --reporter=verbose`
Expected: All existing tests pass (no regressions), new tests pass

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/machine/machine.ts apps/server/src/machine/state-builders.ts apps/server/src/machine/stage-registry.ts apps/server/src/machine/pipeline-builder.ts apps/server/src/machine/side-effects.ts
git commit -m "feat: wire single-session mode into XState machine and pipeline builder"
```

---

### Task 7: Validation — Add session_mode + engine cross-validation to pipeline-builder

**Files:**
- Modify: `apps/server/src/machine/pipeline-builder.ts`
- Test: `apps/server/src/machine/pipeline-builder.test.ts`

- [ ] **Step 1: Write failing test**

In `apps/server/src/machine/pipeline-builder.test.ts`, add:

```typescript
describe("session_mode validation", () => {
  it("rejects session_mode: single with engine: gemini", () => {
    const pipeline = {
      name: "test",
      session_mode: "single" as const,
      engine: "gemini" as const,
      stages: [{ name: "s1", type: "agent" as const, runtime: { engine: "llm" as const, system_prompt: "test" } }],
    };
    expect(() => buildPipelineStates(pipeline as any)).toThrow("session_mode: 'single' requires engine: 'claude'");
  });

  it("accepts session_mode: single with engine: claude", () => {
    const pipeline = {
      name: "test",
      session_mode: "single" as const,
      engine: "claude" as const,
      stages: [{ name: "s1", type: "agent" as const, runtime: { engine: "llm" as const, system_prompt: "test", writes: ["out"] } }],
    };
    expect(() => buildPipelineStates(pipeline as any)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/machine/pipeline-builder.test.ts --reporter=verbose`
Expected: FAIL — no validation exists yet

- [ ] **Step 3: Add validation to buildPipelineStates**

In `apps/server/src/machine/pipeline-builder.ts`, at the beginning of `buildPipelineStates` (after line 101):

```typescript
  // Validate session_mode constraints
  if (pipeline.session_mode === "single") {
    if (pipeline.engine && pipeline.engine !== "claude") {
      throw new Error("Pipeline validation failed:\nsession_mode: 'single' requires engine: 'claude' (or omitted). Got: '" + pipeline.engine + "'");
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && npx vitest run src/machine/pipeline-builder.test.ts --reporter=verbose`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/machine/pipeline-builder.ts apps/server/src/machine/pipeline-builder.test.ts
git commit -m "feat: add session_mode + engine cross-validation in pipeline builder"
```

---

### Task 8: Delete spike file

**Files:**
- Delete: `apps/server/src/agent/spike-single-session.ts`

- [ ] **Step 1: Remove the spike file**

The spike file was an experimental validation. Its functionality is now properly implemented in SessionManager.

```bash
rm apps/server/src/agent/spike-single-session.ts
```

- [ ] **Step 2: Verify no imports reference it**

Run: `cd apps/server && grep -r "spike-single-session" src/ --include="*.ts"`
Expected: No matches

- [ ] **Step 3: Commit**

```bash
git add -A apps/server/src/agent/spike-single-session.ts
git commit -m "chore: remove spike-single-session.ts (replaced by SessionManager)"
```

---

### Task 9: Integration test — End-to-end single session pipeline

**Files:**
- Create: `apps/server/src/agent/session-manager.integration.test.ts`

- [ ] **Step 1: Write integration test with mock executor**

Create `apps/server/src/agent/session-manager.integration.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { validatePipelineConfig } from "../lib/config/schema.js";
import { buildPipelineStates } from "../machine/pipeline-builder.js";

describe("Single-session pipeline integration", () => {
  it("validates and builds a single-session pipeline", () => {
    const pipeline = {
      name: "Test Single Session",
      session_mode: "single",
      engine: "claude",
      stages: [
        {
          name: "analyze",
          type: "agent",
          runtime: { engine: "llm", system_prompt: "analyze", writes: ["analysis"] },
        },
        {
          name: "implement",
          type: "agent",
          runtime: {
            engine: "llm",
            system_prompt: "implement",
            writes: ["result"],
            reads: { analysis: "analysis" },
          },
        },
      ],
    };

    // Schema validation passes
    const validation = validatePipelineConfig(pipeline);
    expect(validation.success).toBe(true);

    // Pipeline states build without error
    const states = buildPipelineStates(pipeline as any);
    expect(states).toHaveProperty("analyze");
    expect(states).toHaveProperty("implement");
  });

  it("builds single-session parallel group as single invoke", () => {
    const pipeline = {
      name: "Test Parallel",
      session_mode: "single",
      engine: "claude",
      stages: [
        {
          parallel: {
            name: "gather",
            stages: [
              { name: "taskA", type: "agent", runtime: { engine: "llm", system_prompt: "do A", writes: ["a"] } },
              { name: "taskB", type: "agent", runtime: { engine: "llm", system_prompt: "do B", writes: ["b"] } },
            ],
          },
        },
        {
          name: "combine",
          type: "agent",
          runtime: { engine: "llm", system_prompt: "combine", writes: ["combined"], reads: { a: "a", b: "b" } },
        },
      ],
    };

    const states = buildPipelineStates(pipeline as any);
    expect(states).toHaveProperty("gather");
    // In single-session mode, parallel group is NOT type: "parallel"
    expect((states.gather as any).type).not.toBe("parallel");
    // It should have an invoke
    expect((states.gather as any).invoke).toBeDefined();
    expect((states.gather as any).invoke.src).toBe("runAgentSingleSession");
  });

  it("multi-session pipeline is unchanged", () => {
    const pipeline = {
      name: "Test Multi",
      stages: [
        { name: "s1", type: "agent", runtime: { engine: "llm", system_prompt: "test", writes: ["out"] } },
      ],
    };

    const states = buildPipelineStates(pipeline as any);
    expect(states).toHaveProperty("s1");
    // Default (no session_mode) should use runAgent, not runAgentSingleSession
    expect((states.s1 as any).invoke.src).not.toBe("runAgentSingleSession");
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd apps/server && npx vitest run src/agent/session-manager.integration.test.ts --reporter=verbose`
Expected: All 3 tests pass

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/agent/session-manager.integration.test.ts
git commit -m "test: add single-session pipeline integration tests"
```
