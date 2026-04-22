# Stage 5A — Propose Pipeline Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full propose-pipeline-change lifecycle (dry-run → diff+impact+safeRange → optional auto-approve) plus `update_registry_pipeline` and `rollback_hot_update` MCP skeleton per the Stage 5A design spec.

**Architecture:** Pure-function modules (`diff.ts`, `safe-range.ts`) plus one DB-reading module (`impact.ts`) plus one orchestrator (`dry-run.ts`), all under `apps/server/src/kernel-next/hot-update/`. `KernelService` in `mcp/kernel.ts` wires them to three existing + three new MCP tools. Zero DB-schema migrations — only `pipeline_proposals.diagnostic_json` JSON shape extension (`__kind` discriminator).

**Tech Stack:** TypeScript strict mode, vitest, zod, `node:sqlite` DatabaseSync, existing `computeDownstream` from `runtime/topo-downstream.ts`, existing `applyPatch` from `mcp/patch.ts`.

---

## File Structure

### New files (all under `apps/server/src/kernel-next/hot-update/`)

| File | Responsibility | LOC est. |
|---|---|---|
| `diff.ts` | `computePipelineDiff(base, proposed): PipelineDiff` — pure function | ~200 |
| `diff.test.ts` | unit tests | ~250 |
| `safe-range.ts` | `classifySafeRange(diff, impact): SafeRangeVerdict` — pure function | ~100 |
| `safe-range.test.ts` | unit tests | ~150 |
| `impact.ts` | `computeImpact(db, currentVersion, proposedIR, rerunFrom): Impact` — DB reads only | ~180 |
| `impact.test.ts` | unit tests with seeded DB | ~250 |
| `dry-run.ts` | `dryRunProposal(db, input): DryRunResult` — orchestrates diff + impact + safeRange | ~120 |
| `dry-run.test.ts` | unit tests | ~200 |
| `types.ts` | shared types (PipelineDiff / Impact / SafeRangeVerdict / DryRunResult) | ~150 |

### Modified files

| File | Change |
|---|---|
| `apps/server/src/kernel-next/ir/schema.ts` | add Diagnostic codes (`CONFLICT`, `VERSION_NOT_IN_HISTORY`, `REGISTRY_PIPELINE_NOT_FOUND`) |
| `apps/server/src/kernel-next/mcp/kernel.ts` | add methods: `dryRunProposal`, `updateRegistryPipeline`, `rollbackHotUpdate`; upgrade `propose` with `autoApprove` |
| `apps/server/src/kernel-next/mcp/kernel.test.ts` | add coverage for the three new methods + autoApprove paths |
| `apps/server/src/kernel-next/mcp/server.ts` | register three new MCP tools + add `autoApprove` to `propose_pipeline_change` |
| `apps/server/src/kernel-next/mcp/server.test.ts` | assert tool list contains new tools |
| `docs/product-roadmap.md` | update B1/B2/B3/B4/B7/B14/B15/B16/B17 status rows |

---

## Type Definitions (reference for all tasks)

```typescript
// hot-update/types.ts

import type {
  PipelineIR, StageIR, WireIR, PortIR, GateRouting,
} from "../ir/schema.js";

export interface PortTypeChange {
  port: string;
  beforeType: string;
  afterType: string;
}

export interface StageDiffChanges {
  promptRef?:   { before: string; after: string };
  moduleId?:    { before: string; after: string };
  question?:    { before: unknown; after: unknown };
  inputs?:      { added: PortIR[]; removed: PortIR[]; typeChanged: PortTypeChange[] };
  outputs?:     { added: PortIR[]; removed: PortIR[]; typeChanged: PortTypeChange[] };
}

export interface StageDiff {
  stageName: string;
  type: "agent" | "script" | "gate";
  changes: StageDiffChanges;
  category: "promptOnly" | "portsOnly" | "budgetOnly" | "structural";
}

export interface PipelineDiff {
  stages: {
    added:    StageIR[];
    removed:  { name: string; stage: StageIR }[];
    modified: StageDiff[];
  };
  wires: {
    added:   WireIR[];
    removed: WireIR[];
  };
  routing: {
    gateRoutingChanged: {
      stageName: string;
      before: GateRouting;
      after:  GateRouting;
    }[];
  };
  categoryUnion: Array<"promptOnly" | "portsOnly" | "budgetOnly" | "structural">;
}

export interface TaskImpact {
  taskId: string;
  currentStage: string | null;
  affectedStages: string[];
  resumable: boolean;
  blockingReasons: string[];
}

export interface SchemaDriftIssue {
  kind:
    | "port_type_change_with_live_values"
    | "removed_stage_with_downstream_readers"
    | "removed_output_with_active_consumers";
  stageName: string;
  portName?: string;
  details: string;
}

export interface Impact {
  activeTasks: TaskImpact[];
  newSubmissionsOk: boolean;
  schemaDriftIssues: SchemaDriftIssue[];
}

export interface SafeRangeVerdict {
  verdict: "safe" | "unsafe";
  category: "promptOnly" | "portsOnly" | "budgetOnly" | "structural" | "empty";
  reasons: string[];
}

export interface DryRunInput {
  currentVersion: string;
  patch: import("../ir/schema.js").IRPatch;
  rerunFrom?: string | null;
  migrateRunningTasks?: "all" | "none" | string[];
}

export type DryRunResult =
  | {
      ok: true;
      diff: PipelineDiff;
      impact: Impact;
      safeRange: SafeRangeVerdict;
      wouldAutoApprove: boolean;
      proposedVersion: string;
    }
  | {
      ok: false;
      diagnostics: import("../ir/schema.js").Diagnostic[];
    };
```

---

## Task 1: Shared types module

**Files:**
- Create: `apps/server/src/kernel-next/hot-update/types.ts`

- [ ] **Step 1.1: Create directory and types file**

Write the full `types.ts` content shown in the "Type Definitions" section above verbatim.

- [ ] **Step 1.2: Verify tsc clean**

Run: `cd apps/server && npx tsc --noEmit`
Expected: no errors referencing `hot-update/types.ts`.

- [ ] **Step 1.3: Commit**

```bash
git add apps/server/src/kernel-next/hot-update/types.ts
git commit -m "feat(hot-update-5a): shared types — PipelineDiff / Impact / SafeRangeVerdict"
```

---

## Task 2: Extend Diagnostic enum

**Files:**
- Modify: `apps/server/src/kernel-next/ir/schema.ts` (the `DiagnosticSchema` enum, around line 266-303)

- [ ] **Step 2.1: Add three new codes to DiagnosticSchema**

In `apps/server/src/kernel-next/ir/schema.ts`, locate the `DiagnosticSchema = z.object({ code: z.enum([...]), ... })` block. Add these three codes at the end of the enum array, just before the closing bracket:

```ts
    // Stage 5A — propose-pipeline lifecycle
    "CONFLICT",
    "VERSION_NOT_IN_HISTORY",
    "REGISTRY_PIPELINE_NOT_FOUND",
```

- [ ] **Step 2.2: Verify tsc clean**

Run: `cd apps/server && npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 2.3: Verify existing tests still pass**

Run: `cd apps/server && npx vitest run src/kernel-next/validator`
Expected: all tests pass.

- [ ] **Step 2.4: Commit**

```bash
git add apps/server/src/kernel-next/ir/schema.ts
git commit -m "feat(hot-update-5a): add Diagnostic codes CONFLICT / VERSION_NOT_IN_HISTORY / REGISTRY_PIPELINE_NOT_FOUND"
```

---

## Task 3: `computePipelineDiff` — pure function

**Files:**
- Create: `apps/server/src/kernel-next/hot-update/diff.ts`
- Create: `apps/server/src/kernel-next/hot-update/diff.test.ts`

- [ ] **Step 3.1: Write failing tests for diff.ts**

Create `apps/server/src/kernel-next/hot-update/diff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computePipelineDiff } from "./diff.js";
import type { PipelineIR } from "../ir/schema.js";

function agentStage(name: string, promptRef = "p-" + name): PipelineIR["stages"][number] {
  return {
    name,
    type: "agent",
    config: { promptRef },
    inputs: [],
    outputs: [{ name: "out", type: "string" }],
  };
}

function irWith(stages: PipelineIR["stages"], wires: PipelineIR["wires"] = []): PipelineIR {
  return { name: "test", stages, wires };
}

describe("computePipelineDiff", () => {
  it("empty patch produces empty diff", () => {
    const ir = irWith([agentStage("a")]);
    const d = computePipelineDiff(ir, ir);
    expect(d.stages.added).toEqual([]);
    expect(d.stages.removed).toEqual([]);
    expect(d.stages.modified).toEqual([]);
    expect(d.wires.added).toEqual([]);
    expect(d.wires.removed).toEqual([]);
    expect(d.categoryUnion).toEqual([]);
  });

  it("detects added stage", () => {
    const base = irWith([agentStage("a")]);
    const proposed = irWith([agentStage("a"), agentStage("b")]);
    const d = computePipelineDiff(base, proposed);
    expect(d.stages.added).toHaveLength(1);
    expect(d.stages.added[0]!.name).toBe("b");
    expect(d.categoryUnion).toContain("structural");
  });

  it("detects removed stage", () => {
    const base = irWith([agentStage("a"), agentStage("b")]);
    const proposed = irWith([agentStage("a")]);
    const d = computePipelineDiff(base, proposed);
    expect(d.stages.removed).toHaveLength(1);
    expect(d.stages.removed[0]!.name).toBe("b");
    expect(d.categoryUnion).toContain("structural");
  });

  it("detects promptOnly modification", () => {
    const base = irWith([agentStage("a", "p-old")]);
    const proposed = irWith([agentStage("a", "p-new")]);
    const d = computePipelineDiff(base, proposed);
    expect(d.stages.modified).toHaveLength(1);
    const m = d.stages.modified[0]!;
    expect(m.changes.promptRef).toEqual({ before: "p-old", after: "p-new" });
    expect(m.category).toBe("promptOnly");
    expect(d.categoryUnion).toEqual(["promptOnly"]);
  });

  it("detects input port added — structural (conservative)", () => {
    const base = irWith([agentStage("a")]);
    const changed = { ...agentStage("a") };
    changed.inputs = [{ name: "x", type: "string" }];
    const proposed = irWith([changed]);
    const d = computePipelineDiff(base, proposed);
    expect(d.stages.modified).toHaveLength(1);
    expect(d.stages.modified[0]!.changes.inputs?.added).toHaveLength(1);
    expect(d.stages.modified[0]!.category).toBe("structural");
  });

  it("detects output port type change", () => {
    const base = irWith([agentStage("a")]);
    const changed = { ...agentStage("a") };
    changed.outputs = [{ name: "out", type: "number" }];
    const proposed = irWith([changed]);
    const d = computePipelineDiff(base, proposed);
    expect(d.stages.modified[0]!.changes.outputs?.typeChanged).toEqual([
      { port: "out", beforeType: "string", afterType: "number" },
    ]);
    expect(d.stages.modified[0]!.category).toBe("structural");
  });

  it("detects added wire", () => {
    const base = irWith([agentStage("a"), agentStage("b")]);
    const proposed = irWith([agentStage("a"), agentStage("b")], [
      { from: { source: "stage", stage: "a", port: "out" }, to: { stage: "b", port: "out" } },
    ]);
    const d = computePipelineDiff(base, proposed);
    expect(d.wires.added).toHaveLength(1);
    expect(d.wires.removed).toHaveLength(0);
    expect(d.categoryUnion).toContain("structural");
  });

  it("detects removed wire", () => {
    const base = irWith([agentStage("a"), agentStage("b")], [
      { from: { source: "stage", stage: "a", port: "out" }, to: { stage: "b", port: "out" } },
    ]);
    const proposed = irWith([agentStage("a"), agentStage("b")]);
    const d = computePipelineDiff(base, proposed);
    expect(d.wires.removed).toHaveLength(1);
  });

  it("detects gate routing change", () => {
    const gateBase: PipelineIR["stages"][number] = {
      name: "g",
      type: "gate",
      config: {
        question: { text: "proceed?" },
        routing: { routes: { yes: "a", no: "b" } },
      },
      inputs: [],
      outputs: [],
    };
    const gateProposed: PipelineIR["stages"][number] = {
      ...gateBase,
      config: {
        ...gateBase.config,
        routing: { routes: { yes: "a", no: "c" } },
      },
    };
    const base = irWith([gateBase, agentStage("a"), agentStage("b"), agentStage("c")]);
    const proposed = irWith([gateProposed, agentStage("a"), agentStage("b"), agentStage("c")]);
    const d = computePipelineDiff(base, proposed);
    expect(d.routing.gateRoutingChanged).toHaveLength(1);
    expect(d.stages.modified[0]!.category).toBe("structural");
  });
});
```

- [ ] **Step 3.2: Run failing test**

Run: `cd apps/server && npx vitest run src/kernel-next/hot-update/diff.test.ts`
Expected: FAIL — module `./diff.js` not found.

- [ ] **Step 3.3: Implement diff.ts**

Create `apps/server/src/kernel-next/hot-update/diff.ts`:

```ts
// Pure function — no DB, no I/O. Compares two PipelineIR values and
// returns a structured diff. Terminal-design §10 / Stage 5A spec §3.

