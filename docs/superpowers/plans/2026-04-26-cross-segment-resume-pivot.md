# Cross-Segment Resume Pivot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cross-segment SDK session resume opt-in via a new IR field `AgentStage.config.cross_segment_resume_from`, removing the current default of automatic wire-walked resume.

**Architecture:** Add an optional string field to `AgentStageSchema`, validate it against pipeline structure, replace the unconditional Phase 2 fallback in `segmentContinuationFor` with a check against the new field, rewrite the two tests that encode the old default, mark the original 2026-04-25 design spec superseded.

**Tech Stack:** TypeScript, Zod, vitest, better-sqlite3 (in-memory in tests).

**Spec:** `docs/superpowers/specs/2026-04-26-cross-segment-resume-pivot.md`

---

## File Structure

| File | Role | Change |
|---|---|---|
| `src/kernel-next/ir/schema.ts:145-159` | `AgentStageSchema` | Add optional `cross_segment_resume_from: string` field |
| `src/kernel-next/ir/canonical.ts:91-119` | `canonicalizeAgentConfig` | Include the new field in canonical form (only when present, to preserve hash stability for existing IRs) |
| `src/kernel-next/validator/structural.ts:37` | `validateStructural` | Add three new diagnostics for the new field: stage-not-found, not-wire-reachable, same-segment |
| `src/kernel-next/runtime/runner.ts:1707-1719` | `segmentContinuationFor` | Replace unconditional Phase 2 with a check that consults `cross_segment_resume_from`; remove `findUpstreamSessionByWires`'s wire-walk by-default semantics (the function stays — gated to the new field's lookup) |
| `src/kernel-next/runtime/runner.single-session.test.ts:207, 647` | Tests | Rewrite the two tests that encode cross-segment-by-default; add the two new tests required by spec §6.4 |
| `src/kernel-next/mcp/patch.ts:36-40` | `ALLOWED_CONFIG_KEYS` | Add `cross_segment_resume_from` to the agent allowed-keys list |
| `src/kernel-next/mcp/patch.test.ts` | Patch tests | Add a regression test asserting hot-update can mutate the new field |
| `docs/superpowers/specs/2026-04-25-single-session-mode-design.md` | Spec | Mark §3 superseded with link to the pivot spec |

Each task in the plan corresponds to one file (or one tightly-coupled file pair). Tasks are sequenced so each one leaves the build green.

---

## Pre-flight: Branch & Sanity

- [ ] **Step 0.1: Confirm branch and clean tree**

Run:
```bash
cd /Users/minghao/workflow-control
git status
git log --oneline -3
```

Expected: working tree clean; HEAD on `main` at `a048368 docs(spec): cross-segment resume design pivot — opt-in instead of default` (or later — but the pivot spec must be present).

- [ ] **Step 0.2: Confirm baseline test suite passes**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm test 2>&1 | tail -20
```

Expected: `Test Files  N passed`, with around `1792 passed | 4 skipped | 0 failed`. Failures here mean the baseline is broken before the pivot starts; do not proceed.

- [ ] **Step 0.3: Confirm tsc clean**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: no output. Any errors mean the baseline is broken; do not proceed.

---

## Task 1: Add `cross_segment_resume_from` field to AgentStage schema

**Files:**
- Modify: `apps/server/src/kernel-next/ir/schema.ts:145-159`
- Test: `apps/server/src/kernel-next/ir/schema.test.ts` (existing test file — find and add to it)

**Why this task first:** Every downstream change (canonical hash, validator, runner, patch table, tests) needs the field to exist on the type. Adding it first lets the rest of the plan compile incrementally.

- [ ] **Step 1.1: Locate schema test file**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
ls src/kernel-next/ir/schema.test.ts && wc -l src/kernel-next/ir/schema.test.ts
```

Expected: file exists. (If it does not — extremely unlikely, but in that case create it; the schema file would still need its tests somewhere.)

- [ ] **Step 1.2: Write failing tests for the new field**

Add these tests to `apps/server/src/kernel-next/ir/schema.test.ts` (locate the AgentStage section by searching for `AgentStageSchema` or `type: "agent"` in existing tests; add adjacent to those). If no AgentStage test block exists, append at end of file in a new `describe("AgentStage cross_segment_resume_from", ...)`:

```ts
import { describe, it, expect } from "vitest";
import { AgentStageSchema } from "./schema.js";

describe("AgentStage cross_segment_resume_from", () => {
  it("accepts an agent stage without the field (backward compat)", () => {
    const parsed = AgentStageSchema.parse({
      name: "s",
      type: "agent",
      inputs: [],
      outputs: [],
      config: { promptRef: "p" },
    });
    expect(parsed.config.cross_segment_resume_from).toBeUndefined();
  });

  it("accepts an agent stage with cross_segment_resume_from set", () => {
    const parsed = AgentStageSchema.parse({
      name: "s",
      type: "agent",
      inputs: [],
      outputs: [],
      config: { promptRef: "p", cross_segment_resume_from: "upstream" },
    });
    expect(parsed.config.cross_segment_resume_from).toBe("upstream");
  });

  it("rejects empty string for cross_segment_resume_from", () => {
    expect(() =>
      AgentStageSchema.parse({
        name: "s",
        type: "agent",
        inputs: [],
        outputs: [],
        config: { promptRef: "p", cross_segment_resume_from: "" },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 1.3: Run tests to verify they fail**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/ir/schema.test.ts 2>&1 | tail -20
```

Expected: the second test (`accepts ... with cross_segment_resume_from set`) fails because Zod's strict object parsing currently strips unknown keys (or refuses them, depending on the schema's strictness setting). If the test passes accidentally — read the schema and confirm the field truly does not exist before proceeding.

- [ ] **Step 1.4: Add the field to AgentStageSchema**

Edit `apps/server/src/kernel-next/ir/schema.ts:148-157`. The current shape is:

```ts
export const AgentStageSchema = z.object({
  ...StageCommon,
  type: z.literal("agent"),
  config: z.object({
    promptRef: z.string().min(1),         // resolved by userland prompt assembler
    subAgents: z.array(SubAgentDefSchema).optional(),
    mcpServers: z.array(McpServerDeclSchema)
      .optional()
      .refine(
        (arr) => !arr || new Set(arr.map((m) => m.name)).size === arr.length,
        "duplicate mcpServer name within a stage",
      ),
  }),
  fanout: FanoutSpecSchema.optional(),
});
```

Change the `config` object to add the field after `mcpServers`:

