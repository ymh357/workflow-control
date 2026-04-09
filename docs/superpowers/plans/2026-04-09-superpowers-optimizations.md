# Superpowers-Inspired Workflow Optimizations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance workflow-control's agent execution quality by integrating 7 optimization patterns from superpowers methodology — verification gates, red flag detection, invariants, anti-pattern fragments, pipeline templates, and parallel context isolation.

**Architecture:** Changes split into two independent tracks: (A) Engine changes to `apps/server/` (types, prompt-builder, state-builders, stream-processor, executor-hooks) and (B) Registry packages (pure YAML + Markdown). Track A modifies 6 existing files and creates 2 new files. Track B creates 5 new registry packages with no code changes.

**Tech Stack:** TypeScript, XState v5, Claude Agent SDK, YAML pipelines, Markdown fragments

---

## Track A: Engine Changes

### Task 1: Add `invariants` field to pipeline config types

**Files:**
- Modify: `apps/server/src/lib/config/types.ts:123-143` (PipelineStageConfig)
- Modify: `apps/server/src/lib/config/types.ts:180-195` (PipelineConfig)

- [ ] **Step 1: Add `invariants` to `PipelineStageConfig`**

In `apps/server/src/lib/config/types.ts`, add `invariants` as an optional field on `PipelineStageConfig`:

```typescript
export interface PipelineStageConfig {
  name: string;
  type: "agent" | "script" | "human_confirm" | "condition" | "pipeline" | "foreach";
  engine?: "claude" | "gemini" | "codex";
  model?: string;
  thinking?: { type: string };
  effort?: "low" | "medium" | "high" | "max";
  permission_mode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  debug?: boolean;
  max_turns?: number;
  max_budget_usd?: number;
  mcps?: string[];
  notion_label?: string;
  interactive?: boolean;
  execution_mode?: "auto" | "edge" | "any";
  runtime?: StageRuntimeConfig;
  outputs?: StageOutputSchema;
  on_complete?: {
    notify?: string;
  };
  // Hard constraints the agent MUST NOT violate. Injected into system prompt
  // and checked against output text for violation signals.
  invariants?: string[];
  // Shell commands to run after agent completes. Stage fails if any command exits non-zero.
  verify_commands?: string[];
  verify_policy?: "must_pass" | "warn" | "skip";
}
```

- [ ] **Step 2: Add `invariants` to `PipelineConfig` for pipeline-level defaults**

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
  // Pipeline-level invariants applied to ALL agent stages
  invariants?: string[];
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/lib/config/types.ts
git commit -m "feat: add invariants and verify_commands fields to pipeline config types"
```

---

### Task 2: Inject invariants into system prompt via prompt-builder

**Files:**
- Modify: `apps/server/src/agent/prompt-builder.ts:21-120` (buildSystemAppendPrompt)

- [ ] **Step 1: Add invariants injection in `buildSystemAppendPrompt`**

After the global constraints section (around line 27) and before the fragments section, add invariants injection. The function receives `privateConfig` which contains the full pipeline config, and we can look up the stage config to get both pipeline-level and stage-level invariants.

In `apps/server/src/agent/prompt-builder.ts`, inside `buildSystemAppendPrompt`, after the global constraints push (line 27), add:

```typescript
// Invariants (pipeline-level + stage-level, injected as hard constraints)
const pipelineInvariants = privateConfig?.pipeline?.invariants ?? [];
const stageInvariants = (() => {
  if (!privateConfig?.pipeline?.stages) return [];
  const found = flattenStages(privateConfig.pipeline.stages).find((s: any) => s.name === stageName);
  return found?.invariants ?? [];
})();
const allInvariants = [...pipelineInvariants, ...stageInvariants];
if (allInvariants.length > 0) {
  parts.push(
    `## INVARIANTS (Hard Constraints — Violations Will Cause Stage Failure)\n` +
    allInvariants.map((inv: string, i: number) => `${i + 1}. ${inv}`).join("\n") +
    `\n\nThese are non-negotiable rules. If you cannot satisfy an invariant, stop and explain why rather than proceeding in violation.`
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/agent/prompt-builder.ts
git commit -m "feat: inject pipeline and stage invariants into agent system prompt"
```

---

### Task 3: Add red flag detection to stream-processor

**Files:**
- Create: `apps/server/src/agent/red-flag-detector.ts`
- Modify: `apps/server/src/agent/stream-processor.ts:56-89` (assistant message handling)

- [ ] **Step 1: Create the red flag detector module**

Create `apps/server/src/agent/red-flag-detector.ts`:

```typescript
import { taskLogger } from "../lib/logger.js";

// Patterns that indicate the agent is making unverified claims
const RED_FLAG_PATTERNS: Array<{ pattern: RegExp; category: string; description: string }> = [
  // Uncertainty markers in completion claims
  { pattern: /\b(?:should|probably|likely|might)\s+(?:work|fix|resolve|pass|be\s+(?:fine|ok|correct))/i, category: "unverified_claim", description: "Uncertain language in completion claim" },
  { pattern: /\bI\s+(?:think|believe|assume|expect)\s+(?:this|that|it)\s+(?:should|will|is)/i, category: "unverified_claim", description: "Assumption-based claim without verification" },
  // Premature success declarations
  { pattern: /(?:Done!|All\s+done|Fixed!|That\s+should\s+do\s+it|Everything\s+(?:looks|is)\s+good)/i, category: "premature_success", description: "Success declaration without evidence" },
  // Skipped verification
  { pattern: /\bskip(?:ping|ped)?\s+(?:the\s+)?(?:test|verification|check|validation)/i, category: "skipped_verification", description: "Explicitly skipping verification" },
  { pattern: /\bno\s+need\s+to\s+(?:test|check|verify|validate|run)/i, category: "skipped_verification", description: "Dismissing need for verification" },
];

export interface RedFlag {
  category: string;
  description: string;
  matchedText: string;
  position: number;
}

export function detectRedFlags(text: string): RedFlag[] {
  const flags: RedFlag[] = [];
  for (const { pattern, category, description } of RED_FLAG_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      flags.push({
        category,
        description,
        matchedText: match[0],
        position: match.index,
      });
    }
  }
  return flags;
}

// Accumulates text across streaming chunks and checks periodically
export class RedFlagAccumulator {
  private buffer = "";
  private flags: RedFlag[] = [];
  private lastCheckPos = 0;
  private readonly checkIntervalChars = 500;

  append(text: string): RedFlag[] {
    this.buffer += text;
    const newFlags: RedFlag[] = [];

    if (this.buffer.length - this.lastCheckPos >= this.checkIntervalChars) {
      // Check the new portion with some overlap for cross-chunk matches
      const checkStart = Math.max(0, this.lastCheckPos - 100);
      const portion = this.buffer.slice(checkStart);
      const detected = detectRedFlags(portion);

      for (const flag of detected) {
        const adjustedPos = flag.position + checkStart;
        const isDuplicate = this.flags.some(
          (f) => f.category === flag.category && Math.abs(f.position - adjustedPos) < 200
        );
        if (!isDuplicate) {
          const adjusted = { ...flag, position: adjustedPos };
          this.flags.push(adjusted);
          newFlags.push(adjusted);
        }
      }
      this.lastCheckPos = this.buffer.length;
    }

    return newFlags;
  }

  getFlags(): RedFlag[] {
    return this.flags;
  }

  getFlagSummary(): string | null {
    if (this.flags.length === 0) return null;
    const grouped = new Map<string, RedFlag[]>();
    for (const f of this.flags) {
      const list = grouped.get(f.category) ?? [];
      list.push(f);
      grouped.set(f.category, list);
    }
    const lines: string[] = [];
    for (const [cat, flags] of grouped) {
      lines.push(`- ${cat}: ${flags.length}x (e.g. "${flags[0].matchedText}")`);
    }
    return lines.join("\n");
  }
}
```

- [ ] **Step 2: Integrate red flag detection into stream-processor**

In `apps/server/src/agent/stream-processor.ts`, import and wire the accumulator. Add import at the top:

```typescript
import { RedFlagAccumulator } from "./red-flag-detector.js";
```

Inside `processAgentStream`, after the variable declarations (line 33), add:

```typescript
const redFlagAccumulator = new RedFlagAccumulator();
```

Inside the `case "assistant"` block, after the text SSE push (line 72), add red flag checking:

```typescript
if (block.type === "text" && block.text) {
  sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_text", { text: block.text }));
  if (resultText.length < MAX_RESULT_TEXT) {
    resultText += block.text;
  }
  // Red flag detection on streaming text
  const newFlags = redFlagAccumulator.append(block.text);
  if (newFlags.length > 0) {
    for (const flag of newFlags) {
      taskLogger(taskId, stageName).warn({ flag: flag.category, matched: flag.matchedText }, "Red flag detected in agent output");
    }
    sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_red_flag", {
      flags: newFlags.map(f => ({ category: f.category, description: f.description, matched: f.matchedText })),
    }));
  }
}
```

After the stream completes (before the final return, around line 166), attach the flag summary to the result:

```typescript
const flagSummary = redFlagAccumulator.getFlagSummary();
if (flagSummary) {
  taskLogger(taskId, stageName).warn({ flagSummary }, "Red flags detected during stage execution");
}