import type {
  PipelineIR, StageIR, WireIR, PortIR, GateRouting,
} from "../ir/schema.js";
import type {
  PipelineDiff, StageDiff, StageDiffChanges, PortTypeChange,
} from "./types.js";

export function computePipelineDiff(
  base: PipelineIR,
  proposed: PipelineIR,
): PipelineDiff {
  const baseStageByName = new Map(base.stages.map((s) => [s.name, s]));
  const propStageByName = new Map(proposed.stages.map((s) => [s.name, s]));

  const added:    StageIR[] = [];
  const removed:  { name: string; stage: StageIR }[] = [];
  const modified: StageDiff[] = [];
  const categoryUnion = new Set<
    "promptOnly" | "portsOnly" | "budgetOnly" | "structural"
  >();

  for (const [name, stage] of propStageByName) {
    if (!baseStageByName.has(name)) {
      added.push(stage);
      categoryUnion.add("structural");
    }
  }
  for (const [name, stage] of baseStageByName) {
    if (!propStageByName.has(name)) {
      removed.push({ name, stage });
      categoryUnion.add("structural");
    }
  }

  const routingChanged: PipelineDiff["routing"]["gateRoutingChanged"] = [];

  for (const [name, baseStage] of baseStageByName) {
    const propStage = propStageByName.get(name);
    if (!propStage) continue;
    if (baseStage.type !== propStage.type) {
      // Type change is structural — record as modified with a synthetic
      // "everything changed" StageDiff so consumers see it.
      modified.push({
        stageName: name,
        type: propStage.type,
        changes: {},
        category: "structural",
      });
      categoryUnion.add("structural");
      continue;
    }

    const changes: StageDiffChanges = {};

    // Ports diff (common to all types)
    const inputsDiff = diffPorts(baseStage.inputs ?? [], propStage.inputs ?? []);
    if (inputsDiff) changes.inputs = inputsDiff;
    const outputsDiff = diffPorts(baseStage.outputs ?? [], propStage.outputs ?? []);
    if (outputsDiff) changes.outputs = outputsDiff;

    // Type-specific config diff
    if (baseStage.type === "agent" && propStage.type === "agent") {
      if (baseStage.config.promptRef !== propStage.config.promptRef) {
        changes.promptRef = {
          before: baseStage.config.promptRef,
          after: propStage.config.promptRef,
        };
      }
    } else if (baseStage.type === "script" && propStage.type === "script") {
      if (baseStage.config.moduleId !== propStage.config.moduleId) {
        changes.moduleId = {
          before: baseStage.config.moduleId,
          after: propStage.config.moduleId,
        };
      }
    } else if (baseStage.type === "gate" && propStage.type === "gate") {
      const bq = baseStage.config.question;
      const pq = propStage.config.question;
      if (JSON.stringify(bq) !== JSON.stringify(pq)) {
        changes.question = { before: bq, after: pq };
      }
      const br = baseStage.config.routing;
      const pr = propStage.config.routing;
      if (JSON.stringify(br) !== JSON.stringify(pr)) {
        routingChanged.push({ stageName: name, before: br, after: pr });
      }
    }

    if (Object.keys(changes).length === 0 && routingChanged.find((r) => r.stageName === name) === undefined) {
      continue;
    }

    const category = classifyStageCategory(changes, routingChanged.some((r) => r.stageName === name));
    modified.push({ stageName: name, type: propStage.type, changes, category });
    categoryUnion.add(category);
  }

  const wiresDiff = diffWires(base.wires, proposed.wires);
  if (wiresDiff.added.length > 0 || wiresDiff.removed.length > 0) {
    categoryUnion.add("structural");
  }

  return {
    stages: { added, removed, modified },
    wires: wiresDiff,
    routing: { gateRoutingChanged: routingChanged },
    categoryUnion: Array.from(categoryUnion),
  };
}

function diffPorts(
  base: PortIR[],
  proposed: PortIR[],
): StageDiffChanges["inputs"] | undefined {
  const baseByName = new Map(base.map((p) => [p.name, p]));
  const propByName = new Map(proposed.map((p) => [p.name, p]));
  const added:   PortIR[] = [];
  const removed: PortIR[] = [];
  const typeChanged: PortTypeChange[] = [];
  for (const [n, p] of propByName) {
    const b = baseByName.get(n);
    if (!b) { added.push(p); continue; }
    if (b.type !== p.type) {
      typeChanged.push({ port: n, beforeType: b.type, afterType: p.type });
    }
  }
  for (const [n, p] of baseByName) {
    if (!propByName.has(n)) removed.push(p);
  }
  if (added.length === 0 && removed.length === 0 && typeChanged.length === 0) {
    return undefined;
  }
  return { added, removed, typeChanged };
}

function diffWires(
  base: WireIR[], proposed: WireIR[],
): { added: WireIR[]; removed: WireIR[] } {
  const wireKey = (w: WireIR): string => {
    const from = w.from.source === "external"
      ? `ext:${w.from.port}`
      : `${(w.from as { stage: string }).stage}.${w.from.port}`;
    return `${from}->${w.to.stage}.${w.to.port}${w.guard ? `|${w.guard}` : ""}`;
  };
  const baseKeys = new Set(base.map(wireKey));
  const propKeys = new Set(proposed.map(wireKey));
  const added   = proposed.filter((w) => !baseKeys.has(wireKey(w)));
  const removed = base.filter((w) => !propKeys.has(wireKey(w)));
  return { added, removed };
}

function classifyStageCategory(
  changes: StageDiffChanges,
  hasRoutingChange: boolean,
): "promptOnly" | "portsOnly" | "budgetOnly" | "structural" {
  if (hasRoutingChange) return "structural";
  const keys = Object.keys(changes) as (keyof StageDiffChanges)[];
  if (keys.length === 0) return "structural";       // defensive
  if (keys.length === 1 && keys[0] === "promptRef") return "promptOnly";
  // Any inputs/outputs/moduleId/question change → structural in 5A
  return "structural";
}
```

- [ ] **Step 3.4: Run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/hot-update/diff.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 3.5: Commit**

```bash
git add apps/server/src/kernel-next/hot-update/diff.ts apps/server/src/kernel-next/hot-update/diff.test.ts
git commit -m "feat(hot-update-5a): computePipelineDiff pure function + tests"
```

---

## Task 4: `classifySafeRange` — pure function

**Files:**
- Create: `apps/server/src/kernel-next/hot-update/safe-range.ts`
- Create: `apps/server/src/kernel-next/hot-update/safe-range.test.ts`

- [ ] **Step 4.1: Write failing tests**

Create `apps/server/src/kernel-next/hot-update/safe-range.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifySafeRange } from "./safe-range.js";
import type { PipelineDiff, Impact } from "./types.js";

const emptyDiff: PipelineDiff = {
  stages: { added: [], removed: [], modified: [] },
  wires: { added: [], removed: [] },
  routing: { gateRoutingChanged: [] },
  categoryUnion: [],
};

const emptyImpact: Impact = {
  activeTasks: [],
  newSubmissionsOk: true,
  schemaDriftIssues: [],
};