```ts
export const AgentStageSchema = z.object({
  ...StageCommon,
  type: z.literal("agent"),
  config: z.object({
    promptRef: z.string().min(1),         // resolved by userland prompt assembler
    subAgents: z.array(SubAgentDefSchema).optional(),
    mcpServers: z.array(McpServerDeclSchema)
      .optional()
      .refine(
        (arr) => !arr || new Set(arr.map((m) => m.name)).size === arr.length,
        "duplicate mcpServer name within a stage",
      ),
    // 2026-04-26 cross-segment resume pivot. When set, names a wire-upstream
    // agent stage in a different segment whose persisted SDK session this
    // stage will resume. Default (omitted) → no cross-segment resume.
    // Validator (structural.ts) enforces: target exists, is wire-reachable,
    // is in a different segment.
    cross_segment_resume_from: z.string().min(1).optional(),
  }),
  fanout: FanoutSpecSchema.optional(),
});
```

- [ ] **Step 1.5: Re-run schema tests to verify they pass**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/ir/schema.test.ts 2>&1 | tail -20
```

Expected: all three new tests PASS. All pre-existing tests in the file still PASS.

- [ ] **Step 1.6: tsc clean**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 1.7: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/ir/schema.ts apps/server/src/kernel-next/ir/schema.test.ts
git commit -m "feat(ir): add AgentStage.config.cross_segment_resume_from optional field"
```

---

## Task 2: Include the new field in canonical hashing

**Files:**
- Modify: `apps/server/src/kernel-next/ir/canonical.ts:91-119`
- Test: `apps/server/src/kernel-next/ir/canonical.test.ts`

**Why:** versionHash is content-addressed. The new field, when set, must change the hash so two IRs that differ only in cross-segment resume target are not deduped.

**Hash-stability invariant (important):** When the field is **absent**, the canonical form must be byte-identical to the pre-pivot canonical form for that stage. Otherwise every existing pipeline's versionHash silently shifts when this code lands. Use the same idiom the file already uses for `subAgents` and `mcpServers`: emit the field only when present.

- [ ] **Step 2.1: Write failing tests**

Open `apps/server/src/kernel-next/ir/canonical.test.ts` and add after the existing AgentStage canonicalization tests (search for `subAgents` or `mcpServers` to find the right block):

```ts
import { canonicalizeIR } from "./canonical.js";

describe("canonical: cross_segment_resume_from", () => {
  it("absent → byte-identical to a pre-pivot agent stage canonical form", () => {
    const without = canonicalizeIR({
      name: "p",
      stages: [
        { name: "a", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p" } },
      ],
      wires: [],
    });
    // Snapshot the canonical without the new field; nothing should
    // mention cross_segment_resume_from at all.
    expect(JSON.stringify(without)).not.toContain("cross_segment_resume_from");
  });

  it("present → field appears in canonical form and shifts hash", () => {
    const without = canonicalizeIR({
      name: "p",
      stages: [
        { name: "a", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p" } },
        { name: "b", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p" } },
      ],
      wires: [],
    });
    const withField = canonicalizeIR({
      name: "p",
      stages: [
        { name: "a", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p" } },
        { name: "b", type: "agent", inputs: [], outputs: [],
          config: { promptRef: "p", cross_segment_resume_from: "a" } },
      ],
      wires: [],
    });
    expect(JSON.stringify(withField)).toContain("cross_segment_resume_from");
    expect(JSON.stringify(withField)).not.toBe(JSON.stringify(without));
  });
});
```

- [ ] **Step 2.2: Run canonical tests to verify they fail**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/ir/canonical.test.ts 2>&1 | tail -20
```

Expected: the second new test fails because canonicalizeAgentConfig currently strips unknown keys (only `promptRef`, `subAgents`, `mcpServers` are output).

- [ ] **Step 2.3: Add field handling to canonicalizeAgentConfig**

Edit `apps/server/src/kernel-next/ir/canonical.ts:91-119`. The current shape:

```ts
function canonicalizeAgentConfig(cfg: AgentStage["config"]): CanonicalValue {
  const out: Record<string, unknown> = { promptRef: cfg.promptRef };
  if (cfg.subAgents && cfg.subAgents.length > 0) {
    out.subAgents = [...cfg.subAgents].sort((a, b) =>
      codepointCompare(a.name, b.name),
    );
  }
  if (cfg.mcpServers && cfg.mcpServers.length > 0) {
    out.mcpServers = [...cfg.mcpServers]
      .sort((a, b) => codepointCompare(a.name, b.name))
      .map((m) => {
        // ... server construction omitted for brevity, do not change
      });
  }
  return sortKeys(out);
}
```

Insert handling for the new field after the `mcpServers` block, before `return sortKeys(out)`:

```ts
  // 2026-04-26 pivot: cross_segment_resume_from is included in the
  // canonical form only when present, preserving hash stability for
  // every pre-pivot IR fixture (their canonical agent config does not
  // mention the field).
  if (cfg.cross_segment_resume_from !== undefined) {
    out.cross_segment_resume_from = cfg.cross_segment_resume_from;
  }
```

- [ ] **Step 2.4: Run canonical tests to verify they pass**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/ir/canonical.test.ts 2>&1 | tail -20
```

Expected: all tests PASS, including the existing backward-compat snapshot tests.

- [ ] **Step 2.5: Run the full canonical & version-hash test sweep**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/ir/ 2>&1 | tail -20
```

Expected: all tests in `src/kernel-next/ir/` pass. Particularly: any pre-existing "versionHash backward-compatibility" / fixture snapshot test continues to pass — that's the hash-stability check.

- [ ] **Step 2.6: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/ir/canonical.ts apps/server/src/kernel-next/ir/canonical.test.ts
git commit -m "feat(ir): include cross_segment_resume_from in canonical form (hash-stable when absent)"
```

---

## Task 3: Validator — enforce stage-exists / wire-reachable / different-segment

**Files:**
- Modify: `apps/server/src/kernel-next/validator/structural.ts`
- Test: `apps/server/src/kernel-next/validator/structural.test.ts`

**What we enforce (from pivot spec §3.2):**