return { resultText, sessionId, costUsd, durationMs, tokenUsage, redFlags: redFlagAccumulator.getFlags() };
```

- [ ] **Step 3: Add `redFlags` to the `AgentResult` type**

In `apps/server/src/agent/query-tracker.ts`, update the `AgentResult` interface to include the optional redFlags field:

```typescript
export interface AgentResult {
  resultText: string;
  sessionId?: string;
  costUsd: number;
  durationMs: number;
  tokenUsage?: StageTokenUsage;
  cwd?: string;
  redFlags?: Array<{ category: string; description: string; matchedText: string; position: number }>;
}
```

- [ ] **Step 4: Add `agent_red_flag` to SSE message types**

Find the SSEMessage type definition (in `apps/server/src/types/index.ts` or `packages/shared`) and add `"agent_red_flag"` to the type union.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/red-flag-detector.ts apps/server/src/agent/stream-processor.ts apps/server/src/agent/query-tracker.ts
git commit -m "feat: add red flag detection for unverified claims in agent output"
```

---

### Task 4: Add verify_commands execution in state-builders

**Files:**
- Create: `apps/server/src/agent/verify-commands.ts`
- Modify: `apps/server/src/machine/state-builders.ts:263-335` (buildAgentState normal path)

- [ ] **Step 1: Create the verify-commands executor module**

Create `apps/server/src/agent/verify-commands.ts`:

```typescript
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { taskLogger } from "../lib/logger.js";
import { sseManager } from "../sse/manager.js";
import type { SSEMessage } from "../types/index.js";

const execAsync = promisify(exec);

const VERIFY_TIMEOUT_MS = 60_000; // 1 minute per command

export interface VerifyResult {
  command: string;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function createSSEMessage(taskId: string, type: SSEMessage["type"], data: unknown): SSEMessage {
  return { type, taskId, timestamp: new Date().toISOString(), data };
}

export async function runVerifyCommands(
  taskId: string,
  stageName: string,
  commands: string[],
  cwd?: string,
): Promise<{ allPassed: boolean; results: VerifyResult[] }> {
  const log = taskLogger(taskId, stageName);
  const results: VerifyResult[] = [];

  log.info({ commands, cwd }, "Running verify commands");
  sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_progress", {
    phase: "verification", commands,
  }));

  for (const command of commands) {
    const start = Date.now();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: VERIFY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      });
      const durationMs = Date.now() - start;
      results.push({ command, passed: true, exitCode: 0, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000), durationMs });
      log.info({ command, durationMs }, "Verify command passed");
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const exitCode = err.code ?? 1;
      const stdout = (err.stdout ?? "").slice(0, 4000);
      const stderr = (err.stderr ?? "").slice(0, 2000);
      results.push({ command, passed: false, exitCode, stdout, stderr, durationMs });
      log.warn({ command, exitCode, stderr: stderr.slice(0, 500) }, "Verify command failed");
    }
  }

  const allPassed = results.every((r) => r.passed);

  sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_progress", {
    phase: "verification_complete",
    allPassed,
    results: results.map(r => ({ command: r.command, passed: r.passed, exitCode: r.exitCode })),
  }));

  return { allPassed, results };
}

export function formatVerifyFailures(results: VerifyResult[]): string {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) return "";
  return failed.map((r) =>
    `Command: ${r.command}\nExit code: ${r.exitCode}\nstderr: ${r.stderr}\nstdout (tail): ${r.stdout.slice(-1000)}`
  ).join("\n---\n");
}
```