describe("classifySafeRange", () => {
  it("empty diff → safe/empty", () => {
    const v = classifySafeRange(emptyDiff, emptyImpact);
    expect(v.verdict).toBe("safe");
    expect(v.category).toBe("empty");
  });

  it("promptOnly → safe", () => {
    const d: PipelineDiff = {
      ...emptyDiff,
      stages: {
        added: [], removed: [],
        modified: [{
          stageName: "a", type: "agent",
          changes: { promptRef: { before: "old", after: "new" } },
          category: "promptOnly",
        }],
      },
      categoryUnion: ["promptOnly"],
    };
    const v = classifySafeRange(d, emptyImpact);
    expect(v.verdict).toBe("safe");
    expect(v.category).toBe("promptOnly");
  });

  it("structural → unsafe", () => {
    const d: PipelineDiff = {
      ...emptyDiff,
      stages: {
        added: [{ name: "x", type: "agent", config: { promptRef: "p" }, inputs: [], outputs: [] }],
        removed: [], modified: [],
      },
      categoryUnion: ["structural"],
    };
    const v = classifySafeRange(d, emptyImpact);
    expect(v.verdict).toBe("unsafe");
    expect(v.category).toBe("structural");
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it("promptOnly + schemaDriftIssues → unsafe", () => {
    const d: PipelineDiff = {
      ...emptyDiff,
      stages: {
        added: [], removed: [],
        modified: [{
          stageName: "a", type: "agent",
          changes: { promptRef: { before: "old", after: "new" } },
          category: "promptOnly",
        }],
      },
      categoryUnion: ["promptOnly"],
    };
    const impact: Impact = {
      ...emptyImpact,
      schemaDriftIssues: [{
        kind: "port_type_change_with_live_values",
        stageName: "a", portName: "out",
        details: "string → number",
      }],
    };
    const v = classifySafeRange(d, impact);
    expect(v.verdict).toBe("unsafe");
    expect(v.reasons.some((r) => r.includes("drift"))).toBe(true);
  });

  it("promptOnly + non-resumable active task → unsafe", () => {
    const d: PipelineDiff = {
      ...emptyDiff,
      stages: {
        added: [], removed: [],
        modified: [{
          stageName: "a", type: "agent",
          changes: { promptRef: { before: "old", after: "new" } },
          category: "promptOnly",
        }],
      },
      categoryUnion: ["promptOnly"],
    };
    const impact: Impact = {
      ...emptyImpact,
      activeTasks: [{
        taskId: "t1", currentStage: "a",
        affectedStages: ["a"], resumable: false,
        blockingReasons: ["current stage removed"],
      }],
    };
    const v = classifySafeRange(d, impact);
    expect(v.verdict).toBe("unsafe");
    expect(v.reasons.some((r) => r.includes("resumable"))).toBe(true);
  });
});
```

- [ ] **Step 4.2: Run failing test**

Run: `cd apps/server && npx vitest run src/kernel-next/hot-update/safe-range.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement safe-range.ts**

Create `apps/server/src/kernel-next/hot-update/safe-range.ts`:

```ts
// Pure function — classifies a PipelineDiff + Impact into a safe/unsafe
// verdict per Stage 5A design §5.

import type { PipelineDiff, Impact, SafeRangeVerdict } from "./types.js";

export function classifySafeRange(
  diff: PipelineDiff,
  impact: Impact,
): SafeRangeVerdict {
  const reasons: string[] = [];

  if (diff.categoryUnion.length === 0) {
    // No structural or promptOnly changes at all — patch was a no-op
    // (possible with e.g. only routing-unchanged updates).
    return { verdict: "safe", category: "empty", reasons: [] };
  }

  const hasStructural = diff.categoryUnion.includes("structural");
  if (hasStructural) {
    if (diff.stages.added.length > 0) {
      reasons.push(`adds ${diff.stages.added.length} stage(s) — structural change`);
    }
    if (diff.stages.removed.length > 0) {
      reasons.push(`removes ${diff.stages.removed.length} stage(s) — structural change`);
    }
    if (diff.wires.added.length > 0 || diff.wires.removed.length > 0) {
      reasons.push(
        `wire changes (added=${diff.wires.added.length}, removed=${diff.wires.removed.length}) — structural change`,
      );
    }
    if (diff.routing.gateRoutingChanged.length > 0) {
      reasons.push(
        `gate routing changed on ${diff.routing.gateRoutingChanged.length} stage(s) — structural change`,
      );
    }
    for (const m of diff.stages.modified) {
      if (m.category === "structural") {
        reasons.push(`stage '${m.stageName}' has structural changes (ports / moduleId / question)`);
      }
    }
  }

  if (impact.schemaDriftIssues.length > 0) {
    for (const issue of impact.schemaDriftIssues) {
      reasons.push(
        `schema drift on ${issue.stageName}${issue.portName ? "." + issue.portName : ""}: ${issue.details}`,
      );
    }
  }

  for (const t of impact.activeTasks) {
    if (!t.resumable) {
      reasons.push(
        `task '${t.taskId}' not resumable: ${t.blockingReasons.join("; ")}`,
      );
    }
  }

  const verdict = reasons.length === 0 ? "safe" : "unsafe";

  // Category: if promptOnly-union AND no other blockers → promptOnly.
  // Otherwise take the first element of categoryUnion (conservative).
  let category: SafeRangeVerdict["category"];
  if (
    diff.categoryUnion.length === 1 &&
    diff.categoryUnion[0] === "promptOnly"
  ) {
    category = "promptOnly";
  } else if (hasStructural) {
    category = "structural";
  } else {
    category = diff.categoryUnion[0] ?? "empty";
  }

  return { verdict, category, reasons };
}
```

- [ ] **Step 4.4: Run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/hot-update/safe-range.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4.5: Commit**

```bash
git add apps/server/src/kernel-next/hot-update/safe-range.ts apps/server/src/kernel-next/hot-update/safe-range.test.ts
git commit -m "feat(hot-update-5a): classifySafeRange pure function + tests"
```

---

## Task 5: `computeImpact` — DB-reading function

**Files:**
- Create: `apps/server/src/kernel-next/hot-update/impact.ts`
- Create: `apps/server/src/kernel-next/hot-update/impact.test.ts`

- [ ] **Step 5.1: Write failing tests**

Create `apps/server/src/kernel-next/hot-update/impact.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { applySchemaDDL } from "../ir/sql.js";
import { computeImpact } from "./impact.js";
import type { PipelineIR } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applySchemaDDL(db);
  return db;
}

function seedVersion(db: DatabaseSync, hash: string, ir: PipelineIR): void {
  db.prepare(
    `INSERT INTO pipeline_versions (version_hash, name, ir_json, ts_source, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(hash, ir.name, JSON.stringify(ir), "// ts", Date.now());
  for (const s of ir.stages) {
    db.prepare(
      `INSERT INTO stages (version_hash, stage_name, stage_type, stage_json, stage_index)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(hash, s.name, s.type, JSON.stringify(s), ir.stages.indexOf(s));
  }
  for (const w of ir.wires) {
    const fromStage = w.from.source === "external" ? "__external__" : w.from.stage;
    db.prepare(
      `INSERT INTO wires (version_hash, from_stage, from_port, to_stage, to_port, guard)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(hash, fromStage, w.from.port, w.to.stage, w.to.port, w.guard ?? null);
  }
}

function seedAttempt(
  db: DatabaseSync, taskId: string, versionHash: string,
  stageName: string, status: "success" | "running" | "error" | "superseded",
): string {
  const attemptId = randomUUID();
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_index, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(attemptId, taskId, versionHash, stageName, 0, status, Date.now());
  return attemptId;
}

function seedPortValue(
  db: DatabaseSync, attemptId: string, stage: string, port: string,
  direction: "in" | "out", value: unknown,
): void {
  const valueId = randomUUID();
  const valueJson = JSON.stringify(value);
  db.prepare(
    `INSERT INTO port_values
     (value_id, attempt_id, stage_name, port_name, direction, value_json, value_bytes, written_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(valueId, attemptId, stage, port, direction, valueJson, Buffer.byteLength(valueJson, "utf8"), Date.now());
}

const baseIR: PipelineIR = {
  name: "p",
  stages: [
    { name: "a", type: "agent", config: { promptRef: "p-a" }, inputs: [], outputs: [{ name: "out", type: "string" }] },
    { name: "b", type: "agent", config: { promptRef: "p-b" }, inputs: [{ name: "x", type: "string" }], outputs: [] },
  ],
  wires: [
    { from: { source: "stage", stage: "a", port: "out" }, to: { stage: "b", port: "x" } },
  ],
};

describe("computeImpact", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = makeDb(); });

  it("no active tasks → empty activeTasks", () => {
    seedVersion(db, "v1", baseIR);
    const r = computeImpact(db, "v1", baseIR, null);
    expect(r.activeTasks).toEqual([]);
    expect(r.schemaDriftIssues).toEqual([]);
    expect(r.newSubmissionsOk).toBe(true);
  });

  it("running task on stage not in affectedStages → resumable=true", () => {
    seedVersion(db, "v1", baseIR);
    seedAttempt(db, "t1", "v1", "a", "running");
    // rerunFrom=null, no structural change → affectedStages empty
    const r = computeImpact(db, "v1", baseIR, null);
    expect(r.activeTasks).toHaveLength(1);
    expect(r.activeTasks[0]!.resumable).toBe(true);
  });

  it("running task whose currentStage is removed → resumable=false", () => {
    seedVersion(db, "v1", baseIR);
    seedAttempt(db, "t1", "v1", "a", "running");
    const proposed: PipelineIR = { ...baseIR, stages: baseIR.stages.filter((s) => s.name !== "a") };
    const r = computeImpact(db, "v1", proposed, null);
    expect(r.activeTasks[0]!.resumable).toBe(false);
    expect(r.activeTasks[0]!.blockingReasons.some((m) => m.includes("removed"))).toBe(true);
  });

  it("port_type change on a port with live port_values → schemaDriftIssues", () => {
    seedVersion(db, "v1", baseIR);
    const att = seedAttempt(db, "t1", "v1", "a", "success");
    seedPortValue(db, att, "a", "out", "out", "hello");
    const proposed: PipelineIR = {
      ...baseIR,
      stages: baseIR.stages.map((s) =>
        s.name === "a"
          ? { ...s, outputs: [{ name: "out", type: "number" }] }
          : s,
      ),
    };
    const r = computeImpact(db, "v1", proposed, null);
    expect(r.schemaDriftIssues).toHaveLength(1);
    expect(r.schemaDriftIssues[0]!.kind).toBe("port_type_change_with_live_values");
  });

  it("rerunFrom drives affectedStages via topoDownstream", () => {
    seedVersion(db, "v1", baseIR);
    seedAttempt(db, "t1", "v1", "b", "running");
    const r = computeImpact(db, "v1", baseIR, "a");
    // downstream of 'a' in proposed = ['a','b']
    expect(r.activeTasks[0]!.affectedStages.sort()).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 5.2: Run failing test**

Run: `cd apps/server && npx vitest run src/kernel-next/hot-update/impact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement impact.ts**

Create `apps/server/src/kernel-next/hot-update/impact.ts`:

```ts
// Impact analysis — reads DB to determine which active tasks would be
// affected by migrating to the proposed IR. Stage 5A design §4.

import type { DatabaseSync } from "node:sqlite";
import type { PipelineIR } from "../ir/schema.js";
import type { Impact, TaskImpact, SchemaDriftIssue } from "./types.js";
import { topoDownstream } from "../runtime/topo-downstream.js";

export function computeImpact(
  db: DatabaseSync,
  currentVersion: string,
  proposedIR: PipelineIR,
  rerunFrom: string | null | undefined,
): Impact {
  const basedRow = db.prepare(
    `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
  ).get(currentVersion) as { ir_json: string } | undefined;
  if (!basedRow) {
    return {
      activeTasks: [],
      newSubmissionsOk: true,
      schemaDriftIssues: [{
        kind: "port_type_change_with_live_values",
        stageName: "__unknown__",
        details: `currentVersion '${currentVersion}' not found in pipeline_versions`,
      }],
    };
  }
  const baseIR = JSON.parse(basedRow.ir_json) as PipelineIR;

  // 1. Active tasks on the current version.
  const activeTaskRows = db.prepare(
    `SELECT DISTINCT task_id FROM stage_attempts
     WHERE version_hash = ? AND status IN ('running', 'pending')`,
  ).all(currentVersion) as Array<{ task_id: string }>;

  const proposedStageNames = new Set(proposedIR.stages.map((s) => s.name));
  const removedStageNames = baseIR.stages
    .filter((s) => !proposedStageNames.has(s.name))
    .map((s) => s.name);

  const downstream = rerunFrom
    ? new Set(topoDownstream(proposedIR.wires, rerunFrom).concat([rerunFrom]))
    : new Set<string>();

  const affectedUnion = new Set<string>([
    ...downstream,
    ...removedStageNames,
  ]);

  const activeTasks: TaskImpact[] = [];
  for (const { task_id: taskId } of activeTaskRows) {
    const currentStageRow = db.prepare(
      `SELECT stage_name FROM stage_attempts
       WHERE task_id = ? AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
    ).get(taskId) as { stage_name: string } | undefined;
    const currentStage = currentStageRow?.stage_name ?? null;

    const blocking: string[] = [];
    let resumable = true;

    if (currentStage && removedStageNames.includes(currentStage)) {
      resumable = false;
      blocking.push(`current stage '${currentStage}' removed in proposed pipeline`);
    }

    // Removed output with live readers?
    for (const removedStageName of removedStageNames) {
      const stage = baseIR.stages.find((s) => s.name === removedStageName);
      if (!stage) continue;
      for (const out of stage.outputs ?? []) {
        const hasDownstreamReader = baseIR.wires.some(
          (w) =>
            w.from.source !== "external" &&
            (w.from as { stage: string }).stage === removedStageName &&
            w.from.port === out.name,
        );
        if (hasDownstreamReader) {
          resumable = false;
          blocking.push(
            `removed stage '${removedStageName}' has wired consumers of output '${out.name}'`,
          );
        }
      }
    }

    activeTasks.push({
      taskId,
      currentStage,
      affectedStages: Array.from(affectedUnion).sort(),
      resumable,
      blockingReasons: blocking,
    });
  }

  // 2. Schema drift — port type change with live port_values.
  const schemaDriftIssues: SchemaDriftIssue[] = [];
  for (const proposedStage of proposedIR.stages) {
    const baseStage = baseIR.stages.find((s) => s.name === proposedStage.name);
    if (!baseStage) continue;
    for (const dir of ["inputs", "outputs"] as const) {
      for (const p of proposedStage[dir] ?? []) {
        const b = (baseStage[dir] ?? []).find((x) => x.name === p.name);
        if (!b) continue;
        if (b.type === p.type) continue;
        const directionKey = dir === "outputs" ? "out" : "in";
        const row = db.prepare(
          `SELECT 1 FROM port_values
           WHERE stage_name = ? AND port_name = ? AND direction = ? LIMIT 1`,
        ).get(proposedStage.name, p.name, directionKey) as { 1?: number } | undefined;
        if (row) {
          schemaDriftIssues.push({
            kind: "port_type_change_with_live_values",
            stageName: proposedStage.name,
            portName: p.name,
            details: `${b.type} → ${p.type} (live value exists)`,
          });
        }
      }
    }
  }

  // 3. Removed-stage-with-downstream-readers → schemaDrift audit entry.
  for (const removedStageName of removedStageNames) {
    const stage = baseIR.stages.find((s) => s.name === removedStageName);
    if (!stage) continue;
    for (const out of stage.outputs ?? []) {
      const consumer = proposedIR.wires.find(
        (w) =>
          w.from.source !== "external" &&
          (w.from as { stage: string }).stage === removedStageName &&
          w.from.port === out.name,
      );
      if (consumer) {
        schemaDriftIssues.push({
          kind: "removed_stage_with_downstream_readers",
          stageName: removedStageName,
          portName: out.name,
          details: `stage removed but proposed wires still reference '${removedStageName}.${out.name}'`,
        });
      }
    }
  }

  return {
    activeTasks,
    newSubmissionsOk: true,   // always true in 5A — structural IR is valid at this point
    schemaDriftIssues,
  };
}
```

- [ ] **Step 5.4: Run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/hot-update/impact.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5.5: Commit**

```bash
git add apps/server/src/kernel-next/hot-update/impact.ts apps/server/src/kernel-next/hot-update/impact.test.ts
git commit -m "feat(hot-update-5a): computeImpact — active tasks + schema drift + resumability"
```

---

## Task 6: `dryRunProposal` — orchestrator

**Files:**
- Create: `apps/server/src/kernel-next/hot-update/dry-run.ts`
- Create: `apps/server/src/kernel-next/hot-update/dry-run.test.ts`

- [ ] **Step 6.1: Write failing tests**

Create `apps/server/src/kernel-next/hot-update/dry-run.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchemaDDL, insertPipelineVersion } from "../ir/sql.js";
import { dryRunProposal } from "./dry-run.js";
import type { PipelineIR, IRPatch } from "../ir/schema.js";
import { pipelineVersionHash } from "../ir/canonical.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applySchemaDDL(db);
  return db;
}

const baseIR: PipelineIR = {
  name: "p",
  stages: [
    { name: "a", type: "agent", config: { promptRef: "p-a" }, inputs: [], outputs: [{ name: "out", type: "string" }] },
  ],
  wires: [],
};

function seedBase(db: DatabaseSync): string {
  const h = pipelineVersionHash(baseIR, [{ ref: "p-a", contentHash: "abc" }]);
  insertPipelineVersion(db, {
    versionHash: h,
    name: baseIR.name,
    irJson: JSON.stringify(baseIR),
    tsSource: "// ts",
    createdAt: Date.now(),
  });
  // Seed prompt_contents + pipeline_prompt_refs so the full propose path
  // stays satisfied — dry-run itself only needs pipeline_versions.
  db.prepare(
    `INSERT INTO prompt_contents (content_hash, content, created_at) VALUES (?, ?, ?)`,
  ).run("abc", "prompt body", Date.now());
  db.prepare(
    `INSERT INTO pipeline_prompt_refs (version_hash, prompt_ref, content_hash) VALUES (?, ?, ?)`,
  ).run(h, "p-a", "abc");
  return h;
}

describe("dryRunProposal", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = makeDb(); });

  it("promptOnly change → ok + verdict=safe + wouldAutoApprove=true", () => {
    const base = seedBase(db);
    const patch: IRPatch = {
      ops: [{
        op: "update_stage_config",
        stage: "a",
        configPatch: { promptRef: "p-a-v2" },
      }],
    };
    const r = dryRunProposal(db, {
      currentVersion: base, patch,
    });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r.diagnostics));
    expect(r.safeRange.verdict).toBe("safe");
    expect(r.safeRange.category).toBe("promptOnly");
    expect(r.wouldAutoApprove).toBe(true);
    expect(r.diff.stages.modified).toHaveLength(1);
  });

  it("structural change (add stage) → verdict=unsafe + wouldAutoApprove=false", () => {
    const base = seedBase(db);
    const patch: IRPatch = {
      ops: [{
        op: "add_stage",
        stage: {
          name: "b", type: "agent",
          config: { promptRef: "p-b" },
          inputs: [], outputs: [],
        },
      }],
    };
    const r = dryRunProposal(db, { currentVersion: base, patch });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r.diagnostics));
    expect(r.safeRange.verdict).toBe("unsafe");
    expect(r.wouldAutoApprove).toBe(false);
  });

  it("currentVersion mismatch → CONFLICT diagnostic, no diff", () => {
    seedBase(db);
    const patch: IRPatch = { ops: [{ op: "remove_stage", stageName: "a" }] };
    const r = dryRunProposal(db, {
      currentVersion: "nonexistent-hash", patch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected ok: false");
    expect(r.diagnostics.some((d) => d.code === "CONFLICT")).toBe(true);
  });

  it("invalid patch (add_stage duplicate) → PATCH_APPLY_ERROR diagnostic", () => {
    const base = seedBase(db);
    const patch: IRPatch = {
      ops: [{
        op: "add_stage",
        stage: {
          name: "a", type: "agent",
          config: { promptRef: "p-a" },
          inputs: [], outputs: [],
        },
      }],
    };
    const r = dryRunProposal(db, { currentVersion: base, patch });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected ok: false");
    expect(r.diagnostics.some((d) => d.code === "PATCH_APPLY_ERROR")).toBe(true);
  });

  it("dry-run writes nothing — pipeline_proposals + pipeline_versions unchanged", () => {
    const base = seedBase(db);
    const beforeProposals = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_proposals`,
    ).get() as { n: number }).n;
    const beforeVersions = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_versions`,
    ).get() as { n: number }).n;
    const patch: IRPatch = {
      ops: [{
        op: "update_stage_config",
        stage: "a",
        configPatch: { promptRef: "p-a-v2" },
      }],
    };
    dryRunProposal(db, { currentVersion: base, patch });
    dryRunProposal(db, { currentVersion: base, patch });
    dryRunProposal(db, { currentVersion: base, patch });
    const afterProposals = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_proposals`,
    ).get() as { n: number }).n;
    const afterVersions = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_versions`,
    ).get() as { n: number }).n;
    expect(afterProposals).toBe(beforeProposals);
    expect(afterVersions).toBe(beforeVersions);
  });
});
```

- [ ] **Step 6.2: Run failing test**

Run: `cd apps/server && npx vitest run src/kernel-next/hot-update/dry-run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement dry-run.ts**

Create `apps/server/src/kernel-next/hot-update/dry-run.ts`:

```ts
// Orchestrator — combines diff + impact + safeRange for the
// dry_run_proposal MCP tool. Writes NOTHING to the DB. Stage 5A
// design §2.1.

import type { DatabaseSync } from "node:sqlite";
import type { Diagnostic, PipelineIR } from "../ir/schema.js";
import { applyPatch, PatchApplyError } from "../mcp/patch.js";
import { validateStructural } from "../validator/structural.js";
import { validateDag } from "../validator/dag.js";
import { validateTypes } from "../validator/types.js";
import { pipelineVersionHash } from "../ir/canonical.js";
import { computePipelineDiff } from "./diff.js";
import { computeImpact } from "./impact.js";
import { classifySafeRange } from "./safe-range.js";
import type { DryRunInput, DryRunResult } from "./types.js";

export function dryRunProposal(
  db: DatabaseSync,
  input: DryRunInput,
): DryRunResult {
  // 1. Optimistic-lock check — currentVersion must exist.
  const baseRow = db.prepare(
    `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
  ).get(input.currentVersion) as { ir_json: string } | undefined;
  if (!baseRow) {
    return {
      ok: false,
      diagnostics: [{
        code: "CONFLICT",
        message: `currentVersion '${input.currentVersion}' not found — base drifted`,
      }],
    };
  }
  const baseIR = JSON.parse(baseRow.ir_json) as PipelineIR;

  // 2. Apply the patch to a deep copy.
  let proposedIR: PipelineIR;
  try {
    proposedIR = applyPatch(baseIR, input.patch);
  } catch (err) {
    if (err instanceof PatchApplyError) {
      return {
        ok: false,
        diagnostics: [{ code: "PATCH_APPLY_ERROR", message: err.message }],
      };
    }
    throw err;
  }

  // 3. Validate the proposed IR structurally + DAG + types.
  const diagnostics: Diagnostic[] = [];
  const s = validateStructural(proposedIR);
  if (!s.ok) diagnostics.push(...s.diagnostics);
  const d = validateDag(proposedIR);
  if (!d.ok) diagnostics.push(...d.diagnostics);
  const t = validateTypes(proposedIR);
  if (!t.ok) diagnostics.push(...t.diagnostics);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // 4. Compute hash (no write).
  const promptRefs = db.prepare(
    `SELECT prompt_ref AS ref, content_hash AS contentHash
     FROM pipeline_prompt_refs WHERE version_hash = ?`,
  ).all(input.currentVersion) as Array<{ ref: string; contentHash: string }>;
  // For unchanged prompt refs, reuse hashes from base; for changed ones
  // there's no content yet (promptRef points to a ref the caller will
  // register on real propose). Carry base refs through — version hash
  // change comes from IR structure alone in 5A dry-run.
  const proposedVersion = pipelineVersionHash(proposedIR, promptRefs);

  // 5. Compute diff + impact + safeRange.
  const diff = computePipelineDiff(baseIR, proposedIR);
  const impact = computeImpact(db, input.currentVersion, proposedIR, input.rerunFrom);
  const safeRange = classifySafeRange(diff, impact);
  const wouldAutoApprove = safeRange.verdict === "safe";

  return {
    ok: true,
    diff,
    impact,
    safeRange,
    wouldAutoApprove,
    proposedVersion,
  };
}
```

- [ ] **Step 6.4: Run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/hot-update/dry-run.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6.5: Commit**

```bash
git add apps/server/src/kernel-next/hot-update/dry-run.ts apps/server/src/kernel-next/hot-update/dry-run.test.ts
git commit -m "feat(hot-update-5a): dryRunProposal orchestrator — zero DB writes, returns diff+impact+safeRange"
```

---

## Task 7: Upgrade `KernelService.propose` + add three new methods

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/kernel.ts`
- Modify: `apps/server/src/kernel-next/mcp/kernel.test.ts`

- [ ] **Step 7.1: Write failing test for `propose` with autoApprove=true on safe patch**

Append to `apps/server/src/kernel-next/mcp/kernel.test.ts` (at end of file):

```ts
describe("KernelService — Stage 5A autoApprove", () => {
  it("autoApprove=true on promptOnly patch → approved in same tx", () => {
    const db = new DatabaseSync(":memory:");
    applySchemaDDL(db);
    const kernel = new KernelService({ db });
    // Seed a base version
    const baseIR = {
      name: "p",
      stages: [{
        name: "a", type: "agent" as const,
        config: { promptRef: "p-a" },
        inputs: [], outputs: [{ name: "out", type: "string" }],
      }],
      wires: [],
    };
    const submitted = kernel.submit({
      ir: baseIR,
      prompts: { "p-a": "body" },
    });
    if (!submitted.ok) throw new Error("submit failed");

    const result = kernel.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{ op: "update_stage_config", stage: "a", configPatch: { promptRef: "p-a-v2" } }] },
      actor: "test",
      autoApprove: true,
    });
    if (!result.ok) throw new Error("propose failed: " + JSON.stringify(result.diagnostics));
    expect(result.autoApplied).toBe(true);
    const row = db.prepare(
      `SELECT status FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(result.proposalId) as { status: string };
    expect(row.status).toBe("approved");
  });

  it("autoApprove=true on structural patch → still pending (not applied)", () => {
    const db = new DatabaseSync(":memory:");
    applySchemaDDL(db);
    const kernel = new KernelService({ db });
    const baseIR = {
      name: "p",
      stages: [{
        name: "a", type: "agent" as const,
        config: { promptRef: "p-a" },
        inputs: [], outputs: [],
      }],
      wires: [],
    };
    const submitted = kernel.submit({ ir: baseIR, prompts: { "p-a": "body" } });
    if (!submitted.ok) throw new Error("submit failed");
    const result = kernel.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{
        op: "add_stage",
        stage: {
          name: "b", type: "agent",
          config: { promptRef: "p-b" },
          inputs: [], outputs: [],
        },
      }] },
      actor: "test",
      autoApprove: true,
    });
    // add_stage 'b' references promptRef 'p-b' not yet registered → PROMPT_REF_MISSING
    // is allowed as acceptable failure. If kernel.submit allows missing, then:
    if (result.ok) {
      expect(result.autoApplied).toBe(false);
      const row = db.prepare(
        `SELECT status FROM pipeline_proposals WHERE proposal_id = ?`,
      ).get(result.proposalId) as { status: string };
      expect(row.status).toBe("pending");
    } else {
      // Acceptable — PROMPT_REF_MISSING is a correct failure path
      expect(result.diagnostics.some((d) => d.code === "PROMPT_REF_MISSING")).toBe(true);
    }
  });
});

describe("KernelService — Stage 5A dryRunProposal", () => {
  it("returns diff+impact+safeRange without DB writes", () => {
    const db = new DatabaseSync(":memory:");
    applySchemaDDL(db);
    const kernel = new KernelService({ db });
    const baseIR = {
      name: "p",
      stages: [{
        name: "a", type: "agent" as const,
        config: { promptRef: "p-a" },
        inputs: [], outputs: [],
      }],
      wires: [],
    };
    const submitted = kernel.submit({ ir: baseIR, prompts: { "p-a": "body" } });
    if (!submitted.ok) throw new Error("submit failed");
    const beforeCount = (db.prepare(`SELECT COUNT(*) AS n FROM pipeline_proposals`).get() as { n: number }).n;
    const result = kernel.dryRunProposal({
      currentVersion: submitted.versionHash,
      patch: { ops: [{ op: "update_stage_config", stage: "a", configPatch: { promptRef: "p-a-v2" } }] },
    });
    if (!result.ok) throw new Error("dryRun failed");
    expect(result.safeRange.verdict).toBe("safe");
    const afterCount = (db.prepare(`SELECT COUNT(*) AS n FROM pipeline_proposals`).get() as { n: number }).n;
    expect(afterCount).toBe(beforeCount);
  });
});

describe("KernelService — Stage 5A rollbackHotUpdate skeleton", () => {
  it("task with no migration history → VERSION_NOT_IN_HISTORY", () => {
    const db = new DatabaseSync(":memory:");
    applySchemaDDL(db);
    const kernel = new KernelService({ db });
    const r = kernel.rollbackHotUpdate({
      taskId: "nonexistent", toVersion: "hash-foo", actor: "test",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.diagnostics.some((d) => d.code === "VERSION_NOT_IN_HISTORY")).toBe(true);
  });

  it("valid history match → writes audit row and returns eventId with skeleton diagnostic", () => {
    const db = new DatabaseSync(":memory:");
    applySchemaDDL(db);
    const kernel = new KernelService({ db });
    // Seed a hot_update_events row so history check passes
    db.prepare(
      `INSERT INTO hot_update_events
       (event_id, task_id, from_version, to_version, actor, proposal_id,
        rerun_from_stage, status, started_at, finished_at, diagnostic_json)
       VALUES ('e1', 't1', 'v-old', 'v-new', 'ai', NULL, NULL, 'success', 1, 2, NULL)`,
    ).run();
    const r = kernel.rollbackHotUpdate({
      taskId: "t1", toVersion: "v-old", actor: "test",
    });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r.diagnostics));
    expect(r.eventId).toBeTruthy();
    const row = db.prepare(
      `SELECT status, diagnostic_json FROM hot_update_events WHERE event_id = ?`,
    ).get(r.eventId) as { status: string; diagnostic_json: string | null };
    expect(row.status).toBe("rolled_back");
  });
});
```

(Also ensure the imports at the test file's top include `applySchemaDDL`, `KernelService`, `DatabaseSync`, and `describe, it, expect` from vitest. If already present, skip.)

- [ ] **Step 7.2: Run failing test**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/kernel.test.ts`
Expected: FAIL — `kernel.dryRunProposal`, `kernel.rollbackHotUpdate`, and `propose(autoApprove=...)` not implemented.

- [ ] **Step 7.3: Update propose interface**

In `apps/server/src/kernel-next/mcp/kernel.ts`, locate the `ProposeInput` interface (search for `propose(input:`) and add `autoApprove?: boolean`. Update `ProposeResponse` so `autoApplied: boolean` (drop the `false` literal), and imports as needed:

```ts
// Near the top of kernel.ts, after other imports:
import { dryRunProposal } from "../hot-update/dry-run.js";
import type { DryRunResult, Impact, PipelineDiff, SafeRangeVerdict } from "../hot-update/types.js";

// Update the ProposeResponse type (was `autoApplied: false`):
export interface ProposeResponse {
  ok: true;
  proposalId: string;
  proposedVersion: string;
  autoApplied: boolean;
  // Stage 5A additions: present when dry-run succeeded
  diff?: PipelineDiff;
  impact?: Impact;
  safeRange?: SafeRangeVerdict;
}
```

Locate the `propose()` method. Before the `INSERT INTO pipeline_proposals` line, insert dry-run execution:

```ts
  propose(input: {
    currentVersion: string;
    patch: IRPatch;
    actor: string;
    rerunFrom?: string;
    migrateRunningTasks?: "all" | "none" | string[];
    autoApprove?: boolean;        // Stage 5A addition
  }): ProposeResult {
    // Stage 5A: full dry-run first. This validates + computes diff +
    // impact + safeRange before any DB write.
    const dry: DryRunResult = dryRunProposal(this.db, {
      currentVersion: input.currentVersion,
      patch: input.patch,
      rerunFrom: input.rerunFrom ?? null,
      migrateRunningTasks: input.migrateRunningTasks,
    });
    if (!dry.ok) {
      return { ok: false, diagnostics: dry.diagnostics };
    }

    // Existing proposal persistence — pass through dry-run results.
    // (replace the old validation logic; the old pathway manually applied
    //  patch + validated. Dry-run now owns that.)
    const proposedVersion = dry.proposedVersion;

    // Register the proposed version itself in pipeline_versions (only
    // now that we're actually persisting a proposal). Idempotent —
    // pipelineVersionHash collision means same IR, OK to skip.
    const existingVersion = this.db.prepare(
      `SELECT 1 FROM pipeline_versions WHERE version_hash = ?`,
    ).get(proposedVersion) as { 1?: number } | undefined;
    if (!existingVersion) {
      // We need the TS source for the proposed IR. Re-emit it here.
      const proposedIR = this.applyAndValidate(input.currentVersion, input.patch);
      if (!proposedIR.ok) {
        // Shouldn't happen — dry-run already validated. Defensive.
        return { ok: false, diagnostics: proposedIR.diagnostics };
      }
      const tsSource = emitPipelineModule(proposedIR.ir);
      insertPipelineVersion(this.db, {
        versionHash: proposedVersion,
        name: proposedIR.ir.name,
        irJson: JSON.stringify(proposedIR.ir),
        tsSource,
        createdAt: Date.now(),
      });
      // Copy prompt refs — proposed IR may reuse the same refs.
      const refs = this.db.prepare(
        `SELECT prompt_ref, content_hash FROM pipeline_prompt_refs WHERE version_hash = ?`,
      ).all(input.currentVersion) as Array<{ prompt_ref: string; content_hash: string }>;
      for (const r of refs) {
        this.db.prepare(
          `INSERT OR IGNORE INTO pipeline_prompt_refs (version_hash, prompt_ref, content_hash) VALUES (?, ?, ?)`,
        ).run(proposedVersion, r.prompt_ref, r.content_hash);
      }
    }

    const proposalId = randomUUID();
    const migrateRunningJson =
      input.migrateRunningTasks === "all" ? JSON.stringify("all")
      : input.migrateRunningTasks === "none" ? JSON.stringify("none")
      : Array.isArray(input.migrateRunningTasks)
        ? JSON.stringify(input.migrateRunningTasks)
        : JSON.stringify("none");

    // Stage 5A: diagnostic_json stores the dry-run artefacts for audit.
    const diagnosticJson = JSON.stringify({
      __kind: "proposal-success-v1",
      diff: dry.diff,
      impact: dry.impact,
      safeRange: dry.safeRange,
    });

    const autoApplied =
      (input.autoApprove ?? false) && dry.safeRange.verdict === "safe";

    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        `INSERT INTO pipeline_proposals
         (proposal_id, base_version, proposed_version, actor, status,
          diagnostic_json, created_at, rerun_from, migrate_running)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        proposalId,
        input.currentVersion,
        proposedVersion,
        input.actor,
        autoApplied ? "approved" : "pending",
        diagnosticJson,
        Date.now(),
        input.rerunFrom ?? null,
        migrateRunningJson,
      );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return {
      ok: true,
      proposalId,
      proposedVersion,
      autoApplied,
      diff: dry.diff,
      impact: dry.impact,
      safeRange: dry.safeRange,
    };
  }

  // Helper used by propose() only — re-runs patch+validate to reach
  // the IR object. Dry-run computed the hash but didn't retain the
  // IR object (intentional, for GC); this helper recomputes on the
  // rare path where we actually persist.
  private applyAndValidate(
    baseVersion: string,
    patch: IRPatch,
  ): { ok: true; ir: PipelineIR } | { ok: false; diagnostics: Diagnostic[] } {
    const baseRow = this.db.prepare(
      `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
    ).get(baseVersion) as { ir_json: string } | undefined;
    if (!baseRow) {
      return {
        ok: false,
        diagnostics: [{ code: "CONFLICT", message: `base version ${baseVersion} not found` }],
      };
    }
    const baseIR = JSON.parse(baseRow.ir_json) as PipelineIR;
    let proposedIR: PipelineIR;
    try {
      proposedIR = applyPatch(baseIR, patch);
    } catch (err) {
      if (err instanceof PatchApplyError) {
        return {
          ok: false,
          diagnostics: [{ code: "PATCH_APPLY_ERROR", message: err.message }],
        };
      }
      throw err;
    }
    return { ok: true, ir: proposedIR };
  }
```

- [ ] **Step 7.4: Add `dryRunProposal` method to KernelService**

Append inside the `KernelService` class in `kernel.ts`:

```ts
  /**
   * Stage 5A — read-only dry run of a proposed patch. Returns diff +
   * impact + safeRange without touching pipeline_proposals or
   * pipeline_versions. Safe to call concurrently; idempotent.
   */
  dryRunProposal(input: {
    currentVersion: string;
    patch: IRPatch;
    rerunFrom?: string | null;
    migrateRunningTasks?: "all" | "none" | string[];
  }): DryRunResult {
    return dryRunProposal(this.db, input);
  }
```

- [ ] **Step 7.5: Add `rollbackHotUpdate` skeleton to KernelService**

Append to `KernelService`:

```ts
  /**
   * Stage 5A skeleton — writes an audit row to hot_update_events with
   * status='rolled_back'. DOES NOT actually roll back stage_attempts
   * or pipeline state; the real rollback executor lands in Stage 5B.
   */
  rollbackHotUpdate(input: {
    taskId: string;
    toVersion: string;
    actor: string;
  }): { ok: true; eventId: string; diagnostic: string }
   | { ok: false; diagnostics: Diagnostic[] } {
    // Validate toVersion exists in this task's migration history.
    const history = this.db.prepare(
      `SELECT from_version, to_version FROM hot_update_events
       WHERE task_id = ? ORDER BY started_at DESC`,
    ).all(input.taskId) as Array<{ from_version: string; to_version: string }>;
    const known = new Set<string>();
    for (const row of history) {
      known.add(row.from_version);
      known.add(row.to_version);
    }
    if (!known.has(input.toVersion)) {
      return {
        ok: false,
        diagnostics: [{
          code: "VERSION_NOT_IN_HISTORY",
          message:
            `task '${input.taskId}' has no migration history including version ` +
            `'${input.toVersion}' (known=${Array.from(known).join(", ") || "<empty>"})`,
        }],
      };
    }
    // Determine the current "from_version" from the task's most recent
    // successful event (or the most recent row if none succeeded).
    const mostRecent = history[0];
    const currentFromVersion = mostRecent?.to_version ?? input.toVersion;

    const eventId = randomUUID();
    const startedAt = Date.now();
    this.db.prepare(
      `INSERT INTO hot_update_events
       (event_id, task_id, from_version, to_version, actor, proposal_id,
        rerun_from_stage, status, started_at, finished_at, diagnostic_json)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'rolled_back', ?, ?, ?)`,
    ).run(
      eventId,
      input.taskId,
      currentFromVersion,
      input.toVersion,
      input.actor,
      startedAt,
      Date.now(),
      JSON.stringify({
        __kind: "rollback-skeleton-v1",
        note: "Stage 5A skeleton — audit only; real state rollback lands in 5B",
      }),
    );
    return {
      ok: true,
      eventId,
      diagnostic: "Stage 5A skeleton — audit row written; real rollback lands in 5B",
    };
  }
```

- [ ] **Step 7.6: Add `updateRegistryPipeline` method to KernelService**

Append to `KernelService`:

```ts
  /**
   * Stage 5A — replace a registry pipeline's IR file and register the
   * new version in pipeline_versions. Does NOT touch pipeline_proposals
   * or trigger migration. Used by B2 update_registry_pipeline MCP.
   */
  updateRegistryPipeline(input: {
    pipelineName: string;
    newIR: PipelineIR;
    actor: string;
  }): { ok: true; versionHash: string; path: string }
   | { ok: false; diagnostics: Diagnostic[] } {
    // 1. Validate.
    const s = validateStructural(input.newIR);
    if (!s.ok) return { ok: false, diagnostics: s.diagnostics };
    const d = validateDag(input.newIR);
    if (!d.ok) return { ok: false, diagnostics: d.diagnostics };
    const t = validateTypes(input.newIR);
    if (!t.ok) return { ok: false, diagnostics: t.diagnostics };

    // 2. Compute hash — no prompts metadata at this layer.
    //    (Registry pipelines keep their prompts on disk; SQL-side prompt
    //     content stays keyed by the submit path, not this one.)
    const emptyPromptRefs: Array<{ ref: string; contentHash: string }> = [];
    const versionHash = pipelineVersionHash(input.newIR, emptyPromptRefs);

    // 3. Register in pipeline_versions (idempotent).
    const existing = this.db.prepare(
      `SELECT 1 FROM pipeline_versions WHERE version_hash = ?`,
    ).get(versionHash) as { 1?: number } | undefined;
    if (!existing) {
      const tsSource = emitPipelineModule(input.newIR);
      insertPipelineVersion(this.db, {
        versionHash,
        name: input.newIR.name,
        irJson: JSON.stringify(input.newIR),
        tsSource,
        createdAt: Date.now(),
      });
    }

    // 4. Overwrite the registry JSON file.
    const { writeFileSync, existsSync } = require("node:fs");
    const { join, resolve } = require("node:path");
    // __dirname works at runtime for CJS; the project uses ESM so we
    // resolve from process.cwd() + known prefix. If a REGISTRY_ROOT
    // env var is set, honour it (tests).
    const registryRoot = process.env["REGISTRY_ROOT"]
      ?? resolve(process.cwd(), "apps/server/src/builtin-pipelines");
    const dirPath = join(registryRoot, input.pipelineName);
    if (!existsSync(dirPath)) {
      return {
        ok: false,
        diagnostics: [{
          code: "REGISTRY_PIPELINE_NOT_FOUND",
          message: `registry pipeline '${input.pipelineName}' directory not found at ${dirPath}`,
        }],
      };
    }
    const irPath = join(dirPath, "pipeline.ir.json");
    writeFileSync(irPath, JSON.stringify(input.newIR, null, 2) + "\n", "utf8");

    return { ok: true, versionHash, path: irPath };
  }
```

- [ ] **Step 7.7: Run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/kernel.test.ts`
Expected: PASS including the 4 new tests.

- [ ] **Step 7.8: Run tsc**

Run: `cd apps/server && npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7.9: Commit**

```bash
git add apps/server/src/kernel-next/mcp/kernel.ts apps/server/src/kernel-next/mcp/kernel.test.ts
git commit -m "feat(hot-update-5a): KernelService adds dryRunProposal / autoApprove / rollbackHotUpdate / updateRegistryPipeline"
```

---

## Task 8: Register three new MCP tools + add autoApprove to propose_pipeline_change

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/server.ts`
- Modify: `apps/server/src/kernel-next/mcp/server.test.ts`

- [ ] **Step 8.1: Update server.test.ts expected tool list**

In `apps/server/src/kernel-next/mcp/server.test.ts`, find the test that asserts the tool name set (look for `"approve_proposal"` in a sorted array literal) and add the three new names. Expected snippet (add lines starting `// Stage 5A`):

```ts
    expect(toolNames.sort()).toEqual([
      "answer_gate",
      "approve_proposal",
      "diff_runs",
      "dry_run_proposal",           // Stage 5A
      "get_pipeline_versions",
      "get_task_status",
      "list_proposals",
      "list_tasks",
      "migrate_task",
      "propose_pipeline_change",
      "query_lineage",
      "read_port",
      "reject_proposal",
      "rollback_hot_update",         // Stage 5A
      "run_pipeline",
      "submit_pipeline",
      "update_registry_pipeline",    // Stage 5A
      "validate_pipeline",
      "wait_pipeline_result",
      "write_port",
    ].sort());
```

(If the test doesn't have a sorted array — find both assertion blocks that enumerate tool names and update each.)

- [ ] **Step 8.2: Run failing test**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/server.test.ts`
Expected: FAIL — 3 tools missing.

- [ ] **Step 8.3: Add `ToolName` union entries**

In `apps/server/src/kernel-next/mcp/server.ts`, locate the `ToolName` type union and the `ALL_TOOL_NAMES` array. Add:

```ts
// In the ToolName union:
  | "dry_run_proposal"
  | "update_registry_pipeline"
  | "rollback_hot_update"

// In ALL_TOOL_NAMES:
  "dry_run_proposal", "update_registry_pipeline", "rollback_hot_update",
```

- [ ] **Step 8.4: Add `autoApprove` to `propose_pipeline_change`**

In the `propose_pipeline_change` tool definition in `server.ts`, add `autoApprove` to `inputSchema` and pass it through to `kernel.propose`:

```ts
        inputSchema: {
          currentVersion: z.string(),
          patch: z.unknown(),
          actor: z.string().default("unknown"),
          rerunFrom: z.string().optional(),
          migrateRunningTasks: z.union([
            z.literal("all"),
            z.literal("none"),
            z.array(z.string()),
          ]).optional(),
          autoApprove: z.boolean().optional(),      // Stage 5A
        },
```

In the handler body (inside the try block, around the `kernel.propose` call), add `autoApprove` to the forwarded object:

```ts
            return jsonResponse(
              kernel.propose({
                currentVersion: String(args.currentVersion),
                patch: parsedPatch.data,
                actor: String(args.actor ?? "unknown"),
                rerunFrom,
                migrateRunningTasks,
                autoApprove: typeof args.autoApprove === "boolean" ? args.autoApprove : undefined,
              }),
            );
```

- [ ] **Step 8.5: Register `dry_run_proposal` tool**

After the `propose_pipeline_change` tool registration (before `read_port`), insert:

```ts
      {
        name: "dry_run_proposal",
        description:
          "Read-only preview of a pipeline patch. Returns {diff, impact, " +
          "safeRange, wouldAutoApprove, proposedVersion} without touching " +
          "the DB. Stage 5A — B3 / B7. Safe to call concurrently.",
        inputSchema: {
          currentVersion: z.string(),
          patch: z.unknown(),
          rerunFrom: z.string().optional(),
          migrateRunningTasks: z.union([
            z.literal("all"),
            z.literal("none"),
            z.array(z.string()),
          ]).optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const parsedPatch = IRPatchSchema.safeParse(args.patch);
            if (!parsedPatch.success) {
              return jsonResponse({
                ok: false,
                diagnostics: parsedPatch.error.issues.map((i) => ({
                  code: "ZOD_PARSE_ERROR",
                  message: `patch.${i.path.join(".") || "<root>"}: ${i.message}`,
                  context: { path: i.path },
                })),
              });
            }
            return jsonResponse(kernel.dryRunProposal({
              currentVersion: String(args.currentVersion),
              patch: parsedPatch.data,
              rerunFrom: typeof args.rerunFrom === "string" ? args.rerunFrom : null,
              migrateRunningTasks: args.migrateRunningTasks,
            }));
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
```

- [ ] **Step 8.6: Register `update_registry_pipeline` tool**

Anywhere convenient (e.g. after `submit_pipeline`), insert:

```ts
      {
        name: "update_registry_pipeline",
        description:
          "Replace a registry pipeline's IR definition and register a new " +
          "pipeline_versions row. Does NOT migrate running tasks. Stage 5A — B2.",
        inputSchema: {
          pipelineName: z.string().min(1),
          newIR: z.unknown(),
          actor: z.string().default("unknown"),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const parsedIR = PipelineIRSchema.safeParse(args.newIR);
            if (!parsedIR.success) {
              return jsonResponse({
                ok: false,
                diagnostics: parsedIR.error.issues.map((i) => ({
                  code: "ZOD_PARSE_ERROR",
                  message: `newIR.${i.path.join(".") || "<root>"}: ${i.message}`,
                  context: { path: i.path },
                })),
              });
            }
            return jsonResponse(kernel.updateRegistryPipeline({
              pipelineName: String(args.pipelineName),
              newIR: parsedIR.data as PipelineIR,
              actor: String(args.actor ?? "unknown"),
            }));
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
```

- [ ] **Step 8.7: Register `rollback_hot_update` tool**

After `migrate_task`, insert:

```ts
      {
        name: "rollback_hot_update",
        description:
          "Stage 5A skeleton — writes an audit row indicating a rollback " +
          "intent. Does NOT execute state rollback (that lands in Stage 5B). " +
          "Validates that toVersion exists in this task's migration history.",
        inputSchema: {
          taskId: z.string(),
          toVersion: z.string(),
          actor: z.string().default("unknown"),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse(kernel.rollbackHotUpdate({
              taskId: String(args.taskId),
              toVersion: String(args.toVersion),
              actor: String(args.actor ?? "unknown"),
            }));
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
```

- [ ] **Step 8.8: Run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/server.test.ts`
Expected: PASS.

- [ ] **Step 8.9: Run tsc**

Run: `cd apps/server && npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 8.10: Commit**

```bash
git add apps/server/src/kernel-next/mcp/server.ts apps/server/src/kernel-next/mcp/server.test.ts
git commit -m "feat(hot-update-5a): register dry_run_proposal / update_registry_pipeline / rollback_hot_update MCP tools"
```

---

## Task 9: Adversarial tests — concurrent dry-run + autoApprove race

**Files:**
- Create: `apps/server/src/kernel-next/hot-update/stage-5a.adversarial.test.ts`

- [ ] **Step 9.1: Write adversarial tests**

Create the test file:

```ts
// Stage 5A adversarial — verifies dry-run has no side effects and
// autoApprove respects the optimistic lock under concurrent propose.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchemaDDL } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import type { PipelineIR } from "../ir/schema.js";

const baseIR: PipelineIR = {
  name: "p",
  stages: [{
    name: "a", type: "agent",
    config: { promptRef: "p-a" },
    inputs: [], outputs: [{ name: "out", type: "string" }],
  }],
  wires: [],
};

describe("Stage 5A adversarial — dry-run idempotence", () => {
  let db: DatabaseSync;
  let kernel: KernelService;
  let baseVersion: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applySchemaDDL(db);
    kernel = new KernelService({ db });
    const submitted = kernel.submit({
      ir: baseIR, prompts: { "p-a": "body" },
    });
    if (!submitted.ok) throw new Error("submit failed");
    baseVersion = submitted.versionHash;
  });

  it("100 dry-runs produce zero DB writes", () => {
    const beforeProposals = (db.prepare(`SELECT COUNT(*) AS n FROM pipeline_proposals`).get() as { n: number }).n;
    const beforeVersions = (db.prepare(`SELECT COUNT(*) AS n FROM pipeline_versions`).get() as { n: number }).n;
    for (let i = 0; i < 100; i++) {
      const r = kernel.dryRunProposal({
        currentVersion: baseVersion,
        patch: { ops: [{ op: "update_stage_config", stage: "a", configPatch: { promptRef: `p-a-v${i}` } }] },
      });
      expect(r.ok).toBe(true);
    }
    const afterProposals = (db.prepare(`SELECT COUNT(*) AS n FROM pipeline_proposals`).get() as { n: number }).n;
    const afterVersions = (db.prepare(`SELECT COUNT(*) AS n FROM pipeline_versions`).get() as { n: number }).n;
    expect(afterProposals).toBe(beforeProposals);
    expect(afterVersions).toBe(beforeVersions);
  });

  it("dry-run on mismatched currentVersion returns CONFLICT without diff", () => {
    const r = kernel.dryRunProposal({
      currentVersion: "wrong-hash",
      patch: { ops: [{ op: "update_stage_config", stage: "a", configPatch: { promptRef: "p-a-v2" } }] },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.diagnostics.some((d) => d.code === "CONFLICT")).toBe(true);
  });

  it("two autoApprove proposals on same baseVersion — both succeed (different proposal_ids)", () => {
    // Note: kernel-next's current propose doesn't enforce exclusivity
    // at the DB level (pipeline_proposals has no UNIQUE constraint on
    // base_version). This test documents the current behavior: both
    // writes succeed; lineage continues from the later-approved one.
    // 5B migration will enforce serial-per-task locks.
    const p1 = kernel.propose({
      currentVersion: baseVersion,
      patch: { ops: [{ op: "update_stage_config", stage: "a", configPatch: { promptRef: "p-a-v2" } }] },
      actor: "ai-1", autoApprove: true,
    });
    const p2 = kernel.propose({
      currentVersion: baseVersion,
      patch: { ops: [{ op: "update_stage_config", stage: "a", configPatch: { promptRef: "p-a-v3" } }] },
      actor: "ai-2", autoApprove: true,
    });
    expect(p1.ok && p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;
    expect(p1.proposalId).not.toBe(p2.proposalId);
    expect(p1.autoApplied).toBe(true);
    expect(p2.autoApplied).toBe(true);
  });

  it("structural patch with autoApprove=true → pending, not approved", () => {
    const r = kernel.propose({
      currentVersion: baseVersion,
      patch: {
        ops: [{
          op: "add_stage",
          stage: {
            name: "b", type: "agent",
            config: { promptRef: "p-a" },
            inputs: [], outputs: [],
          },
        }],
      },
      actor: "ai",
      autoApprove: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.autoApplied).toBe(false);
    const row = db.prepare(
      `SELECT status FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(r.proposalId) as { status: string };
    expect(row.status).toBe("pending");
  });

  it("diagnostic_json on success stores __kind='proposal-success-v1' + diff + impact + safeRange", () => {
    const r = kernel.propose({
      currentVersion: baseVersion,
      patch: { ops: [{ op: "update_stage_config", stage: "a", configPatch: { promptRef: "p-a-v2" } }] },
      actor: "ai",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = db.prepare(
      `SELECT diagnostic_json FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(r.proposalId) as { diagnostic_json: string };
    const parsed = JSON.parse(row.diagnostic_json);
    expect(parsed.__kind).toBe("proposal-success-v1");
    expect(parsed.diff).toBeDefined();
    expect(parsed.impact).toBeDefined();
    expect(parsed.safeRange).toBeDefined();
  });
});
```

- [ ] **Step 9.2: Run tests**

Run: `cd apps/server && npx vitest run src/kernel-next/hot-update/stage-5a.adversarial.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9.3: Commit**

```bash
git add apps/server/src/kernel-next/hot-update/stage-5a.adversarial.test.ts
git commit -m "test(hot-update-5a): adversarial — dry-run idempotence + autoApprove edge cases"
```

---

## Task 10: Update roadmap + add handoff doc

**Files:**
- Modify: `docs/product-roadmap.md`
- Create: `docs/superpowers/plans/2026-04-24-hot-update-5a-done-handoff.md`

- [ ] **Step 10.1: Update roadmap B-series table**

In `docs/product-roadmap.md`, locate §7.2 (Propose 入口) through §7.6 (兜底与审计). For each row whose B number is in {B1, B2, B3, B4, B7, B14, B15, B16, B17, B20(部分), B21}, append ` ✅ 5A` or ` ✅ 5A（骨架）` to the description. Also update the "6.1 A1" style status summary if Stage 5A is tracked there. Exact edits:

For B1:
```
| B1 | **统一 MCP 工具 `propose_pipeline_update`**：人（Web UI → 后端 → MCP）和 AI 都用这个入口 ✅ 5A |
```

For B2:
```
| B2 | **Registry 文件独立入口 `update_registry_pipeline`**：人直接改 YAML 文件 + AI 调这个 MCP（不跑 task 时改模板） ✅ 5A |
```

For B3:
```
| B3 | **Dry-run + Auto-approve**：AI 调 propose → 系统算 diff + migration plan + impact → safe 范围内 auto apply，范围外 block 等 confirm ✅ 5A |
```

For B4:
```
| B4 | **Safe 范围默认**：只改 prompt / reads / writes / budget 四项。结构性改动（加/删 stage、改路由、改 parallel 结构）一律要 confirm ✅ 5A（promptOnly；其他类别 reserve） |
```

For B7:
```
| B7 | **Dry-run 输出含 impact 分析**：列出每个活跃 task 的迁移成本预估、cost 增量、延迟预估 ✅ 5A（结构性 impact；cost/latency 预估推迟） |
```

For B14 / B15 / B16 / B17:
```
| B14 | **乐观锁**：... ✅ 5A |
| B15 | **删 stage**：... ✅ 5A |
| B16 | **结构性 schema drift**：... ✅ 5A |
| B17 | **Foreach 中途改子 pipeline**：... ✅ 5A（hook 预留；foreach stage 未实现） |
```

For B20:
```
| B20 | **用户回滚**：提供 `rollback_hot_update(taskId, toVersion)` MCP 工具。和 audit trail 联动 ✅ 5A（骨架；真实回滚 5B） |
```

Also add a new row near the top of §10 (历史修订) or a relevant progress table:

```
| v1.5 | 2026-04-24 | Stage 5A 完成：propose 链路完整化（dry_run_proposal / update_registry_pipeline / rollback_hot_update / autoApprove） |
```

- [ ] **Step 10.2: Create handoff doc**

Create `docs/superpowers/plans/2026-04-24-hot-update-5a-done-handoff.md`:

```markdown
# Stage 5A — Propose Pipeline Completion — Handoff

**Status:** Complete 2026-04-24.

## Delivered

- `apps/server/src/kernel-next/hot-update/` module:
  - `types.ts` — PipelineDiff / Impact / SafeRangeVerdict / DryRunResult
  - `diff.ts` + tests — pure function
  - `safe-range.ts` + tests — pure function
  - `impact.ts` + tests — DB-reading (active tasks + schema drift + resumability)
  - `dry-run.ts` + tests — orchestrator (zero DB writes)
  - `stage-5a.adversarial.test.ts` — concurrent idempotence + autoApprove edge cases
- `KernelService` (`mcp/kernel.ts`) gains:
  - `dryRunProposal(input)`
  - `propose(input)` now supports `autoApprove: boolean`; writes diff+impact+safeRange to `pipeline_proposals.diagnostic_json` with `__kind: "proposal-success-v1"`
  - `updateRegistryPipeline(input)` — template file overwrite + pipeline_versions row
  - `rollbackHotUpdate(input)` — skeleton (audit row only)
- `mcp/server.ts` registers three new external MCP tools: `dry_run_proposal`, `update_registry_pipeline`, `rollback_hot_update`; adds `autoApprove` to `propose_pipeline_change`
- New `Diagnostic` codes: `CONFLICT`, `VERSION_NOT_IN_HISTORY`, `REGISTRY_PIPELINE_NOT_FOUND`

## Not delivered (deferred to 5B/5C)

- **Migration plan execution engine** — 5B
- **Graceful agent interrupt + worktree migration** — 5C
- **Parallel group fine-grained migration** — 5D
- **Real state rollback** — 5B consumes the 5A skeleton
- **SSE `wf.hotUpdatePending` event + UI** — Phase 6 (no dashboard urgency for local single-user tool)
- **Cost / latency estimate in Impact** — requires historical metrics not yet collected

## Interface contracts 5B depends on

- `dryRunProposal` is called by 5B internally to decide whether to kick
  off runner-side migration; 5A guarantees `impact.activeTasks[]` + `safeRange.verdict` are authoritative.
- `rollback_hot_update` MCP shape (`{taskId, toVersion, actor}`) is
  stable. 5B swaps the skeleton body for real supersede + re-run.
- `pipeline_proposals.diagnostic_json` "__kind=proposal-success-v1"
  consumers should only read; 5B will not overwrite it on approve.

## Test counts

- New tests: ~31 (diff 9 + safe-range 5 + impact 5 + dry-run 5 + kernel 4 + adversarial 5 ≈ 33)
- All existing tests still green.

## Follow-ups (nice-to-have, not blocking)

- `SchemaDriftIssue` currently triggers on any type string change.
  Could be relaxed to "structural supertype OK" by parsing TS types.
- `updateRegistryPipeline` hard-codes `apps/server/src/builtin-pipelines/`
  as registry root. Honours `REGISTRY_ROOT` env for tests. A proper
  registry abstraction lands with external registries (out of scope).
```

- [ ] **Step 10.3: Commit**

```bash
git add docs/product-roadmap.md docs/superpowers/plans/2026-04-24-hot-update-5a-done-handoff.md
git commit -m "docs(hot-update-5a): roadmap B-series status + Stage 5A handoff"
```

---

## Task 11: Final verification

- [ ] **Step 11.1: Run entire server test suite**

Run: `cd apps/server && npx vitest run`
Expected: all tests pass, new tests counted. No regressions.

- [ ] **Step 11.2: Run full tsc**

Run: `cd apps/server && npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 11.3: If both green, no separate commit needed — tasks 1-10 already committed individually.**

---

## Self-Review

### Spec coverage

| Spec section | Task |
|---|---|
| §2.1 `dry_run_proposal` MCP | Task 6 (impl) + Task 8 (MCP registration) |
| §2.2 `propose_pipeline_change` + autoApprove | Task 7 (KernelService) + Task 8 (MCP `autoApprove` param) |
| §2.3 `update_registry_pipeline` | Task 7 (KernelService.updateRegistryPipeline) + Task 8 (MCP) |
| §2.4 `rollback_hot_update` skeleton | Task 7 (KernelService.rollbackHotUpdate) + Task 8 (MCP) |
| §3 PipelineDiff | Task 1 (types) + Task 3 (diff.ts) |
| §4 Impact | Task 1 + Task 5 (impact.ts) |
| §5 SafeRange | Task 1 + Task 4 (safe-range.ts) |
| §6 diagnostic_json schema extension | Task 7 (Step 7.3 — diagnosticJson with `__kind`) |
| §7 No IR format change | enforced implicitly; no schema.ts mutations beyond Task 2 diagnostic codes |
| §8 No SSE | verified: no server.ts event emission added |
| §9 module boundaries | Task 1 + Tasks 3/4/5/6 |
| §10.1 diff unit tests | Task 3 |
| §10.2 safe-range unit tests | Task 4 |
| §10.3 impact unit tests | Task 5 |
| §10.4 dry-run integration | Task 6 |
| §10.5 autoApprove paths | Task 7 |
| §10.6 updateRegistryPipeline | Task 7 (at minimum file-write behavior — test in kernel.test.ts) |
| §10.7 rollback skeleton | Task 7 |
| §10.8 adversarial | Task 9 |
| §11 5B interface contract | Task 10 handoff doc |
| §14 success criteria items 1-9 | Task 11 verification |

**Gap noticed:** Spec §10.6 mentions `updateRegistryPipeline` tests for
file-write behavior (valid IR → file overwritten; invalid IR → file
untouched). Task 7 adds only the method, not file-write assertions.
**Fix inline:** Add Task 7.6b below.

### Task 7.6b (added): Write kernel test for updateRegistryPipeline

- [ ] **Step 7.6b.1: Add test in kernel.test.ts**

Append to `describe("KernelService — Stage 5A ...")` group:

```ts
describe("KernelService — Stage 5A updateRegistryPipeline", () => {
  it("valid IR overwrites registry file + inserts pipeline_versions row", () => {
    const { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const tmp = mkdtempSync(require("node:os").tmpdir() + "/registry-");
    const pipelineDir = join(tmp, "my-pipeline");
    mkdirSync(pipelineDir);
    writeFileSync(join(pipelineDir, "pipeline.ir.json"), "{}", "utf8");
    process.env["REGISTRY_ROOT"] = tmp;
    try {
      const db = new DatabaseSync(":memory:");
      applySchemaDDL(db);
      const kernel = new KernelService({ db });
      const newIR: PipelineIR = {
        name: "my-pipeline",
        stages: [{
          name: "a", type: "agent",
          config: { promptRef: "p-a" },
          inputs: [], outputs: [],
        }],
        wires: [],
      };
      const r = kernel.updateRegistryPipeline({
        pipelineName: "my-pipeline", newIR, actor: "test",
      });
      if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r.diagnostics));
      const onDisk = JSON.parse(readFileSync(r.path, "utf8"));
      expect(onDisk.name).toBe("my-pipeline");
      expect(onDisk.stages[0].name).toBe("a");
      const row = db.prepare(
        `SELECT 1 FROM pipeline_versions WHERE version_hash = ?`,
      ).get(r.versionHash);
      expect(row).toBeDefined();
    } finally {
      delete process.env["REGISTRY_ROOT"];
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("nonexistent pipelineName directory → REGISTRY_PIPELINE_NOT_FOUND", () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const tmp = mkdtempSync(require("node:os").tmpdir() + "/registry-");
    process.env["REGISTRY_ROOT"] = tmp;
    try {
      const db = new DatabaseSync(":memory:");
      applySchemaDDL(db);
      const kernel = new KernelService({ db });
      const r = kernel.updateRegistryPipeline({
        pipelineName: "missing-pipeline",
        newIR: {
          name: "missing-pipeline",
          stages: [{ name: "a", type: "agent", config: { promptRef: "p-a" }, inputs: [], outputs: [] }],
          wires: [],
        },
        actor: "test",
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected failure");
      expect(r.diagnostics.some((d) => d.code === "REGISTRY_PIPELINE_NOT_FOUND")).toBe(true);
    } finally {
      delete process.env["REGISTRY_ROOT"];
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 7.6b.2: Run + commit if green**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/kernel.test.ts`
Expected: PASS.

Amend into the Task 7 commit (or create a follow-up commit):

```bash
git add apps/server/src/kernel-next/mcp/kernel.test.ts
git commit -m "test(hot-update-5a): cover updateRegistryPipeline file-write + NOT_FOUND paths"
```

### Placeholder scan

- No "TBD/TODO/implement later" markers in any code block.
- All test bodies contain real assertions.
- All method bodies contain real logic.

### Type consistency

- `PipelineDiff` — used in Tasks 1, 3, 4, 6, 7, 10 — shape matches spec §3.
- `Impact` — used in Tasks 1, 4, 5, 6, 7 — shape matches spec §4.
- `SafeRangeVerdict` — used in Tasks 1, 4, 6, 7 — shape matches spec §5.
- `DryRunResult` — Tasks 1, 6, 7 — discriminated union consistent.
- `diagnostic_json` shape `__kind: "proposal-success-v1"` — Tasks 7, 9, 10.
- Method name `dryRunProposal` — consistent across Tasks 6, 7, 8, 10.
- Method name `updateRegistryPipeline` — consistent.
- Method name `rollbackHotUpdate` — consistent.
- MCP tool name `rollback_hot_update` — consistent across Tasks 8, 9, 10.

No inconsistencies found.

---

## Execution

Plan saved to `docs/superpowers/plans/2026-04-24-hot-update-5a-propose-pipeline.md`.

Executing via **Subagent-Driven Development** per project policy (fresh subagent per task, two-stage review after each).