1. The named stage must exist in the same pipeline (else: `CROSS_SEGMENT_TARGET_NOT_FOUND`).
2. The named stage must be wire-reachable upstream (BFS from this stage's `from.stage` wires) (else: `CROSS_SEGMENT_TARGET_NOT_REACHABLE`).
3. The named stage must be in a different segment from this stage's (computed via `planSegments`) (else: `CROSS_SEGMENT_TARGET_SAME_SEGMENT`).

Per spec §3.2's open question, we accept "any agent in the upstream segment" — no requirement that the target be the segment's last stage. Fail only on the three rules above.

Per spec §3.3: in `multi` mode, the field is allowed on stages but yields `CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE` so authors can't accidentally write a multi-mode pipeline that *looks* like it uses cross-segment resume.

- [ ] **Step 3.1: Inspect existing structural test patterns**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
grep -n "describe\|it(" src/kernel-next/validator/structural.test.ts | head -20
```

This is reconnaissance — find a clean place to add the new tests (probably end of file, or a new `describe` block adjacent to existing ones).

- [ ] **Step 3.2: Write failing tests**

Append to `apps/server/src/kernel-next/validator/structural.test.ts` a new describe block:

```ts
describe("validateStructural: cross_segment_resume_from", () => {
  it("accepts a valid cross-segment resume target", () => {
    // a → gate → b. a and b are in different segments because gate
    // breaks segments. b names a as cross_segment_resume_from.
    const ir = {
      name: "p",
      session_mode: "single" as const,
      externalInputs: [{ name: "seed", type: "string" as const }],
      stages: [
        { name: "a", type: "agent" as const, inputs: [{ name: "seed", type: "string" }], outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "pa" } },
        { name: "g", type: "gate" as const, inputs: [{ name: "x", type: "string" }], outputs: [{ name: "x", type: "string" }],
          config: { question: { text: "ok?" }, routing: { routes: { approve: "b", _default: "b" } } } },
        { name: "b", type: "agent" as const, inputs: [{ name: "x", type: "string" }], outputs: [],
          config: { promptRef: "pb", cross_segment_resume_from: "a" } },
      ],
      wires: [
        { from: { source: "external" as const, port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage" as const, stage: "a", port: "x" }, to: { stage: "g", port: "x" } },
        { from: { source: "stage" as const, stage: "g", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    };
    const r = validateStructural(ir);
    expect(r.diagnostics.filter((d) => d.code.startsWith("CROSS_SEGMENT"))).toEqual([]);
  });

  it("CROSS_SEGMENT_TARGET_NOT_FOUND: target stage doesn't exist", () => {
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        { name: "a", type: "agent" as const, inputs: [], outputs: [],
          config: { promptRef: "p", cross_segment_resume_from: "ghost" } },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    expect(r.diagnostics.find((d) => d.code === "CROSS_SEGMENT_TARGET_NOT_FOUND"))
      .toBeDefined();
  });

  it("CROSS_SEGMENT_TARGET_NOT_REACHABLE: target exists but is not wire-upstream", () => {
    // a and b are independent (no wires between them). b names a but
    // can't reach a via wires.
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        { name: "a", type: "agent" as const, inputs: [], outputs: [],
          config: { promptRef: "pa" } },
        { name: "b", type: "agent" as const, inputs: [], outputs: [],
          config: { promptRef: "pb", cross_segment_resume_from: "a" } },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    expect(r.diagnostics.find((d) => d.code === "CROSS_SEGMENT_TARGET_NOT_REACHABLE"))
      .toBeDefined();
  });

  it("CROSS_SEGMENT_TARGET_SAME_SEGMENT: target is in the same segment", () => {
    // a → b, both agent stages, no break between them, single mode →
    // segment-planner places them in the same segment. b cannot resume
    // a cross-segment.
    const ir = {
      name: "p",
      session_mode: "single" as const,
      externalInputs: [{ name: "seed", type: "string" as const }],
      stages: [
        { name: "a", type: "agent" as const, inputs: [{ name: "seed", type: "string" }], outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "pa" } },
        { name: "b", type: "agent" as const, inputs: [{ name: "x", type: "string" }], outputs: [],
          config: { promptRef: "pb", cross_segment_resume_from: "a" } },
      ],
      wires: [
        { from: { source: "external" as const, port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage" as const, stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    };
    const r = validateStructural(ir);
    expect(r.diagnostics.find((d) => d.code === "CROSS_SEGMENT_TARGET_SAME_SEGMENT"))
      .toBeDefined();
  });

  it("CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE: multi-mode pipeline uses the field", () => {
    const ir = {
      name: "p",
      // session_mode omitted → defaults to "multi" via Zod
      stages: [
        { name: "a", type: "agent" as const, inputs: [], outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "pa" } },
        { name: "b", type: "agent" as const, inputs: [{ name: "x", type: "string" }], outputs: [],
          config: { promptRef: "pb", cross_segment_resume_from: "a" } },
      ],
      wires: [
        { from: { source: "stage" as const, stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    };
    const r = validateStructural(ir);
    expect(r.diagnostics.find((d) => d.code === "CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE"))
      .toBeDefined();
  });
});
```

- [ ] **Step 3.3: Run validator tests to verify they fail**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/validator/structural.test.ts 2>&1 | tail -30
```

Expected: all five new tests fail (validator does not yet check the field).

- [ ] **Step 3.4: Add validation logic**

Open `apps/server/src/kernel-next/validator/structural.ts`. Add the import for `planSegments` near the top (after the existing imports):

```ts
import { planSegments } from "../runtime/segment-planner.js";
```

At the bottom of `validateStructural`, before the `return { diagnostics }` (or whatever the function's final return statement is — find by reading the last 30 lines of the function), insert this validation block:

```ts
  // --- cross_segment_resume_from (2026-04-26 pivot) ---
  // Iterate agent stages with the field set. Validate against three rules:
  //   1. target stage exists
  //   2. target stage is wire-upstream (BFS through wires)
  //   3. target stage is in a different segment per planSegments()
  // Plus: the pipeline must be session_mode === "single" for the field
  // to have any meaning at all.
  const stagesWithField: Array<{ stage: string; target: string }> = [];
  for (const s of ir.stages) {
    if (s.type !== "agent") continue;
    const t = s.config.cross_segment_resume_from;
    if (typeof t === "string") stagesWithField.push({ stage: s.name, target: t });
  }
  if (stagesWithField.length > 0) {
    if (ir.session_mode !== "single") {
      for (const { stage } of stagesWithField) {
        diagnostics.push({
          code: "CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE",
          message: `Stage '${stage}' declares cross_segment_resume_from but pipeline session_mode is not 'single'; the field has no effect outside single-session pipelines.`,
          context: { stage },
        });
      }
    } else {
      // Build wire-upstream adjacency once (BFS source).
      const wireUpstream = new Map<string, string[]>();
      for (const s of ir.stages) wireUpstream.set(s.name, []);
      for (const w of ir.wires) {
        if (w.from.source === "external") continue;
        const fromStage = "stage" in w.from ? (w.from as { stage: string }).stage : undefined;
        if (!fromStage) continue;
        const list = wireUpstream.get(w.to.stage);
        if (!list) continue;
        if (!list.includes(fromStage)) list.push(fromStage);
      }
      const segments = planSegments(ir);
      const segmentOf = new Map<string, number>();
      segments.forEach((seg, idx) => seg.forEach((name) => segmentOf.set(name, idx)));

      for (const { stage, target } of stagesWithField) {
        // Rule 1: target exists
        if (!stageNames.has(target)) {
          diagnostics.push({
            code: "CROSS_SEGMENT_TARGET_NOT_FOUND",
            message: `Stage '${stage}'.cross_segment_resume_from = '${target}' references a stage that is not declared in stages[].`,
            context: { stage, target },
          });
          continue;
        }
        // Rule 2: target is wire-upstream
        const reachable = new Set<string>();
        const queue = [...(wireUpstream.get(stage) ?? [])];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          if (reachable.has(cur)) continue;
          reachable.add(cur);
          for (const up of wireUpstream.get(cur) ?? []) queue.push(up);
        }
        if (!reachable.has(target)) {
          diagnostics.push({
            code: "CROSS_SEGMENT_TARGET_NOT_REACHABLE",
            message: `Stage '${stage}'.cross_segment_resume_from = '${target}' is not wire-reachable upstream from '${stage}'.`,
            context: { stage, target },
          });
          continue;
        }
        // Rule 3: target is in a different segment
        if (segmentOf.get(stage) === segmentOf.get(target)) {
          diagnostics.push({
            code: "CROSS_SEGMENT_TARGET_SAME_SEGMENT",
            message: `Stage '${stage}'.cross_segment_resume_from = '${target}' is in the same segment; cross-segment resume is not applicable. (Within-segment continuation is automatic.)`,
            context: { stage, target },
          });
        }
      }
    }
  }
```

- [ ] **Step 3.5: Run validator tests to verify they pass**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/validator/structural.test.ts 2>&1 | tail -30
```

Expected: all five new tests PASS, all pre-existing tests still PASS.

- [ ] **Step 3.6: tsc clean**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3.7: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/validator/structural.ts apps/server/src/kernel-next/validator/structural.test.ts
git commit -m "feat(validator): enforce cross_segment_resume_from constraints"
```

---

## Task 4: Runner — replace unconditional Phase 2 with opt-in lookup

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/runner.ts:1707-1719` (Phase 2 block in `segmentContinuationFor`) and the helper `findUpstreamSessionByWires` at `runner.ts:1726-1780`
- (No new test file — Tasks 5 and 6 cover runner behavior)

**The new contract (pivot spec §3.2):**

When `segmentContinuationFor` reaches Phase 2 (no in-segment session), it must:
- Read the current stage's `cross_segment_resume_from` field
- If absent: return `undefined` (no cross-segment resume)
- If present: look up the target stage's most recent session_id under the same status filter as Phase 1 (`success` ∪ `running`)

The helper `findUpstreamSessionByWires` is no longer needed at this exact call site (the field already names the target — no BFS required for resume). However, the **same SQL** still has value as a single-stage lookup. We refactor it into a simpler `findStageSession(opts, taskId, stageName)` helper.

- [ ] **Step 4.1: Read the current Phase 2 implementation**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
sed -n '1700,1785p' src/kernel-next/runtime/runner.ts
```

Confirm the current code matches what's described in the pivot spec §4. Lines 1707-1719 implement Phase 2; lines 1726-1780 implement `findUpstreamSessionByWires`.

- [ ] **Step 4.2: Replace Phase 2 block**

Edit `apps/server/src/kernel-next/runtime/runner.ts` lines 1707-1719. The current block is:

```ts
  // Phase 2: cross-segment resume. The stage is either segment-first
  // (idx 0) OR an in-segment stage whose preceding stages have no
  // persisted session yet. Walk wires upstream to find the most recent
  // agent ancestor with a persisted session.
  const upstreamSession = findUpstreamSessionByWires(opts, taskId, ir, stageName);
  if (!upstreamSession) return undefined;

  return {
    resumeSessionId: upstreamSession,
    priorNumTurns,
    priorAttempts,
    isContinuationStage,
  };
}
```

Replace with:

```ts
  // Phase 2: cross-segment resume (opt-in per 2026-04-26 pivot). The
  // stage is either segment-first (idx 0) OR an in-segment stage whose
  // preceding stages have no persisted session yet. Cross-segment
  // resume is no longer automatic — it requires the stage to declare
  // `cross_segment_resume_from` naming a wire-upstream agent in a
  // different segment. Validator (structural.ts) enforces:
  //   - target stage exists
  //   - target is wire-upstream
  //   - target is in a different segment
  // We do NOT re-check those here; runtime trusts the validated IR.
  const stage = ir.stages.find((s) => s.name === stageName);
  if (!stage || stage.type !== "agent") return undefined;
  const target = stage.config.cross_segment_resume_from;
  if (!target) return undefined;

  const upstreamSession = findStageSession(opts, taskId, target);
  if (!upstreamSession) return undefined;

  return {
    resumeSessionId: upstreamSession,
    priorNumTurns,
    priorAttempts,
    isContinuationStage,
  };
}
```

- [ ] **Step 4.3: Replace findUpstreamSessionByWires with findStageSession**

Edit `apps/server/src/kernel-next/runtime/runner.ts` lines 1722-1780 (the `findUpstreamSessionByWires` function and its leading block comment). The current function does BFS through wires. Replace the entire function with the simpler single-stage lookup:

```ts
// Look up the most recent persisted session_id for a single agent
// stage on a task. Status filter: 'success' OR 'running' — see
// segmentContinuationFor's Phase 1 comment for why 'running' is included
// (an upstream stage typically only just finished writing its outputs;
// its status='success' transition happens AFTER its writePort calls,
// so at query time the upstream attempt is often still 'running').
//
// Replaces the pre-2026-04-26 findUpstreamSessionByWires helper, which
// walked wires upstream by BFS. The cross-segment-resume target is now
// named explicitly via cross_segment_resume_from, so no BFS is needed.
function findStageSession(
  opts: RunnerOptions,
  taskId: string,
  stageName: string,
): string | undefined {
  const r = opts.db.prepare(
    `SELECT aed.session_id
       FROM agent_execution_details aed
       JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
      WHERE sa.task_id = ? AND sa.stage_name = ?
        AND aed.session_id IS NOT NULL
        AND sa.status IN ('success', 'running')
      ORDER BY aed.started_at DESC
      LIMIT 1`,
  ).get(taskId, stageName) as { session_id: string } | undefined;
  return r?.session_id;
}
```

- [ ] **Step 4.4: tsc clean**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -10
```

Expected: no errors. (At this point, several runner tests will fail because their assertions encode the old behavior; that's fine — Tasks 5 and 6 fix them.)

- [ ] **Step 4.5: Run runner tests — expect specific failures**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/runtime/runner.single-session.test.ts 2>&1 | tail -40
```

Expected: at least these two tests fail:
- "diamond fan-out a→b, a→c: both b and c resume a's session_id (cross-segment resume per spec §3)" (line 207) — c will now have `segCont = undefined` instead of `resumeSessionId: "sa"`
- "hot-update: sibling-preservation diamond — D resumes any wire-upstream success session" (line 647) — D will now have `result = undefined`

Other tests should still pass. If any other test fails, read it carefully and decide whether it's another encoding of the old behavior (rewrite it in Tasks 5/6) or a real regression (fix the runner).

- [ ] **Step 4.6: Do NOT commit yet**

Tests are red. Continue to Task 5 to make them green again with rewritten/new tests.

---

## Task 5: Rewrite the two tests that encode cross-segment-by-default

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/runner.single-session.test.ts:207` (diamond fan-out test) and `:647` (hot-update sibling-preservation test)

The two tests need to be rewritten to assert the new default — no cross-segment resume — while preserving their original *intent*: the diamond test verified that branching stages get the right session_ids; the hot-update test verified that superseded sessions don't leak.

We rewrite them into a pair of variants:
- **No-field variant:** assert no resume happens (the new default)
- **With-field variant:** declare `cross_segment_resume_from`, assert resume happens

This keeps the original property under test (correct session selection) but expressed against the new contract.

- [ ] **Step 5.1: Read the diamond test in full**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
sed -n '207,297p' src/kernel-next/runtime/runner.single-session.test.ts
```

- [ ] **Step 5.2: Rewrite the diamond test (line 207-297)**

Replace the entire `it("diamond fan-out a→b, a→c: both b and c resume a's session_id (cross-segment resume per spec §3)" ...)` block with two tests. Use `Edit` to replace the existing test from `it("diamond fan-out` ... up to and including the test's closing `});  });` line. Insert in its place:

```ts
  it("diamond fan-out a→b, a→c: c does NOT resume a by default (cross-segment-resume opt-in per 2026-04-26 pivot)", async () => {
    // 2026-04-26 pivot: cross-segment resume is now opt-in via
    // cross_segment_resume_from. Without that field, c (idx 0 of its
    // own segment) does NOT walk wires back to a. b (idx 1 of segment 0)
    // still uses in-segment continuation — that's unchanged.
    const ir = PipelineIRSchema.parse({
      name: "diamond",
      session_mode: "single",
      externalInputs: [{ name: "seed", type: "string" }],
      stages: [
        {
          name: "a", type: "agent",
          inputs: [{ name: "seed", type: "string" }],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "p/a" },
        },
        {
          name: "b", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yb", type: "string" }],
          config: { promptRef: "p/b" },
        },
        {
          name: "c", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yc", type: "string" }],
          config: { promptRef: "p/c" },
        },
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "c", port: "x" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const seenContinuation: Array<{ stage: string; segCont: ExecuteStageArgs["segmentContinuation"] }> = [];
    const diamondHandlers = {
      a: (): { x: string } => ({ x: "a-out" }),
      b: (): { yb: string } => ({ yb: "b-out" }),
      c: (): { yc: string } => ({ yc: "c-out" }),
    };
    const executor = new MockStageExecutor({
      handlers: diamondHandlers,
      onExecute: (args) =>
        seenContinuation.push({ stage: args.stageName, segCont: args.segmentContinuation }),
      persistSessionIdMap: { a: { sessionId: "sa", numTurns: 2 } },
    });

    const result = await runPipeline({
      db, ir, taskId: "t-diamond", versionHash: hash,
      handlers: diamondHandlers, executor, seedValues: { seed: "s0" },
    });

    expect(result.finalState).toBe("completed");
    expect(seenContinuation).toHaveLength(3);

    // a: first stage of segment 0, no upstream agent → no resume.
    expect(seenContinuation.find((r) => r.stage === "a")!.segCont).toBeUndefined();

    // b: idx 1 of segment 0 → in-segment continuation (unchanged behavior).
    const bRecord = seenContinuation.find((r) => r.stage === "b")!;
    expect(bRecord.segCont?.resumeSessionId).toBe("sa");
    expect(bRecord.segCont?.isContinuationStage).toBe(true);

    // c: idx 0 of segment 1. Without cross_segment_resume_from, no
    // resume — this is the post-pivot default.
    expect(seenContinuation.find((r) => r.stage === "c")!.segCont).toBeUndefined();
    db.close();
  });

  it("diamond fan-out with cross_segment_resume_from='a' on c: c resumes a's session", async () => {
    // Same diamond as above, but c declares cross_segment_resume_from.
    // c is now expected to resume a's session via the explicit opt-in.
    const ir = PipelineIRSchema.parse({
      name: "diamond-opt-in",
      session_mode: "single",
      externalInputs: [{ name: "seed", type: "string" }],
      stages: [
        {
          name: "a", type: "agent",
          inputs: [{ name: "seed", type: "string" }],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "p/a" },
        },
        {
          name: "b", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yb", type: "string" }],
          config: { promptRef: "p/b" },
        },
        {
          name: "c", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yc", type: "string" }],
          config: { promptRef: "p/c", cross_segment_resume_from: "a" },
        },
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "c", port: "x" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const seenContinuation: Array<{ stage: string; segCont: ExecuteStageArgs["segmentContinuation"] }> = [];
    const handlers = {
      a: (): { x: string } => ({ x: "a-out" }),
      b: (): { yb: string } => ({ yb: "b-out" }),
      c: (): { yc: string } => ({ yc: "c-out" }),
    };
    const executor = new MockStageExecutor({
      handlers,
      onExecute: (args) =>
        seenContinuation.push({ stage: args.stageName, segCont: args.segmentContinuation }),
      persistSessionIdMap: { a: { sessionId: "sa", numTurns: 2 } },
    });

    const result = await runPipeline({
      db, ir, taskId: "t-diamond-optin", versionHash: hash,
      handlers, executor, seedValues: { seed: "s0" },
    });

    expect(result.finalState).toBe("completed");

    // c: opt-in resume → resumeSessionId === "sa", isContinuationStage === false
    // (segment-first stage; full prompt form per spec §8.4).
    const cRecord = seenContinuation.find((r) => r.stage === "c")!;
    expect(cRecord.segCont?.resumeSessionId).toBe("sa");
    expect(cRecord.segCont?.isContinuationStage).toBe(false);
    db.close();
  });
```

- [ ] **Step 5.3: Read the hot-update sibling-preservation test in full**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
sed -n '647,750p' src/kernel-next/runtime/runner.single-session.test.ts
```

- [ ] **Step 5.4: Rewrite the hot-update sibling test**

The original test asserted that D, after hot-update with rerunFrom=B, can resume *some* ancestor session. The pre-pivot system gave D this ability automatically. Post-pivot, D needs `cross_segment_resume_from` to opt in.

Replace the entire `it("hot-update: sibling-preservation diamond ..." ...)` block with:

```ts
  it("hot-update: sibling-preservation diamond — D with cross_segment_resume_from='B' resumes B's session", () => {
    // Diamond IR: A → B, A → C, B → D, C → D. Hot-update with rerunFrom=B
    // supersedes B and D (wire-reachable from B), but A and C stay
    // success on v1 (B13 sibling preservation). Post-pivot, when v2
    // rerun reaches D, D opts into cross-segment resume by naming
    // cross_segment_resume_from='B' (its segment break is B's
    // termination, since B's segment ends at D's segment start).
    //
    // We assert resumeSessionId === 'sess-B-new' (the v2 success
    // session), proving:
    //   - the explicit field works
    //   - the status filter excludes the v1 superseded B session
    const ir = PipelineIRSchema.parse({
      name: "diamond-hot-update",
      session_mode: "single",
      externalInputs: [{ name: "seed", type: "string" }],
      stages: [
        {
          name: "A", type: "agent",
          inputs: [{ name: "seed", type: "string" }],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "p/A" },
        },
        {
          name: "B", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yB", type: "string" }],
          config: { promptRef: "p/B-v2" },
        },
        {
          name: "C", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yC", type: "string" }],
          config: { promptRef: "p/C" },
        },
        {
          name: "D", type: "agent",
          inputs: [
            { name: "yB", type: "string" },
            { name: "yC", type: "string" },
          ],
          outputs: [{ name: "final", type: "string" }],
          config: { promptRef: "p/D-v2", cross_segment_resume_from: "B" },
        },
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "A", port: "seed" } },
        { from: { source: "stage", stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
        { from: { source: "stage", stage: "A", port: "x" }, to: { stage: "C", port: "x" } },
        { from: { source: "stage", stage: "B", port: "yB" }, to: { stage: "D", port: "yB" } },
        { from: { source: "stage", stage: "C", port: "yC" }, to: { stage: "D", port: "yC" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "t-diamond-hu";
    const v1 = "v1-hash";
    const v2 = hash;

    db.prepare(
      `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at) VALUES ('h', '', 0)`,
    ).run();

    const seed = (id: string, vhash: string, stage: string, status: string, ts: number, sess: string): void => {
      db.prepare(
        `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES (?, ?, ?, ?, 0, ?, ?)`,
      ).run(id, taskId, vhash, stage, ts, status);
      db.prepare(
        `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at) VALUES (?, 'r', 'h', '', 'm', ?, ?, ?)`,
      ).run(id, sess, ts, ts);
    };
    // v2-B succeeds first (200); v1-B is superseded but more recent in
    // started_at (300). Status filter must reject v1-B even though it's
    // newer — the very property the original test verified.
    seed("v2-B", v2, "B", "success",    200, "sess-B-new");
    seed("v1-A", v1, "A", "success",    100, "sess-A");
    seed("v1-C", v1, "C", "success",    150, "sess-C");
    seed("v1-B", v1, "B", "superseded", 300, "sess-B-old");
    seed("v1-D", v1, "D", "superseded", 310, "sess-D-old");

    const segments = planSegments(ir);
    const stubOpts = {
      db, ir, taskId, versionHash: v2, handlers: {},
    } as Parameters<typeof segmentContinuationFor>[0];

    const result = segmentContinuationFor(stubOpts, "D", taskId, ir, segments);
    // D explicitly resumes B; status filter picks v2-B (success), not v1-B (superseded).
    expect(result?.resumeSessionId).toBe("sess-B-new");
    db.close();
  });
```

- [ ] **Step 5.5: Run the runner test file — verify the rewritten tests pass**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/runtime/runner.single-session.test.ts 2>&1 | tail -30
```

Expected: all tests in this file PASS, including the new no-field and with-field diamond pair, the rewritten hot-update test, and all pre-existing tests.

- [ ] **Step 5.6: Commit the runner change + rewritten tests together**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/runtime/runner.ts apps/server/src/kernel-next/runtime/runner.single-session.test.ts
git commit -m "feat(runner): cross-segment resume becomes opt-in via cross_segment_resume_from"
```

---

## Task 6: Add the multi-mode-byte-identical regression test

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/runner.single-session.test.ts` (or a sibling test file — see Step 6.1)

Pivot spec §3.3 declares: "A pipeline with `session_mode: 'multi'` (the default) MUST behave byte-identically whether or not the kernel even compiles single-mode code paths." We add a regression that makes this concrete: a multi-mode diamond pipeline produces `segmentContinuation === undefined` for every stage.

This is a **new** test, not a rewrite. It's the §6.4 acceptance bullet 1.

- [ ] **Step 6.1: Decide on test file**

The natural home is a multi-mode-specific test file. Check if one exists:

```bash
cd /Users/minghao/workflow-control/apps/server
ls src/kernel-next/runtime/runner.*.test.ts
```

If `runner.multi-session.test.ts` exists, add to it. Otherwise add to `runner.single-session.test.ts` in a new top-level `describe("multi-mode regression after cross-segment-resume pivot", ...)` block (the file already has all the necessary imports and helpers).

- [ ] **Step 6.2: Write the test**

Append to the chosen file:

```ts
describe("multi-mode regression after cross-segment-resume pivot", () => {
  it("multi-mode diamond: every stage has segmentContinuation === undefined", async () => {
    // Pivot spec §3.3: multi-mode behavior must be byte-identical to
    // pre-pivot. This test fails if any code path leaks segment
    // continuation into multi-mode runs.
    const ir = PipelineIRSchema.parse({
      name: "multi-diamond",
      // session_mode omitted → defaults to "multi"
      externalInputs: [{ name: "seed", type: "string" }],
      stages: [
        {
          name: "a", type: "agent",
          inputs: [{ name: "seed", type: "string" }],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "p/a" },
        },
        {
          name: "b", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yb", type: "string" }],
          config: { promptRef: "p/b" },
        },
        {
          name: "c", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yc", type: "string" }],
          config: { promptRef: "p/c" },
        },
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "c", port: "x" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const seenContinuation: Array<{ stage: string; segCont: ExecuteStageArgs["segmentContinuation"] }> = [];
    const handlers = {
      a: (): { x: string } => ({ x: "a-out" }),
      b: (): { yb: string } => ({ yb: "b-out" }),
      c: (): { yc: string } => ({ yc: "c-out" }),
    };
    const executor = new MockStageExecutor({
      handlers,
      onExecute: (args) =>
        seenContinuation.push({ stage: args.stageName, segCont: args.segmentContinuation }),
      // Persisting session IDs would matter only if multi-mode tried
      // to resume — which it must not. Set them anyway to make the
      // assertion stronger: even when sessions exist, multi mode
      // ignores them.
      persistSessionIdMap: {
        a: { sessionId: "sa", numTurns: 2 },
        b: { sessionId: "sb", numTurns: 2 },
      },
    });

    const result = await runPipeline({
      db, ir, taskId: "t-multi-diamond", versionHash: hash,
      handlers, executor, seedValues: { seed: "s0" },
    });

    expect(result.finalState).toBe("completed");
    expect(seenContinuation).toHaveLength(3);
    for (const r of seenContinuation) {
      expect(r.segCont).toBeUndefined();
    }
    db.close();
  });
});
```

- [ ] **Step 6.3: Run the test to verify it passes**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/runtime/runner.single-session.test.ts 2>&1 | tail -30
```

Expected: the new test PASSes. (It should pass without any code changes — `segmentContinuationFor` already returns undefined when `ir.session_mode !== "single"` at line 1653, which is the contract this test exercises.)

- [ ] **Step 6.4: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/runtime/runner.single-session.test.ts
git commit -m "test(runner): multi-mode diamond regression for cross-segment-resume pivot"
```

---

## Task 7: Hot-update — allow `cross_segment_resume_from` in patch table

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/patch.ts:36-40` (`ALLOWED_CONFIG_KEYS`)
- Test: `apps/server/src/kernel-next/mcp/patch.test.ts`

Per pivot spec §4 last bullet and the F16 SOP: every mutable config key must appear in `ALLOWED_CONFIG_KEYS`, otherwise hot-update can't change it post-submit. The author may want to add or change cross_segment_resume_from on a hot-update path (e.g. discovering after the first run that a stage benefits from resume), so we list it.

- [ ] **Step 7.1: Write a failing test**

Add to `apps/server/src/kernel-next/mcp/patch.test.ts`, after the three F16 tests (line 119-168 of the current file is the F16 block; add immediately after the last `it("update_stage_config (gate) accepts timeout_minutes" ...)` block):

```ts
  it("update_stage_config (agent) accepts cross_segment_resume_from", () => {
    const p: IRPatch = { ops: [
      { op: "update_stage_config", stage: "A", configPatch: { cross_segment_resume_from: "B" } },
    ]};
    const out = applyPatch(base(), p);
    const a = out.stages[0]!;
    if (a.type !== "agent") throw new Error("expected agent stage");
    expect(a.config.cross_segment_resume_from).toBe("B");
    // promptRef preserved (merge, not replace).
    expect(a.config.promptRef).toBe("p");
  });
```

- [ ] **Step 7.2: Run patch tests to verify failure**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/mcp/patch.test.ts 2>&1 | tail -10
```

Expected: the new test fails with a `PatchApplyError` saying `cross_segment_resume_from` is not allowed.

- [ ] **Step 7.3: Add the key to ALLOWED_CONFIG_KEYS**

Edit `apps/server/src/kernel-next/mcp/patch.ts:36-40`. Current:

```ts
const ALLOWED_CONFIG_KEYS: Record<StageIR["type"], readonly string[]> = {
  agent:  ["promptRef", "subAgents", "mcpServers"],
  script: ["moduleId", "retry"],
  gate:   ["question", "routing", "timeout_minutes"],
};
```

Change to:

```ts
const ALLOWED_CONFIG_KEYS: Record<StageIR["type"], readonly string[]> = {
  agent:  ["promptRef", "subAgents", "mcpServers", "cross_segment_resume_from"],
  script: ["moduleId", "retry"],
  gate:   ["question", "routing", "timeout_minutes"],
};
```

Update the explanatory comment at line 17-35 (the block above) to note that the agent list now includes the new field. Specifically, find this part of the comment:

```
// - agent: AgentStageSchema permits {promptRef, subAgents, mcpServers}.
//   All three are listed here so hot-update can adjust sub-agent lists
//   and MCP server declarations without a full pipeline resubmit.
```

And replace with:

```
// - agent: AgentStageSchema permits {promptRef, subAgents, mcpServers,
//   cross_segment_resume_from}. All four are listed here so hot-update
//   can adjust sub-agent lists, MCP server declarations, and the
//   cross-segment-resume target without a full pipeline resubmit.
```

- [ ] **Step 7.4: Run patch tests to verify pass**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec vitest run src/kernel-next/mcp/patch.test.ts 2>&1 | tail -10
```

Expected: all 15 tests PASS (the original 14 plus the new one).

- [ ] **Step 7.5: Commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/mcp/patch.ts apps/server/src/kernel-next/mcp/patch.test.ts
git commit -m "feat(hot-update): allow patching cross_segment_resume_from"
```

---

## Task 8: Mark the original spec superseded; double-check spec/handoff docs

**Files:**
- Modify: `docs/superpowers/specs/2026-04-25-single-session-mode-design.md`

Pivot spec §6.5 says: "`niche.md` §6 re-worded; original `single-session-mode-design.md` §3 marked superseded with link to this spec." Niche §6 was already done in commit `a048368`. Now mark §3 of the original spec.

- [ ] **Step 8.1: Read the original spec's §3**

Run:
```bash
cd /Users/minghao/workflow-control
grep -n "^## 3\|^### 3" docs/superpowers/specs/2026-04-25-single-session-mode-design.md
```

This shows the line numbers of §3 and any sub-sections.

- [ ] **Step 8.2: Add the supersession banner**

Use Edit to insert at the very top of §3 (immediately after the section's header line, on a new line) this banner:

```
> **Superseded 2026-04-26.** The default cross-segment-resume behavior described in this section was reversed by the design pivot in `2026-04-26-cross-segment-resume-pivot.md`. Cross-segment resume is now opt-in via `AgentStage.config.cross_segment_resume_from`. Within-segment continuation (the rest of this spec) is unchanged.
```

(Implementation detail: read the file first to find the exact text of the §3 header line, then use Edit to insert the banner after it. Do not invent the header text — read it.)

- [ ] **Step 8.3: Commit**

```bash
cd /Users/minghao/workflow-control
git add docs/superpowers/specs/2026-04-25-single-session-mode-design.md
git commit -m "docs(spec): mark single-session-mode-design §3 superseded by cross-segment-resume pivot"
```

---

## Task 9: Full-suite verification + acceptance check

**Files:** None modified. This is the §6 acceptance gate from the pivot spec.

- [ ] **Step 9.1: Run the full server test suite**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm test 2>&1 | tail -10
```

Expected: roughly `Test Files  N passed`, around `1795+ passed | 4 skipped | 0 failed`. (3 new tests in schema, 2 new in canonical, 5 new in validator, 2 new + 2 rewritten in runner, 1 new in patch, 1 new multi-mode regression. Net new: 13ish. Plus rewrites of 2 existing tests.)

If anything fails, read the output carefully. Two likely categories:

  - A test inadvertently relying on cross-segment-by-default that we missed in Tasks 5/6. Read it; if its intent is obsoleted by the pivot, rewrite it; if it's testing something else that broke, fix the runner.
  - A canonical/version-hash backward-compat snapshot test failing because we accidentally changed the canonical form for IRs that *don't* set the new field. This is the §3.3 byte-identical clause. Re-check Task 2's `if (cfg.cross_segment_resume_from !== undefined)` guard.

- [ ] **Step 9.2: Run tsc clean**

Run:
```bash
cd /Users/minghao/workflow-control/apps/server
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: no output.

- [ ] **Step 9.3: Manually walk pivot spec §6 acceptance criteria**

Read `docs/superpowers/specs/2026-04-26-cross-segment-resume-pivot.md` §6 and confirm each numbered bullet is satisfied:

  1. New IR field `AgentStage.config.cross_segment_resume_from?: string` added to schema, canonical, validator → Tasks 1, 2, 3.
  2. `runner.ts` `segmentContinuationFor`'s Phase 2 path removed; replaced with a check that consults the new field → Task 4.
  3. `runner.single-session.test.ts:207` and any sibling tests asserting cross-segment-by-default behavior are rewritten → Task 5.
  4. At least 2 new tests:
     - Multi-mode pipeline with diamond topology: no resume anywhere, byte-identical to current multi-mode runner output → Task 6.
     - Single-mode pipeline with explicit `cross_segment_resume_from`: resume happens; without the field on the same IR, no resume → Task 5 (the diamond pair covers exactly this).
  5. `niche.md` §6 re-worded (already done in `a048368`); original `single-session-mode-design.md` §3 marked superseded → Task 8.
  6. Full test suite (1792+ tests) passes; tsc clean → Step 9.1, 9.2.
  7. The web3-research pipeline (versionHash `e6f281e9...`) re-runnable as a baseline regression — multi-mode behavior must be byte-identical to current. **This bullet is the canonical-hash invariant.** Verify by hand:

```bash
cd /Users/minghao/workflow-control/apps/server
# Re-canonicalize the web3-research pipeline IR; the hash must equal e6f281e9... (the round-4 canonical hash recorded in dogfood findings).
# A fast way: run a one-shot script that loads the IR fixture and prints versionHash. If no such script exists, this verification is satisfied by Task 2's hash-stability test (which proves the canonical form is unchanged when the new field is absent).
```

If the pipeline IR fixture is on disk (e.g. `apps/server/src/builtin-pipelines/web3-research-*/pipeline.ir.json` if it was seeded as a builtin) load it and print the hash; otherwise the hash-stability unit tests in Task 2 are sufficient evidence per §3.3 (the field is absent in every existing pipeline → canonical form unchanged → hash unchanged).

- [ ] **Step 9.4: Final commit (no-op safety net)**

If any documentation or comment got out of date during the implementation (e.g. a JSDoc on `segmentContinuationFor` still referring to "Phase 2 walks wires"), fix it now and commit:

```bash
cd /Users/minghao/workflow-control
git status
# If any files are dirty:
git add <files>
git commit -m "docs(runner): update comments to reflect cross-segment-resume pivot"
# If clean: skip this step.
```

---

## Self-Review

(Inline self-review per writing-plans skill §Self-Review.)

**1. Spec coverage:**
- §1 (the decision) — Tasks 1, 4 implement; Task 8 records.
- §2 (why original was wrong) — informational; no task.
- §3.1 (within-segment unchanged) — guarded by Task 4's edits not touching Phase 1.
- §3.2 (cross-segment opt-in via field) — Tasks 1, 3, 4.
- §3.3 (multi-mode byte-identical) — Task 6.
- §3.4 (existing single-mode pipelines unaffected) — covered by Task 5 plus the unchanged smoke-test/pr-description-generator pipelines (no rewrite needed; they have no cross-segment paths).
- §4 (implementation surface) — Tasks 1-7 cover IR schema, canonical hashing, runner, validator, tests, hot-update patch table.
- §6.1-6.6 acceptance — Task 9.

No gaps.

**2. Placeholder scan:**
- No "TODO" / "TBD" / "implement later" in the plan.
- Every code step has the exact code to paste or the exact location + transformation.
- Step 8.2 says "read the file first to find the exact header text" rather than invent it — that's a deliberate just-in-time read, not a placeholder.

**3. Type consistency:**
- `cross_segment_resume_from` (single underscore-style snake_case) used consistently in schema, canonical, validator, runner, patch table, and tests.
- New diagnostic codes: `CROSS_SEGMENT_TARGET_NOT_FOUND`, `CROSS_SEGMENT_TARGET_NOT_REACHABLE`, `CROSS_SEGMENT_TARGET_SAME_SEGMENT`, `CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE` — consistent across Task 3 implementation and tests.
- New helper name `findStageSession` introduced in Task 4 and not referenced elsewhere — single-site, no consistency burden.

No type-consistency issues.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-26-cross-segment-resume-pivot.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