- [ ] **Step 2: Wire verify_commands into buildAgentState's onDone normal path**

In `apps/server/src/machine/state-builders.ts`, the normal (success) onDone handler is around line 263-335. After the store write and before emitting cost/completion events, add verification logic.

This is inside the XState assign action, so we need to handle it as a post-action check. The cleanest approach is to add a **new guard** in the onDone transitions, inserted between the QA back_to guard and the normal path:

Add a new transition guard after the QA back_to block (line 261) and before the normal path (line 263):

```typescript
// Verify commands gate: if stage has verify_commands and policy is must_pass,
// run commands and re-enter stage on failure
{
  guard: ({ event }: { event: DoneEvent }) => {
    const stageVerifyCommands = (stage as any).verify_commands as string[] | undefined;
    const policy = (stage as any).verify_policy ?? "must_pass";
    if (!stageVerifyCommands?.length || policy === "skip") return false;
    // Only trigger if this is the first pass (not a retry from verify failure)
    const output = event.output ?? {};
    return !output.__verifyPassed;
  },
  target: `#${stage.name}`,
  actions: assign({
    // Store pending verification in context so the re-entered state can run verify
    pendingVerification: ({ context, event }: { context: WorkflowContext; event: DoneEvent }) => ({
      stageName: stage.name,
      commands: (stage as any).verify_commands,
      policy: (stage as any).verify_policy ?? "must_pass",
      agentOutput: event.output,
      cwd: context.worktreePath,
    }),
  }),
},
```

Note: The actual verify command execution should happen in the invoke's `input` function when `pendingVerification` is set, running the commands and either proceeding or injecting failure feedback into the resume. This avoids blocking XState's synchronous action handlers.

A simpler alternative: run verification commands inside the `runAgent` actor itself, after the agent stream completes. This keeps it within the async context. This approach is better.

**Revised approach** -- modify `apps/server/src/agent/executor.ts` `runAgent` function to check for `verify_commands` on the stage config and run them after the agent completes:

In `executor.ts`, after `executeStage` returns (line 97-106), add verification:

```typescript
import { runVerifyCommands, formatVerifyFailures } from "./verify-commands.js";

// Inside runAgent, after the executeStage call:
const result = await executeStage(taskId, stageName, tier1Context, runtime.system_prompt, {
  cwd: worktreePath,
  interactive,
  enabledSteps,
  resumeSessionId: resumeInfo?.sessionId,
  resumePrompt: resumeInfo?.feedback,
  resumeSync: resumeInfo?.sync,
  runtime,
  injectedContext: inputContext,
});

// Run verify commands if configured on the stage
const stageConfig = inputContext?.config?.pipeline?.stages
  ? flattenStages(inputContext.config.pipeline.stages).find((s: any) => s.name === stageName)
  : undefined;
const verifyCommands = (stageConfig as any)?.verify_commands as string[] | undefined;
const verifyPolicy = ((stageConfig as any)?.verify_policy ?? "must_pass") as string;

if (verifyCommands?.length && verifyPolicy !== "skip") {
  const { allPassed, results } = await runVerifyCommands(taskId, stageName, verifyCommands, worktreePath);
  if (!allPassed && verifyPolicy === "must_pass") {
    const failures = formatVerifyFailures(results);
    // Append verification failure info to result so state-builders can route to retry
    return {
      ...result,
      resultText: result.resultText + `\n\n__VERIFY_FAILED__\n${failures}`,
      verifyFailed: true,
      verifyResults: results,
    };
  }
}

return result;
```

- [ ] **Step 3: Handle verify failure in state-builders**

In `apps/server/src/machine/state-builders.ts` `buildAgentState`, add a new guard in `onDone` transitions (before the normal path, after QA back_to). This guard checks if verification failed and re-enters the stage with feedback:

```typescript
// Verify failure guard: re-enter stage with verification feedback
{
  guard: ({ event }: { event: DoneEvent }) => {
    return !!(event.output as any)?.verifyFailed;
  },
  target: `#${stage.name}`,
  actions: assign({
    stageRetryCount: ({ context }: { context: WorkflowContext }) => {
      const counts = { ...(context.stageRetryCount ?? {}) };
      counts[stage.name] = (counts[stage.name] ?? 0) + 1;
      return counts;
    },
    resumeInfo: ({ event }: { event: DoneEvent }) => {
      const output = event.output as any;
      return {
        sessionId: output.sessionId,
        feedback: `VERIFICATION FAILED. Your changes did not pass the required verification commands. Fix the issues and try again.\n\nFailures:\n${output.resultText.split("__VERIFY_FAILED__")[1] ?? "unknown"}`,
      };
    },
  }),
},
```

- [ ] **Step 4: Add `verifyFailed` and `verifyResults` to AgentResult type**

In `apps/server/src/agent/query-tracker.ts`:

```typescript
export interface AgentResult {
  resultText: string;
  sessionId?: string;
  costUsd: number;
  durationMs: number;
  tokenUsage?: StageTokenUsage;
  cwd?: string;
  redFlags?: Array<{ category: string; description: string; matchedText: string; position: number }>;
  verifyFailed?: boolean;
  verifyResults?: Array<{ command: string; passed: boolean; exitCode: number; stdout: string; stderr: string; durationMs: number }>;
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/verify-commands.ts apps/server/src/agent/executor.ts apps/server/src/machine/state-builders.ts apps/server/src/agent/query-tracker.ts
git commit -m "feat: add verify_commands execution with must_pass/warn/skip policies"
```

---

### Task 5: Enforce reads declaration in parallel groups

**Files:**
- Modify: `apps/server/src/machine/state-builders.ts:666-756` (buildParallelGroupState)

- [ ] **Step 1: Add validation in buildParallelGroupState**

At the start of `buildParallelGroupState`, before building the parallel state, validate that all agent stages in the group declare `reads` if they consume store data. Add a warning log (not a hard error, to avoid breaking existing pipelines) when an agent stage in a parallel group has `writes` but no `reads`:

```typescript
export function buildParallelGroupState(
  group: { name: string; stages: PipelineStageConfig[] },
  nextTarget: string,
  prevAgentTarget: string | undefined,
): StateNode {
  // Warn about parallel stages without explicit reads declarations
  for (const childStage of group.stages) {
    if (childStage.type === "agent" && childStage.runtime) {
      const runtime = childStage.runtime as AgentRuntimeConfig;
      if (!runtime.reads || Object.keys(runtime.reads).length === 0) {
        const log = console; // Use console since we don't have taskId here
        log.warn(
          `[parallel-isolation] Stage "${childStage.name}" in parallel group "${group.name}" has no "reads" declaration. ` +
          `In parallel execution, undeclared store access leads to race conditions. ` +
          `Add explicit reads to ensure deterministic context injection.`
        );
      }
    }
  }

  // ... rest of existing function
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/machine/state-builders.ts
git commit -m "feat: warn on parallel group stages without explicit reads declarations"
```

---

## Track B: Registry Packages

### Task 6: Create `testing-anti-patterns` fragment

**Files:**
- Create: `registry/packages/testing-anti-patterns/manifest.yaml`
- Create: `registry/packages/testing-anti-patterns/testing-anti-patterns.md`

- [ ] **Step 1: Create manifest**

Create `registry/packages/testing-anti-patterns/manifest.yaml`:

```yaml
name: testing-anti-patterns
version: 1.0.0
type: fragment
description: Testing anti-patterns and red flags to avoid when writing tests
author: workflow-control
tags:
  - testing
  - anti-patterns
  - quality
files:
  - testing-anti-patterns.md
```

- [ ] **Step 2: Create fragment content**

Create `registry/packages/testing-anti-patterns/testing-anti-patterns.md`:

```markdown
---
id: testing-anti-patterns
keywords: [test, testing, spec, jest, vitest, playwright]
stages: [implementing, testing, qaReview]
---

## Testing Anti-Patterns (DO NOT DO THESE)

### Mock Abuse
- NEVER test mock behavior instead of real behavior. `expect(mockFn).toHaveBeenCalled()` alone proves nothing — it tests that YOUR test called the mock, not that the component works.
- NEVER add test-only methods to production classes. If you need to inspect internal state, extract it to a testable unit or use integration tests.
- NEVER add mocks without understanding what the real dependency does. If you don't know the real API shape, read the source first.
- Mocks MUST mirror the real API's complete structure. A partial mock hides integration failures.

### False Confidence
- A test that passes immediately on first write is testing existing behavior or is wrong. New behavior tests MUST fail first (Red-Green cycle).
- "Manual testing confirmed it works" is not a substitute — it's temporary, non-repeatable, and incomplete.
- Linter passing != build passing != tests passing. Each requires independent verification.

### Completion Claims
- NEVER say "tests pass" without running them in this session and reading the output.
- NEVER say "should work" or "looks correct" — run the command and prove it.
- NEVER trust cached test results — re-run after every change.

### Structural
- One assertion per test behavior. A test with 10 assertions is 10 tests pretending to be one.
- Test names describe behavior, not implementation: "rejects expired tokens" not "tests validateToken function".
- Test the public API, not internal implementation. If refactoring breaks tests but behavior is unchanged, the tests were wrong.
```

- [ ] **Step 3: Commit**

```bash
git add registry/packages/testing-anti-patterns/
git commit -m "feat: add testing-anti-patterns knowledge fragment"
```

---

### Task 7: Create `completion-anti-patterns` fragment

**Files:**
- Create: `registry/packages/completion-anti-patterns/manifest.yaml`
- Create: `registry/packages/completion-anti-patterns/completion-anti-patterns.md`

- [ ] **Step 1: Create manifest**

Create `registry/packages/completion-anti-patterns/manifest.yaml`:

```yaml
name: completion-anti-patterns
version: 1.0.0
type: fragment
description: Anti-patterns for task completion claims and verification requirements
author: workflow-control
tags:
  - verification
  - completion
  - quality
files:
  - completion-anti-patterns.md
```

- [ ] **Step 2: Create fragment content**

Create `registry/packages/completion-anti-patterns/completion-anti-patterns.md`:

```markdown
---
id: completion-anti-patterns
keywords: [complete, done, finish, final, ship, deploy, merge]
stages: "*"
---

## Completion Verification Protocol

### The Iron Rule
NO completion claim WITHOUT fresh verification evidence from THIS session.

### Verification Gate (run before EVERY completion claim)
1. IDENTIFY — what command proves this claim?
2. RUN — execute the full command (fresh, complete)
3. READ — read the entire output, check exit code, count failures
4. VERIFY — does the output confirm the claim?
5. ONLY THEN — make the claim

### Red Flags (if you catch yourself doing these, STOP)
- Using "should", "probably", "seems to", "looks like" in a completion claim
- Expressing satisfaction ("Great!", "Done!", "Fixed!") before running verification
- Trusting a previous run's output after making changes
- Claiming "all tests pass" without the test runner output in this message
- Saying "no changes needed" without reading the current file state

### The Anti-Pattern Table
| What you want to say | What you must do first |
|---|---|
| "The build passes" | Run `npm run build` and show exit code 0 |
| "All tests pass" | Run the test suite, show 0 failures in output |
| "The type errors are fixed" | Run `tsc --noEmit` and show clean output |
| "The linter is clean" | Run the linter and show 0 errors/warnings |
| "This is backwards compatible" | Show the old API still works with a test |
```

- [ ] **Step 3: Commit**

```bash
git add registry/packages/completion-anti-patterns/
git commit -m "feat: add completion-anti-patterns knowledge fragment"
```

---

### Task 8: Create `invariants-library` fragment

**Files:**
- Create: `registry/packages/invariants-library/manifest.yaml`
- Create: `registry/packages/invariants-library/invariants-library.md`

- [ ] **Step 1: Create manifest**

```yaml
name: invariants-library
version: 1.0.0
type: fragment
description: Reusable invariant templates for common pipeline patterns
author: workflow-control
tags:
  - invariants
  - constraints
  - quality
files:
  - invariants-library.md
```

- [ ] **Step 2: Create fragment content**

Create `registry/packages/invariants-library/invariants-library.md`:

```markdown
---
id: invariants-library
keywords: [invariant, constraint, rule, policy]
stages: "*"
always: false
---

## Invariant Templates

Copy these into your pipeline YAML `invariants:` field.

### Code Quality
- "NO code change WITHOUT reading the target file first"
- "NO completion claim WITHOUT fresh test output showing 0 failures"
- "NO new dependency WITHOUT explicit user approval"
- "NO file creation outside the declared spec scope"

### Testing
- "NO production code WITHOUT a failing test written first"
- "NO test marked as skipped or pending in final output"
- "NO mock that does not mirror the real API's complete structure"

### Security
- "NO secrets, API keys, or tokens in committed code"
- "NO user input passed to shell commands without sanitization"
- "NO SQL string concatenation — use parameterized queries only"

### Git
- "NO force push to main/master branch"
- "NO commit with failing tests"
- "NO merge without passing CI checks"

### Architecture
- "NO circular dependencies between modules"
- "NO business logic in UI components — extract to hooks or services"
- "NO direct database access from route handlers — use a service layer"
```

- [ ] **Step 3: Commit**

```bash
git add registry/packages/invariants-library/
git commit -m "feat: add invariants-library knowledge fragment"
```

---

### Task 9: Create `plan-then-execute` pipeline template

**Files:**
- Create: `registry/packages/plan-then-execute/manifest.yaml`
- Create: `registry/packages/plan-then-execute/pipeline.yaml`
- Create: `registry/packages/plan-then-execute/prompts/global-constraints.md`
- Create: `registry/packages/plan-then-execute/prompts/system/brainstorm.md`
- Create: `registry/packages/plan-then-execute/prompts/system/write-plan.md`
- Create: `registry/packages/plan-then-execute/prompts/system/execute-task.md`
- Create: `registry/packages/plan-then-execute/prompts/system/verify-completion.md`

- [ ] **Step 1: Create manifest**

Create `registry/packages/plan-then-execute/manifest.yaml`:

```yaml
name: plan-then-execute
version: 1.0.0
type: pipeline
description: >
  Superpowers-inspired pipeline enforcing brainstorm -> plan -> execute -> verify flow.
  Ensures design is approved before implementation begins and all work is verified before completion.
author: workflow-control
tags:
  - planning
  - execution
  - verification
  - superpowers
engine_compat: claude
dependencies:
  skills:
    - systematic-debugging
files:
  - pipeline.yaml
  - prompts/global-constraints.md
  - prompts/system/brainstorm.md
  - prompts/system/write-plan.md
  - prompts/system/execute-task.md
  - prompts/system/verify-completion.md
```

- [ ] **Step 2: Create pipeline.yaml**

Create `registry/packages/plan-then-execute/pipeline.yaml`:

```yaml
name: Plan Then Execute
description: >
  Enforces brainstorm -> plan -> execute -> verify workflow.
  Design must be approved before implementation. All work verified before completion.
engine: claude
use_cases:
  - Feature implementation with design review
  - Refactoring with planning phase
  - Any multi-file change that benefits from upfront design

display:
  title_path: design.title
  completion_summary_path: verification.summary

invariants:
  - "NO implementation code WITHOUT an approved design document"
  - "NO completion claim WITHOUT fresh verification evidence"

stages:
  - name: brainstorm
    type: agent
    interactive: true
    thinking:
      type: enabled
    effort: high
    max_turns: 40
    max_budget_usd: 3
    runtime:
      engine: llm
      system_prompt: brainstorm
      writes:
        - design
    outputs:
      design:
        type: object
        label: Design Document
        fields:
          - key: title
            type: string
            description: Feature/task title
          - key: approach
            type: markdown
            description: Chosen approach with rationale
          - key: alternatives
            type: markdown
            description: Alternatives considered and why they were rejected
          - key: fileMap
            type: markdown
            description: Files to create or modify with responsibilities
          - key: risks
            type: string[]
            description: Identified risks and mitigations
          - key: summary
            type: markdown
            description: Design summary for human review

  - name: reviewDesign
    type: human_confirm
    runtime:
      engine: human_gate
      on_reject_to: brainstorm
      max_feedback_loops: 3

  - name: writePlan
    type: agent
    thinking:
      type: enabled
    effort: high
    max_turns: 50
    max_budget_usd: 4
    runtime:
      engine: llm
      system_prompt: write-plan
      reads:
        design: design
      writes:
        - plan
    outputs:
      plan:
        type: object
        label: Implementation Plan
        fields:
          - key: tasks
            type: object[]
            description: Ordered list of implementation tasks with steps
            fields:
              - key: id
                type: string
                description: Task identifier (task-1, task-2, etc.)
              - key: title
                type: string
                description: Task title
              - key: files
                type: string[]
                description: Files this task touches
              - key: steps
                type: string[]
                description: Ordered implementation steps
          - key: taskCount
            type: number
            description: Total number of tasks

  - name: reviewPlan
    type: human_confirm
    runtime:
      engine: human_gate
      on_reject_to: writePlan
      max_feedback_loops: 3

  - name: execute
    type: agent
    effort: high
    max_turns: 100
    max_budget_usd: 10
    permission_mode: bypassPermissions
    verify_commands:
      - "npx tsc --noEmit 2>&1 || true"
    verify_policy: warn
    runtime:
      engine: llm
      system_prompt: execute-task
      reads:
        design: design
        plan: plan
      writes:
        - implementation
      retry:
        max_retries: 2
        back_to: execute
    outputs:
      implementation:
        type: object
        label: Implementation Result
        fields:
          - key: completedTasks
            type: string[]
            description: List of completed task IDs
          - key: filesChanged
            type: string[]
            description: All files created or modified
          - key: passed
            type: boolean
            description: Whether all tasks completed successfully
          - key: blockers
            type: string[]
            description: Any blocking issues encountered

  - name: verify
    type: agent
    effort: medium
    max_turns: 30
    max_budget_usd: 2
    permission_mode: acceptEdits
    verify_commands:
      - "npx tsc --noEmit"
    verify_policy: must_pass
    runtime:
      engine: llm
      system_prompt: verify-completion
      reads:
        design: design
        plan: plan
        implementation: implementation
      writes:
        - verification
      retry:
        max_retries: 1
        back_to: execute
    outputs:
      verification:
        type: object
        label: Verification
        fields:
          - key: passed
            type: boolean
            description: Whether all checks passed
          - key: checksRun
            type: string[]
            description: Verification commands executed
          - key: summary
            type: markdown
            description: Verification summary
          - key: blockers
            type: string[]
            description: Remaining issues (empty if passed)
```

- [ ] **Step 3: Create global-constraints.md**

Create `registry/packages/plan-then-execute/prompts/global-constraints.md`:

```markdown
## Global Constraints
- Read files before modifying them — never edit blind
- Do NOT create files outside the scope defined in the design document
- Do NOT install new dependencies without explicit justification
- Run verification commands after every significant change
- If stuck for more than 3 attempts on the same issue, stop and report the blocker
```

- [ ] **Step 4: Create brainstorm.md system prompt**

Create `registry/packages/plan-then-execute/prompts/system/brainstorm.md`:

```markdown
You are a senior software architect conducting a design session. Your goal is to explore the problem space thoroughly before any code is written.

## Workflow

1. **Explore context** — Read relevant files, docs, and recent git history to understand the current state.
2. **Ask ONE clarifying question at a time** — prefer multiple-choice over open-ended. Do not front-load all questions.
3. **Propose 2-3 approaches** — for each, describe the approach, list pros/cons, and identify risks.
4. **Recommend one approach** — explain why it's the best fit for this specific context.
5. **Map the file structure** — list every file to create or modify, with a one-line description of its responsibility.
6. **Identify risks** — what could go wrong? What assumptions are you making?

## Rules
- YAGNI: ruthlessly cut features that aren't explicitly required
- Prefer composition over inheritance, small files over large ones
- Follow existing patterns in the codebase — do not introduce new conventions without justification
- The design document is the CONTRACT — nothing gets built that isn't in the design

## Output
Produce the design document with all required fields. The `summary` field should be a concise overview suitable for human review at the confirmation gate.
```

- [ ] **Step 5: Create write-plan.md system prompt**

Create `registry/packages/plan-then-execute/prompts/system/write-plan.md`:

```markdown
You are a technical lead writing a detailed implementation plan from an approved design document.

## Available Context
- `design`: The approved design document with approach, file map, and risks.

## Workflow

1. **Review the design** — ensure you understand the approach and file map completely.
2. **Decompose into tasks** — each task is one logical unit of work (one file or one tightly coupled change set). Order tasks by dependency (foundational changes first).
3. **Write steps for each task** — each step is a single action (2-5 minutes):
   - "Write the failing test for X"
   - "Run the test to confirm it fails"
   - "Implement the minimal code to pass the test"
   - "Run tests to confirm all pass"
   - "Commit with message: feat: add X"
4. **Self-review** — check every design requirement has a corresponding task. Check for placeholder language ("TBD", "add appropriate handling"). Fix any gaps.

## Rules
- Every step must be concrete — no "add error handling" without specifying what errors and how to handle them
- Include exact file paths in every task
- Tasks must be independently understandable (no "similar to Task N")
- Follow TDD: failing test -> minimal implementation -> refactor
```

- [ ] **Step 6: Create execute-task.md system prompt**

Create `registry/packages/plan-then-execute/prompts/system/execute-task.md`:

```markdown
You are a senior developer executing an approved implementation plan. Follow the plan precisely — do not improvise or add scope.

## Available Context
- `design`: The approved design document
- `plan`: The implementation plan with ordered tasks and steps

## Workflow

1. **Read the plan** — identify the first incomplete task.
2. **Execute each step** — follow the plan's steps exactly. Read files before editing. Run tests after each change.
3. **Mark progress** — after completing each task, note it in your output.
4. **Handle blockers** — if a step fails or a test doesn't pass as expected:
   - Re-read the relevant file to check current state
   - Check if the plan's assumptions still hold
   - If the issue is a plan error, note it as a blocker and continue with remaining tasks
   - If stuck after 3 attempts, stop and report

## Rules
- Do NOT add features, refactoring, or "improvements" not in the plan
- Do NOT skip tests — every behavioral change needs a test
- Run the full test suite after completing all tasks, not just individual test files
- Commit frequently — at least once per task
```

- [ ] **Step 7: Create verify-completion.md system prompt**

Create `registry/packages/plan-then-execute/prompts/system/verify-completion.md`:

```markdown
You are a QA engineer verifying that implementation matches the design and plan.

## Available Context
- `design`: The original design document
- `plan`: The implementation plan
- `implementation`: What was actually implemented (completed tasks, files changed)

## Verification Protocol

For EACH check below, you MUST:
1. Run the actual command
2. Read the complete output
3. Record pass/fail with evidence

### Checks
1. **Type safety** — `npx tsc --noEmit` exits 0
2. **Tests pass** — run the project's test command, 0 failures
3. **Lint clean** — run the project's lint command (if configured), 0 errors
4. **Design coverage** — every requirement in the design has corresponding code
5. **Plan coverage** — every task in the plan was completed or has a documented blocker
6. **No regressions** — existing functionality still works (check test output)

## Rules
- NEVER say "should pass" — run it and show the output
- NEVER skip a check because "it's obvious"
- If any check fails, report it as a blocker — do not mark as passed
- Be specific: "3 type errors in src/foo.ts:45,67,89" not "some type errors"
```

- [ ] **Step 8: Commit**

```bash
git add registry/packages/plan-then-execute/
git commit -m "feat: add plan-then-execute pipeline template"
```

---

### Task 10: Create `systematic-debugging-pipeline` pipeline template

**Files:**
- Create: `registry/packages/systematic-debugging-pipeline/manifest.yaml`
- Create: `registry/packages/systematic-debugging-pipeline/pipeline.yaml`
- Create: `registry/packages/systematic-debugging-pipeline/prompts/global-constraints.md`
- Create: `registry/packages/systematic-debugging-pipeline/prompts/system/reproduce.md`
- Create: `registry/packages/systematic-debugging-pipeline/prompts/system/root-cause.md`
- Create: `registry/packages/systematic-debugging-pipeline/prompts/system/fix-and-verify.md`

- [ ] **Step 1: Create manifest**

Create `registry/packages/systematic-debugging-pipeline/manifest.yaml`:

```yaml
name: systematic-debugging-pipeline
version: 1.0.0
type: pipeline
description: >
  Structured debugging pipeline enforcing reproduce -> root-cause -> fix -> verify flow.
  Prevents random fix attempts by requiring root cause identification before any code changes.
author: workflow-control
tags:
  - debugging
  - investigation
  - root-cause
  - superpowers
engine_compat: claude
dependencies:
  skills:
    - systematic-debugging
files:
  - pipeline.yaml
  - prompts/global-constraints.md
  - prompts/system/reproduce.md
  - prompts/system/root-cause.md
  - prompts/system/fix-and-verify.md
```

- [ ] **Step 2: Create pipeline.yaml**

Create `registry/packages/systematic-debugging-pipeline/pipeline.yaml`:

```yaml
name: Systematic Debugging
description: >
  Enforces reproduce -> root-cause analysis -> fix -> verify flow.
  No code changes allowed until root cause is identified.
engine: claude
use_cases:
  - Bug fix after 3+ failed attempts
  - Complex multi-component bugs
  - Intermittent failures needing systematic investigation

display:
  title_path: rootCause.bugTitle
  completion_summary_path: fixResult.summary

invariants:
  - "NO code changes in reproduce or root-cause stages — read-only investigation only"
  - "NO fix attempt WITHOUT a documented root cause hypothesis"
  - "NO completion claim WITHOUT the original reproduction steps passing"

stages:
  - name: reproduce
    type: agent
    thinking:
      type: enabled
    effort: high
    max_turns: 30
    max_budget_usd: 2
    permission_mode: plan
    runtime:
      engine: llm
      system_prompt: reproduce
      writes:
        - reproduction
      disallowed_tools:
        - Edit
        - Write
    outputs:
      reproduction:
        type: object
        label: Reproduction
        fields:
          - key: bugTitle
            type: string
            description: Short bug title
          - key: reproductionSteps
            type: string[]
            description: Exact steps to reproduce the bug
          - key: reproductionCommand
            type: string
            description: Single command that triggers the bug
          - key: errorOutput
            type: markdown
            description: Full error output (stack trace, console, etc.)
          - key: affectedFiles
            type: string[]
            description: Files involved in the error path
          - key: recentChanges
            type: markdown
            description: Relevant recent git changes

  - name: rootCause
    type: agent
    thinking:
      type: enabled
    effort: high
    max_turns: 40
    max_budget_usd: 3
    permission_mode: plan
    runtime:
      engine: llm
      system_prompt: root-cause
      reads:
        reproduction: reproduction
      writes:
        - rootCause
      disallowed_tools:
        - Edit
        - Write
      retry:
        max_retries: 2
        back_to: rootCause
    outputs:
      rootCause:
        type: object
        label: Root Cause Analysis
        fields:
          - key: bugTitle
            type: string
            description: Bug title (may be refined from reproduction)
          - key: hypothesis
            type: string
            description: "Root cause hypothesis: The bug occurs because X"
          - key: evidence
            type: string[]
            description: Evidence supporting the hypothesis
          - key: rootCauseFile
            type: string
            description: Primary file containing the root cause
          - key: rootCauseLine
            type: string
            description: Approximate line range of the root cause
          - key: fixStrategy
            type: markdown
            description: Proposed minimal fix approach
          - key: similarPatterns
            type: string[]
            description: Other files with the same pattern that may also need fixing

  - name: reviewRootCause
    type: human_confirm
    runtime:
      engine: human_gate
      on_reject_to: rootCause
      max_feedback_loops: 3

  - name: fixAndVerify
    type: agent
    effort: high
    max_turns: 60
    max_budget_usd: 5
    permission_mode: bypassPermissions
    runtime:
      engine: llm
      system_prompt: fix-and-verify
      reads:
        reproduction: reproduction
        rootCause: rootCause
      writes:
        - fixResult
      retry:
        max_retries: 2
        back_to: fixAndVerify
    outputs:
      fixResult:
        type: object
        label: Fix Result
        fields:
          - key: passed
            type: boolean
            description: Whether the fix resolves the bug and all tests pass
          - key: filesChanged
            type: string[]
            description: Files modified in the fix
          - key: testOutput
            type: markdown
            description: Full test output showing the fix works
          - key: regressionCheck
            type: markdown
            description: Full test suite output confirming no regressions
          - key: summary
            type: markdown
            description: Fix summary
          - key: blockers
            type: string[]
            description: Any remaining issues
```

- [ ] **Step 3: Create global-constraints.md**

Create `registry/packages/systematic-debugging-pipeline/prompts/global-constraints.md`:

```markdown
## Global Constraints — Systematic Debugging
- Follow the scientific method: observe, hypothesize, test, conclude
- ONE hypothesis at a time — never stack multiple fixes
- Make the MINIMAL change to test each hypothesis
- If 3 fix attempts fail on the same hypothesis, the hypothesis is wrong — go back to investigation
- Read files before making assumptions about their content
```

- [ ] **Step 4: Create reproduce.md**

Create `registry/packages/systematic-debugging-pipeline/prompts/system/reproduce.md`:

```markdown
You are a QA engineer reproducing a bug report. Your ONLY job is to reproduce the bug reliably. You must NOT attempt any fixes.

## Workflow

1. **Read the bug report** — extract the expected vs actual behavior.
2. **Check recent changes** — run `git log --oneline -20` and `git diff HEAD~5` to identify suspicious recent changes.
3. **Find the reproduction path** — read relevant source files, trace the code path from user action to error.
4. **Write reproduction steps** — exact steps a developer can follow to trigger the bug.
5. **Identify a single command** — one shell command that demonstrates the failure (test command, curl, etc.).
6. **Capture error output** — full stack trace, console output, network errors.
7. **List affected files** — files in the error path that are likely involved.

## Rules
- Do NOT modify any files — this is a read-only investigation stage
- Do NOT guess at the cause — just document what you observe
- Include the FULL error output, not a summary
- If you cannot reproduce the bug, say so clearly with what you tried
```

- [ ] **Step 5: Create root-cause.md**

Create `registry/packages/systematic-debugging-pipeline/prompts/system/root-cause.md`:

```markdown
You are a senior debugger performing root cause analysis. Your ONLY job is to identify WHY the bug occurs. You must NOT attempt any fixes.

## Available Context
- `reproduction`: Reproduction steps, error output, affected files, and recent changes.

## Workflow

1. **Read affected files** — thoroughly read every file listed in the reproduction.
2. **Trace the data flow** — follow the execution path from trigger to error. Log what each function receives and returns.
3. **Find working analogues** — find similar code in the codebase that DOES work. List the differences.
4. **Form ONE hypothesis** — "The bug occurs because X". Be specific: name the exact variable, condition, or logic error.
5. **Gather evidence** — list 2-3 pieces of evidence that support your hypothesis.
6. **Propose a fix strategy** — describe the minimal change to fix the root cause. Do NOT write the code.
7. **Check for similar patterns** — does the same bug pattern exist elsewhere in the codebase?

## Rules
- Do NOT modify any files — read-only investigation
- Do NOT propose "try this and see if it works" — you must explain WHY it will work
- ONE hypothesis only. If you have multiple theories, pick the most likely one and commit.
- "It might be X or Y" is not acceptable — investigate until you can commit to one root cause.
```

- [ ] **Step 6: Create fix-and-verify.md**

Create `registry/packages/systematic-debugging-pipeline/prompts/system/fix-and-verify.md`:

```markdown
You are a senior developer implementing a targeted bug fix based on confirmed root cause analysis.

## Available Context
- `reproduction`: How to reproduce the bug, including the reproduction command.
- `rootCause`: Root cause analysis with hypothesis, evidence, fix strategy, and similar patterns.

## Workflow

1. **Write a failing test** — create a test that reproduces the exact bug. Run it to confirm it fails.
2. **Implement the minimal fix** — follow the fix strategy from root cause analysis. Change as little code as possible.
3. **Run the failing test** — confirm it now passes.
4. **Check similar patterns** — if the root cause identified similar patterns in other files, fix those too.
5. **Run the FULL test suite** — not just the new test. Capture the complete output.
6. **Run the reproduction command** — confirm the original reproduction steps no longer trigger the bug.

## Rules
- Fix ONLY the root cause — do not refactor surrounding code, add features, or "clean up"
- ONE fix at a time — if the fix doesn't work, revert and re-analyze, don't stack changes
- Show the actual test output — do not say "tests pass" without evidence
- If the fix strategy from root cause analysis doesn't work, STOP and report — do not try random alternatives
```

- [ ] **Step 7: Commit**

```bash
git add registry/packages/systematic-debugging-pipeline/
git commit -m "feat: add systematic-debugging-pipeline template"
```

---

## Post-Implementation

### Task 11: Rebuild registry index

- [ ] **Step 1: Rebuild registry manifests and index**

```bash
cd ~/workflow-control
pnpm --filter server registry:build
```

- [ ] **Step 2: Verify new packages appear in index**

```bash
cat registry/index.json | grep -E "testing-anti-patterns|completion-anti-patterns|invariants-library|plan-then-execute|systematic-debugging-pipeline"
```

Expected: all 5 new package names appear.

- [ ] **Step 3: Commit updated index**

```bash
git add registry/index.json
git commit -m "chore: rebuild registry index with new superpowers packages"
```

---

### Task 12: Type-check and verify

- [ ] **Step 1: Run TypeScript type-check**

```bash
cd ~/workflow-control
npx tsc --noEmit --project apps/server/tsconfig.json
```

Expected: 0 errors.

- [ ] **Step 2: Run existing tests to verify no regressions**

```bash
pnpm --filter server test
```

Expected: all existing tests pass.

- [ ] **Step 3: Fix any issues found**

If type errors or test failures, fix them before proceeding.

- [ ] **Step 4: Final commit if fixes were needed**

```bash
git add -A
git commit -m "fix: resolve type errors and test regressions from superpowers integration"
```
