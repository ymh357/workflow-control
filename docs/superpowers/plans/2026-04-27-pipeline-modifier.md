# pipeline-modifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new builtin pipeline `pipeline-modifier` that lets an AI (or upstream agent) modify an existing pipeline by producing a `propose_pipeline_change` patch — closes the loop on Stage 5A/5B/5E hot-update infrastructure.

**Architecture:** Five stages — `loadCurrent` (agent: fetch target IR + prompts + optional failure context), `analyzeGap` (agent: diff intent), `awaitingConfirm` (gate), `genPatch` (agent: emit patch + dry-run), `applying` (agent: propose with autoApprove + optional migrate). One new MCP tool `get_pipeline_definition` wraps existing `getPromptsByVersion` (returns IR + prompt markdown). Zero new tables. Observability via existing `hot_update_events.actor` (B22 stats automatically picks it up).

**Tech Stack:** TypeScript, vitest, node:sqlite (DatabaseSync), zod, kernel-next IR schema, existing hot-update MCP tools (`propose_pipeline_change`, `dry_run_proposal`, `migrate_task`).

**Reference spec:** `docs/superpowers/specs/2026-04-27-pipeline-modifier-design.md`

---

## File map (locked)

```
apps/server/src/kernel-next/
├── ir/schema.ts                                     (modify: add 2 diagnostic codes)
├── mcp/tools/
│   ├── get-pipeline-definition.ts                   (CREATE)
│   └── get-pipeline-definition.test.ts              (CREATE)
└── mcp/server.ts                                    (modify: register tool)

apps/server/src/builtin-pipelines/pipeline-modifier/
├── pipeline.ir.json                                 (CREATE)
├── pipeline.ir.test.ts                              (CREATE)
├── prompts/system/
│   ├── load-current.md                              (CREATE)
│   ├── analyze-gap.md                               (CREATE)
│   ├── gen-patch.md                                 (CREATE)
│   └── applying.md                                  (CREATE)
├── e2e.happy-path.test.ts                           (CREATE)
├── e2e.structural.test.ts                           (CREATE)
├── e2e.migrate-on-failure.test.ts                   (CREATE)
└── e2e.self-modify-rejected.test.ts                 (CREATE)

apps/server/src/routes/kernel-run.ts                 (modify: add pipeline-modifier to seed list)
```

---

## Task 1: Diagnostic codes

**Files:**
- Modify: `apps/server/src/kernel-next/ir/schema.ts` (add to `DiagnosticSchema` z.enum array — locate the enum around lines 414-522 per investigation)

- [ ] **Step 1: Find DiagnosticSchema enum and add codes**

Open `apps/server/src/kernel-next/ir/schema.ts`. Find the `DiagnosticSchema` z.object whose `code` field is a `z.enum([...])`. Add two new entries to the enum array:

```typescript
"MODIFIER_TARGET_UNKNOWN",
"MODIFIER_SELF_MODIFY_REJECTED",
```

Place them in alphabetical order or grouped with related codes — match existing convention.

- [ ] **Step 2: Verify type-check passes**

Run: `cd apps/server && npx tsc --noEmit 2>&1 | head -30`
Expected: no errors related to DiagnosticSchema or these codes.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/kernel-next/ir/schema.ts
git commit -m "feat(diagnostic): add MODIFIER_TARGET_UNKNOWN + MODIFIER_SELF_MODIFY_REJECTED codes"
```

---

## Task 2: `get_pipeline_definition` MCP tool — failing test

**Files:**
- Create: `apps/server/src/kernel-next/mcp/tools/get-pipeline-definition.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
}));

import { createKernelMcp } from "../server.js";
import { initKernelNextSchema } from "../../ir/sql.js";
import { KernelService } from "../kernel.js";

function getTools(mcp: any): Map<string, { name: string; handler: (args: any) => Promise<unknown> }> {
  return new Map(mcp.tools.map((t: any) => [t.name, t]));
}

async function seedTinyPipeline(db: DatabaseSync, name: string): Promise<{ versionHash: string }> {
  const svc = new KernelService(db, { skipTypeCheck: true });
  const ir = {
    name,
    externalInputs: [{ name: "input1", type: "string" }],
    stages: [
      {
        type: "agent" as const,
        name: "s1",
        config: { promptRef: "system/p1" },
        inputs: [{ name: "input1", type: "string" }],
        outputs: [{ name: "result", type: "string" }],
      },
    ],
    wires: [
      { from: { source: "external" as const, port: "input1" }, to: { stage: "s1", port: "input1" } },
    ],
  };
  const prompts = { "system/p1": "# Test prompt content for s1" };
  const res = await svc.submit(ir, { prompts });
  if (!res.ok) throw new Error("seed failed");
  return { versionHash: res.versionHash };
}

describe("get_pipeline_definition MCP tool", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("returns IR + prompts when name is given", async () => {
    const { versionHash } = await seedTinyPipeline(db, "test-pipeline");
    const mcp = createKernelMcp(db, { surface: "combined", skipTypeCheck: true });
    const tool = getTools(mcp).get("get_pipeline_definition");
    expect(tool).toBeDefined();

    const resp = await tool!.handler({ name: "test-pipeline" });
    const data = JSON.parse((resp as any).content[0].text);

    expect(data.ok).toBe(true);
    expect(data.versionHash).toBe(versionHash);
    expect(data.ir.name).toBe("test-pipeline");
    expect(data.prompts["system/p1"]).toBe("# Test prompt content for s1");
  });

  it("returns IR + prompts when versionHash is given (overrides name)", async () => {
    const { versionHash } = await seedTinyPipeline(db, "test-pipeline-v");
    const mcp = createKernelMcp(db, { surface: "combined", skipTypeCheck: true });
    const tool = getTools(mcp).get("get_pipeline_definition");
    const resp = await tool!.handler({ versionHash });
    const data = JSON.parse((resp as any).content[0].text);
    expect(data.ok).toBe(true);
    expect(data.versionHash).toBe(versionHash);
    expect(Object.keys(data.prompts).length).toBeGreaterThan(0);
  });

  it("returns ok=false with diagnostic when name not found", async () => {
    const mcp = createKernelMcp(db, { surface: "combined", skipTypeCheck: true });
    const tool = getTools(mcp).get("get_pipeline_definition");
    const resp = await tool!.handler({ name: "nonexistent-pipeline" });
    const data = JSON.parse((resp as any).content[0].text);
    expect(data.ok).toBe(false);
    expect(Array.isArray(data.diagnostics)).toBe(true);
    expect(data.diagnostics.length).toBeGreaterThan(0);
  });

  it("returns ok=false when neither name nor versionHash provided", async () => {
    const mcp = createKernelMcp(db, { surface: "combined", skipTypeCheck: true });
    const tool = getTools(mcp).get("get_pipeline_definition");
    const resp = await tool!.handler({});
    const data = JSON.parse((resp as any).content[0].text);
    expect(data.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/tools/get-pipeline-definition.test.ts --reporter=default`
Expected: FAIL — tool does not exist (`get_pipeline_definition` not in tools map).

- [ ] **Step 3: Commit failing test**

```bash
git add apps/server/src/kernel-next/mcp/tools/get-pipeline-definition.test.ts
git commit -m "test(get-pipeline-definition): failing test for new MCP tool"
```

---

## Task 3: `get_pipeline_definition` implementation

**Files:**
- Create: `apps/server/src/kernel-next/mcp/tools/get-pipeline-definition.ts`
- Modify: `apps/server/src/kernel-next/mcp/server.ts` (register on combined + external surfaces)

- [ ] **Step 1: Inspect server.ts to find the tool registration pattern**

Read `apps/server/src/kernel-next/mcp/tools/hot-update.ts` first 30 lines to see tool factory pattern. Read `apps/server/src/kernel-next/mcp/server.ts` to find where existing tools (e.g., `describe_pipeline`, `propose_pipeline_change`) are imported and added to the EXTERNAL surface array.

- [ ] **Step 2: Create get-pipeline-definition.ts**

```typescript
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  getLatestVersionHashByName,
  getPipelineIR,
  getPromptsByVersion,
} from "../../ir/sql.js";
import type { Diagnostic } from "../../ir/schema.js";

function jsonResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

const inputSchema = {
  name: z.string().optional().describe("Pipeline name to resolve to its latest versionHash."),
  versionHash: z.string().optional().describe("Exact versionHash. Overrides name when both given."),
};

export function buildGetPipelineDefinition(db: DatabaseSync) {
  return {
    name: "get_pipeline_definition",
    description:
      "Retrieve full pipeline IR + every prompt's markdown content for authoring/analysis stages. Returns { ok, versionHash, ir, prompts }.",
    inputSchema,
    handler: async (args: { name?: string; versionHash?: string }) => {
      let resolvedHash: string | null = null;

      if (args.versionHash) {
        resolvedHash = args.versionHash;
      } else if (args.name) {
        resolvedHash = getLatestVersionHashByName(db, args.name);
        if (!resolvedHash) {
          const diag: Diagnostic = {
            code: "MODIFIER_TARGET_UNKNOWN",
            message: `No pipeline named "${args.name}"`,
            severity: "error",
          };
          return jsonResponse({ ok: false, diagnostics: [diag] });
        }
      } else {
        const diag: Diagnostic = {
          code: "INVALID_INPUT",
          message: "Either 'name' or 'versionHash' must be provided.",
          severity: "error",
        };
        return jsonResponse({ ok: false, diagnostics: [diag] });
      }

      const ir = getPipelineIR(db, resolvedHash);
      if (!ir) {
        const diag: Diagnostic = {
          code: "MODIFIER_TARGET_UNKNOWN",
          message: `versionHash ${resolvedHash} not found`,
          severity: "error",
        };
        return jsonResponse({ ok: false, diagnostics: [diag] });
      }

      const prompts = getPromptsByVersion(db, resolvedHash);

      return jsonResponse({
        ok: true,
        versionHash: resolvedHash,
        ir,
        prompts,
      });
    },
  };
}
```

(NOTE: If `Diagnostic.severity` field name differs from "severity" — check `ir/schema.ts` and adjust. If `INVALID_INPUT` is not a registered code yet, use whatever generic-input-error code already exists; check the enum in ir/schema.ts. Plan must not invent codes.)

- [ ] **Step 3: Register the tool in server.ts**

Open `apps/server/src/kernel-next/mcp/server.ts`. Find the EXTERNAL tool list (per investigation, around lines 112-139). Import the builder:

```typescript
import { buildGetPipelineDefinition } from "./tools/get-pipeline-definition.js";
```

Add to the external tools array (alphabetical or near `describe_pipeline`):

```typescript
buildGetPipelineDefinition(db),
```

The COMBINED surface includes everything from EXTERNAL, so no extra step there.

- [ ] **Step 4: Run test to verify pass**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/tools/get-pipeline-definition.test.ts --reporter=default`
Expected: 4/4 tests pass.

- [ ] **Step 5: Type-check + lint**

Run: `cd apps/server && npx tsc --noEmit 2>&1 | head -30`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/mcp/tools/get-pipeline-definition.ts apps/server/src/kernel-next/mcp/server.ts
git commit -m "feat(mcp): add get_pipeline_definition tool returning IR + prompts"
```

---

## Task 4: pipeline.ir.json — minimal viable IR (failing test first)

**Files:**
- Create: `apps/server/src/builtin-pipelines/pipeline-modifier/pipeline.ir.test.ts`
- Create: `apps/server/src/builtin-pipelines/pipeline-modifier/pipeline.ir.json`

- [ ] **Step 1: Write the failing IR-shape test**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("pipeline-modifier IR", () => {
  const irPath = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "pipeline.ir.json");
  const ir = JSON.parse(readFileSync(irPath, "utf8")) as {
    name: string;
    externalInputs: Array<{ name: string; type: string }>;
    stages: Array<{ name: string; type: string }>;
    wires: Array<unknown>;
  };

  it("has the correct top-level name", () => {
    expect(ir.name).toBe("pipeline-modifier");
  });

  it("declares the three required externalInputs", () => {
    const names = ir.externalInputs.map((p) => p.name);
    expect(names).toContain("targetPipelineName");
    expect(names).toContain("modificationGoal");
    expect(names).toContain("failureContext");
  });

  it("has 5 stages in the documented order", () => {
    const stageNames = ir.stages.map((s) => s.name);
    expect(stageNames).toEqual([
      "loadCurrent",
      "analyzeGap",
      "awaitingConfirm",
      "genPatch",
      "applying",
    ]);
  });

  it("loadCurrent and analyzeGap and genPatch and applying are agent stages", () => {
    const byName = Object.fromEntries(ir.stages.map((s) => [s.name, s]));
    expect(byName.loadCurrent.type).toBe("agent");
    expect(byName.analyzeGap.type).toBe("agent");
    expect(byName.genPatch.type).toBe("agent");
    expect(byName.applying.type).toBe("agent");
  });

  it("awaitingConfirm is a gate stage", () => {
    const gate = ir.stages.find((s) => s.name === "awaitingConfirm");
    expect(gate?.type).toBe("gate");
  });

  it("submits successfully via KernelService", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { initKernelNextSchema } = await import("../../kernel-next/ir/sql.js");
    const { KernelService } = await import("../../kernel-next/mcp/kernel.js");
    const { loadBuiltinPipelineIR } = await import("../../routes/load-builtin-pipeline.js");

    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const loaded = loadBuiltinPipelineIR("pipeline-modifier");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = await svc.submit(loaded.ir, { prompts: loaded.prompts });
    expect(res.ok).toBe(true);
  });
});
```

(NOTE: `loadBuiltinPipelineIR` import path may differ — check `apps/server/src/routes/kernel-run.ts:115-133` per investigation; whatever module exports it, use that path. Also: per CLAUDE.md, the IR's `submit` enforces `store_schema` parity if present. Don't include `store_schema` in this minimal IR unless tests demand it.)

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/pipeline.ir.test.ts --reporter=default`
Expected: FAIL — pipeline.ir.json doesn't exist.

- [ ] **Step 3: Create pipeline.ir.json**

Use this template. Read `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json` for the canonical shape — match field ordering, type spelling ("agent" / "gate"), and wire structure.

```json
{
  "externalInputs": [
    {
      "name": "targetPipelineName",
      "type": "string",
      "description": "Name of the existing pipeline to modify."
    },
    {
      "name": "modificationGoal",
      "type": "string",
      "description": "Natural-language description of the change."
    },
    {
      "name": "failureContext",
      "type": "unknown",
      "description": "Optional { taskId?, failedStageName?, errorMessage?, executionRecordId? } for failure-driven modification. Pass null if proactive."
    }
  ],
  "name": "pipeline-modifier",
  "stages": [
    {
      "type": "agent",
      "name": "loadCurrent",
      "config": { "promptRef": "system/load-current" },
      "inputs": [
        { "name": "targetPipelineName", "type": "string" },
        { "name": "failureContext", "type": "unknown" }
      ],
      "outputs": [
        { "name": "currentVersionHash", "type": "string" },
        { "name": "currentIr", "type": "unknown" },
        { "name": "currentPromptsMap", "type": "unknown" },
        { "name": "failureBundle", "type": "unknown" }
      ]
    },
    {
      "type": "agent",
      "name": "analyzeGap",
      "config": { "promptRef": "system/analyze-gap" },
      "inputs": [
        { "name": "currentIr", "type": "unknown" },
        { "name": "currentPromptsMap", "type": "unknown" },
        { "name": "modificationGoal", "type": "string" },
        { "name": "failureBundle", "type": "unknown" },
        { "name": "rejectionFeedback", "type": "string" }
      ],
      "outputs": [
        { "name": "gapAnalysis", "type": "unknown" },
        { "name": "proposedChangeOutline", "type": "string" },
        { "name": "expectedSafeRange", "type": "string" }
      ]
    },
    {
      "type": "gate",
      "name": "awaitingConfirm",
      "config": {
        "question": { "text": "Approve this proposed pipeline modification?" },
        "routing": { "routes": { "approve": "genPatch", "reject": "analyzeGap" } }
      },
      "inputs": [{ "name": "__gate_signal", "type": "unknown" }],
      "outputs": []
    },
    {
      "type": "agent",
      "name": "genPatch",
      "config": { "promptRef": "system/gen-patch" },
      "inputs": [
        { "name": "gapAnalysis", "type": "unknown" },
        { "name": "proposedChangeOutline", "type": "string" },
        { "name": "currentIr", "type": "unknown" },
        { "name": "currentPromptsMap", "type": "unknown" },
        { "name": "currentVersionHash", "type": "string" },
        { "name": "failureBundle", "type": "unknown" }
      ],
      "outputs": [
        { "name": "patch", "type": "unknown" },
        { "name": "rerunFrom", "type": "string" },
        { "name": "migrateRunningTasks", "type": "unknown" },
        { "name": "prompts", "type": "unknown" },
        { "name": "dryRunVerdict", "type": "string" }
      ]
    },
    {
      "type": "agent",
      "name": "applying",
      "config": { "promptRef": "system/applying" },
      "inputs": [
        { "name": "patch", "type": "unknown" },
        { "name": "rerunFrom", "type": "string" },
        { "name": "migrateRunningTasks", "type": "unknown" },
        { "name": "currentVersionHash", "type": "string" },
        { "name": "dryRunVerdict", "type": "string" },
        { "name": "prompts", "type": "unknown" }
      ],
      "outputs": [
        { "name": "proposalId", "type": "string" },
        { "name": "proposedVersion", "type": "string" },
        { "name": "outcome", "type": "string" },
        { "name": "migrationResult", "type": "unknown" }
      ]
    }
  ],
  "wires": [
    { "from": { "source": "external", "port": "targetPipelineName" }, "to": { "stage": "loadCurrent", "port": "targetPipelineName" } },
    { "from": { "source": "external", "port": "failureContext" }, "to": { "stage": "loadCurrent", "port": "failureContext" } },

    { "from": { "stage": "loadCurrent", "port": "currentIr" }, "to": { "stage": "analyzeGap", "port": "currentIr" } },
    { "from": { "stage": "loadCurrent", "port": "currentPromptsMap" }, "to": { "stage": "analyzeGap", "port": "currentPromptsMap" } },
    { "from": { "source": "external", "port": "modificationGoal" }, "to": { "stage": "analyzeGap", "port": "modificationGoal" } },
    { "from": { "stage": "loadCurrent", "port": "failureBundle" }, "to": { "stage": "analyzeGap", "port": "failureBundle" } },

    { "from": { "stage": "analyzeGap", "port": "gapAnalysis" }, "to": { "stage": "genPatch", "port": "gapAnalysis" } },
    { "from": { "stage": "analyzeGap", "port": "proposedChangeOutline" }, "to": { "stage": "genPatch", "port": "proposedChangeOutline" } },
    { "from": { "stage": "loadCurrent", "port": "currentIr" }, "to": { "stage": "genPatch", "port": "currentIr" } },
    { "from": { "stage": "loadCurrent", "port": "currentPromptsMap" }, "to": { "stage": "genPatch", "port": "currentPromptsMap" } },
    { "from": { "stage": "loadCurrent", "port": "currentVersionHash" }, "to": { "stage": "genPatch", "port": "currentVersionHash" } },
    { "from": { "stage": "loadCurrent", "port": "failureBundle" }, "to": { "stage": "genPatch", "port": "failureBundle" } },

    { "from": { "stage": "genPatch", "port": "patch" }, "to": { "stage": "applying", "port": "patch" } },
    { "from": { "stage": "genPatch", "port": "rerunFrom" }, "to": { "stage": "applying", "port": "rerunFrom" } },
    { "from": { "stage": "genPatch", "port": "migrateRunningTasks" }, "to": { "stage": "applying", "port": "migrateRunningTasks" } },
    { "from": { "stage": "loadCurrent", "port": "currentVersionHash" }, "to": { "stage": "applying", "port": "currentVersionHash" } },
    { "from": { "stage": "genPatch", "port": "dryRunVerdict" }, "to": { "stage": "applying", "port": "dryRunVerdict" } },
    { "from": { "stage": "genPatch", "port": "prompts" }, "to": { "stage": "applying", "port": "prompts" } }
  ]
}
```

(NOTE: `analyzeGap.inputs.rejectionFeedback` has no incoming wire because it's the gate-rejection loop-back, populated only when `awaitingConfirm` rejects and re-routes. Verify the existing `pipeline-generator` IR for how this loop-back is wired — it uses no explicit wire, the gate executor injects `rejectionFeedback` based on its routing config. If pipeline-generator has an explicit wire for this, mirror it.)

- [ ] **Step 4: Create stub prompt files (so loadBuiltinPipelineIR doesn't fail)**

```bash
mkdir -p apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system
echo "# load-current (stub)" > apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/load-current.md
echo "# analyze-gap (stub)" > apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/analyze-gap.md
echo "# gen-patch (stub)" > apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/gen-patch.md
echo "# applying (stub)" > apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/applying.md
```

- [ ] **Step 5: Run test to verify pass**

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/pipeline.ir.test.ts --reporter=default`
Expected: 6/6 tests pass.

- [ ] **Step 6: Type-check**

Run: `cd apps/server && npx tsc --noEmit 2>&1 | head -30`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-modifier/
git commit -m "feat(pipeline-modifier): scaffold IR + 5 stages (loadCurrent/analyzeGap/awaitingConfirm/genPatch/applying)"
```

---

## Task 5: Register pipeline-modifier in boot seed list

**Files:**
- Modify: `apps/server/src/routes/kernel-run.ts:135-139`

- [ ] **Step 1: Add the seed call**

Open `apps/server/src/routes/kernel-run.ts`. Locate the block (around lines 135-139):

```typescript
void seedBuiltinPipelineByName("smoke-test");
void seedBuiltinPipelineByName("tech-research-collector");
void seedBuiltinPipelineByName("tech-research-writer");
void seedBuiltinPipelineByName("pipeline-generator");
void seedBuiltinPipelineByName("pr-description-generator");
```

Append:

```typescript
void seedBuiltinPipelineByName("pipeline-modifier");
```

- [ ] **Step 2: Type-check**

Run: `cd apps/server && npx tsc --noEmit 2>&1 | head -30`
Expected: no errors.

- [ ] **Step 3: Boot smoke test**

Spin up the server briefly (or run any existing test that boots the kernel) — confirm no startup errors.

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/pipeline.ir.test.ts --reporter=default`
Expected: still 6/6 (we didn't break anything).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/kernel-run.ts
git commit -m "feat(pipeline-modifier): register in boot seed list"
```

---

## Task 6: `load-current.md` system prompt

**Files:**
- Modify (replace stub): `apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/load-current.md`

- [ ] **Step 1: Write the prompt**

Replace stub with full content. The prompt MUST:
- Reference `__kernel_next____get_pipeline_definition`, `__kernel_next____get_task_status`, `__kernel_next____query_lineage`, `__kernel_next____wait_for_task_event` by exact tool names (note: the auto-injected MCP server uses `mcp____kernel_next____<toolname>` per existing prompts in `pipeline-generator/prompts/system/`).
- Instruct the agent to call `write_port` for each output port: `currentVersionHash`, `currentIr`, `currentPromptsMap`, `failureBundle`.
- Handle the self-modification rejection inline: if `targetPipelineName === "pipeline-modifier"`, write a `failureBundle.diagnostic` with code `MODIFIER_SELF_MODIFY_REJECTED` and zero-value all other ports.
- Handle target-not-found: if `get_pipeline_definition` returns `ok: false`, propagate the diagnostic verbatim into a write_port to `failureBundle.diagnostic` and stop.
- For failure-context branch: only execute steps 4a-4d if `failureContext != null && failureContext.taskId`. Otherwise write `failureBundle: null`.

Use the `pipeline-generator/prompts/system/analysis.md` prompt as a stylistic template (tone, headers, MCP-call conventions). Keep this prompt < 200 lines (loadCurrent is mechanical).

The implementer should write the full prompt during the implementation phase using the in-repo style. The plan does not embed prompt prose — prompts are domain content, not code, and embedding them locks the plan to wording that will rot.

**Required structural sections in the prompt:**
1. Role / mandate (one paragraph)
2. Inputs available (the 2 input ports + values)
3. Required tool sequence (numbered, no creativity)
4. Output port contract (each output port's required JSON shape)
5. Error handling (the 2 diagnostic codes + where they go)
6. End: "do not execute any tool not listed above"

- [ ] **Step 2: Verify still loads**

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/pipeline.ir.test.ts --reporter=default`
Expected: 6/6 tests pass (the IR still loads).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/load-current.md
git commit -m "feat(pipeline-modifier): write load-current system prompt"
```

---

## Task 7: `analyze-gap.md` system prompt

**Files:**
- Modify (replace stub): `apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/analyze-gap.md`

- [ ] **Step 1: Write the prompt**

Same structural sections as Task 6. This prompt MUST:
- Read `currentIr`, `currentPromptsMap`, `modificationGoal`, `failureBundle?`, `rejectionFeedback?` from inputs.
- **Forbidden:** producing any IR patch in this stage. The deliverable is *intent*, not code.
- Optional tools the agent may call when `failureBundle != null`: `mcp____kernel_next____query_lineage`, `mcp____kernel_next____compare_runs`, `mcp____kernel_next____read_port`.
- Output ports:
  - `gapAnalysis`: structured JSON `{ currentShapeSummary: string, intendedChanges: Array<{stage: string, kind: string, description: string}>, affectedStages: string[], risks: string[] }`
  - `proposedChangeOutline`: NL string ≤ 500 words
  - `expectedSafeRange`: enum `"safe" | "structural" | "unknown"` (agent's guess; final verdict in genPatch)

- [ ] **Step 2: Verify still loads**

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/pipeline.ir.test.ts --reporter=default`
Expected: 6/6.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/analyze-gap.md
git commit -m "feat(pipeline-modifier): write analyze-gap system prompt"
```

---

## Task 8: `gen-patch.md` system prompt

**Files:**
- Modify (replace stub): `apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/gen-patch.md`

- [ ] **Step 1: Write the prompt**

This prompt MUST:
- Read `gapAnalysis`, `proposedChangeOutline`, `currentIr`, `currentPromptsMap`, `currentVersionHash`, `failureBundle?` from inputs.
- Construct an IR patch — shape MUST match `propose_pipeline_change.patch` (zod `unknown`, but the canonical convention is JSON Patch RFC 6902 array of `{op, path, value}` operations). Look at `apps/server/src/kernel-next/hot-update/patch-apply.ts` (or whatever applies the patch — find via `grep -rn "applyPatch" apps/server/src/kernel-next/hot-update/`) to see the supported `op` values and `path` syntax.
- **Required tool sequence:**
  1. Call `mcp____kernel_next____dry_run_proposal` with `{ currentVersion: currentVersionHash, patch, rerunFrom?, migrateRunningTasks }`.
  2. If `safeRange.verdict === "safe"` → emit final `patch` + `dryRunVerdict = "safe"` via write_port.
  3. If `unsafe` → revise patch (one self-correction loop), re-dry-run; if still unsafe, emit current patch + `dryRunVerdict = "unsafe"` (let `applying` decide).
  4. If structural → emit + `dryRunVerdict = "structural"`.
- Output ports:
  - `patch`: the IR patch (unknown shape)
  - `rerunFrom?`: stage name where re-execution should resume (or empty string)
  - `migrateRunningTasks`: default `"none"`. If `failureBundle?.taskId`, default `[failureBundle.taskId]`.
  - `prompts?`: prompt content map for new/changed promptRefs (if patch adds/changes prompts)
  - `dryRunVerdict`: `"safe" | "unsafe" | "structural"`

- [ ] **Step 2: Verify still loads**

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/pipeline.ir.test.ts --reporter=default`
Expected: 6/6.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/gen-patch.md
git commit -m "feat(pipeline-modifier): write gen-patch system prompt"
```

---

## Task 9: `applying.md` system prompt

**Files:**
- Modify (replace stub): `apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/applying.md`

- [ ] **Step 1: Write the prompt**

This prompt MUST:
- Read `patch`, `rerunFrom?`, `migrateRunningTasks`, `currentVersionHash`, `dryRunVerdict`, `prompts?` from inputs.
- Required tool sequence:
  1. Call `mcp____kernel_next____propose_pipeline_change({ currentVersion: currentVersionHash, patch, actor: "pipeline-modifier-task-{taskId}", rerunFrom, migrateRunningTasks, autoApprove: true })`. The `actor` string MUST embed the running pipeline-modifier's own taskId — instruct the agent to read it from a system note placed in the prompt by the executor (or hardcode `"pipeline-modifier"` if taskId not available; clarify in prompt).
  2. Inspect response:
     - `autoApplied === true`:
       - If `migrateRunningTasks` is a non-empty array: for each `taskId`, call `mcp____kernel_next____migrate_task({ taskId, proposalId })`. Capture per-task errors but do not retry.
       - Emit `outcome = "auto-applied"` + `proposalId` + `proposedVersion`.
     - `autoApplied === false`:
       - Emit `outcome = "pending-approval"` + `proposalId` + `proposedVersion`. Stage terminates successfully.
  3. If `propose_pipeline_change` itself fails (`ok: false`): emit `outcome = "failed"` and zero-value other ports.
- Output ports:
  - `proposalId`: string
  - `proposedVersion`: string (versionHash from response)
  - `outcome`: `"auto-applied" | "pending-approval" | "applied-after-approval" | "rejected" | "failed"` (the last two are reserved for future use; this stage emits only the first three)
  - `migrationResult?`: `{ migratedTaskIds: string[], errors: Array<{ taskId, message }> }`

- [ ] **Step 2: Verify still loads**

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/pipeline.ir.test.ts --reporter=default`
Expected: 6/6.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/applying.md
git commit -m "feat(pipeline-modifier): write applying system prompt"
```

---

## Task 10: E2E happy path — non-structural autoApprove

**Files:**
- Create: `apps/server/src/builtin-pipelines/pipeline-modifier/e2e.happy-path.test.ts`

- [ ] **Step 1: Write the failing test**

This is an integration test. It seeds a target pipeline (e.g., `smoke-test`), then runs `pipeline-modifier` against it with a trivial non-structural goal (e.g., "rename output port description"), and asserts:
- A new `pipeline_versions` row was created (target pipeline now has 2 versions)
- `outcome === "auto-applied"`
- A `hot_update_events` row exists with `actor` matching `^pipeline-modifier`
- `query_hot_update_stats({ actor: "pipeline-modifier" })` returns `{ successCount: 1 }` minimum

Use the kernel-next test harness pattern — read existing e2e tests like `apps/server/src/kernel-next/hot-update/end-to-end.test.ts` for the pattern of: in-memory DB, seed pipeline, submit task, drive stages via mock executor or real executor with mock SDK.

**The implementer must:**
- Read `end-to-end.test.ts` first to absorb the harness pattern.
- Mock the Claude SDK (`vi.mock("@anthropic-ai/claude-agent-sdk", ...)`) at file top.
- Hand-craft the AgentStage outputs by injecting deterministic responses into the executor — do NOT rely on a real LLM call. The test verifies the *plumbing*, not LLM behavior.

(NOTE: Writing this test prior to implementation finished is intentional — it exercises Tasks 1-9 together and surfaces any wiring bug.)

Skeleton (the implementer fleshes it out):

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: any) => opts,
  // Add any other SDK exports the runtime imports
}));

import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
// + other harness imports as the implementer discovers them

describe("pipeline-modifier e2e — happy path autoApprove", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    // Seed both smoke-test (the target) and pipeline-modifier (the operator)
    // ...
  });

  it("auto-applies a non-structural patch and writes hot_update_events", async () => {
    // 1. Run pipeline-modifier with externalInputs:
    //    { targetPipelineName: "smoke-test", modificationGoal: "...", failureContext: null }
    // 2. Drive the 5 stages with deterministic executor responses
    // 3. Assert: outcome === "auto-applied", new pipeline_versions row, hot_update_events row
    expect(true).toBe(true); // placeholder until skeleton fleshed out
  });
});
```

- [ ] **Step 2: Run + iterate until pass**

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/e2e.happy-path.test.ts --reporter=default`
Iterate: read errors, fix harness wiring, fix prompts/IR if needed.
Expected: test passes. If 9 prompts and IR are correct, this should mostly be a harness exercise.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-modifier/e2e.happy-path.test.ts
git commit -m "test(pipeline-modifier): e2e happy path — non-structural autoApprove"
```

---

## Task 11: E2E structural patch path

**Files:**
- Create: `apps/server/src/builtin-pipelines/pipeline-modifier/e2e.structural.test.ts`

- [ ] **Step 1: Write the test**

Same harness as Task 10. Difference: the executor's `genPatch` response provides a structural patch (e.g., adds a new stage). Assertions:
- `propose_pipeline_change` is called with `autoApprove: true`
- Response shows `autoApplied: false` (kernel ignores autoApprove on structural patches)
- `outcome === "pending-approval"`
- `proposalId` is a non-empty string
- The proposal exists in `pipeline_proposals` with `status === "pending"`
- No new `hot_update_events` row (no migration occurred)

- [ ] **Step 2: Run to pass**

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/e2e.structural.test.ts --reporter=default`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-modifier/e2e.structural.test.ts
git commit -m "test(pipeline-modifier): e2e structural patch — pending-approval outcome"
```

---

## Task 12: E2E migrate-on-failure path

**Files:**
- Create: `apps/server/src/builtin-pipelines/pipeline-modifier/e2e.migrate-on-failure.test.ts`

- [ ] **Step 1: Write the test**

Setup: seed target pipeline + create a failed task (insert a `stage_attempts` row with `status='error'`). Run pipeline-modifier with `failureContext: { taskId: <failedTaskId> }`. Drive deterministic responses. Assert:
- `loadCurrent` calls `get_task_status`, `query_lineage`, `wait_for_task_event` and emits `failureBundle != null` containing `failedStage`, `errorMessage`
- `genPatch` defaults `migrateRunningTasks` to `[<failedTaskId>]`
- After auto-apply, `migrate_task` was called with that taskId
- `migrationResult.migratedTaskIds` includes the taskId
- `hot_update_events` has a row with `task_id = <failedTaskId>` and `status = 'success'`

- [ ] **Step 2: Run to pass**

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/e2e.migrate-on-failure.test.ts --reporter=default`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-modifier/e2e.migrate-on-failure.test.ts
git commit -m "test(pipeline-modifier): e2e migrate path — failureContext drives migrate_task"
```

---

## Task 13: E2E self-modify rejection

**Files:**
- Create: `apps/server/src/builtin-pipelines/pipeline-modifier/e2e.self-modify-rejected.test.ts`

- [ ] **Step 1: Write the test**

Seed the modifier pipeline. Run it with `targetPipelineName: "pipeline-modifier"`. Assert:
- `loadCurrent` stage emits a `failureBundle.diagnostic` with code `MODIFIER_SELF_MODIFY_REJECTED`
- The pipeline terminates without calling `propose_pipeline_change`
- No new `pipeline_versions` row created
- No `hot_update_events` row created

- [ ] **Step 2: Run to pass**

Run: `cd apps/server && npx vitest run src/builtin-pipelines/pipeline-modifier/e2e.self-modify-rejected.test.ts --reporter=default`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-modifier/e2e.self-modify-rejected.test.ts
git commit -m "test(pipeline-modifier): e2e self-modify rejection"
```

---

## Task 14: Full server suite + lint sweep

**Files:**
- N/A (verification only)

- [ ] **Step 1: Run full server test suite**

Run: `cd apps/server && npx vitest run --reporter=default 2>&1 | tail -30`
Expected: previous baseline (~2032 passed / 4 skipped / 0 failed) plus the new tests added across Tasks 2-13.

- [ ] **Step 2: Type-check across the whole project**

Run: `cd apps/server && npx tsc --noEmit 2>&1 | head -30`
Expected: no errors.

- [ ] **Step 3: Lint (if configured)**

Run: `cd apps/server && npx eslint . --quiet 2>&1 | head -30`
Expected: no errors. (If ESLint not configured, document that in commit message.)

- [ ] **Step 4: Boot smoke**

Manually start the kernel-next server (or run any test that boots it) — verify the seed of `pipeline-modifier` works without errors. Look for log lines like `seedBuiltinPipelineByName('pipeline-modifier'): submit ok`.

- [ ] **Step 5: Commit (if any tweaks made)**

```bash
# If lint/type errors required fixes:
git add -p
git commit -m "chore(pipeline-modifier): final lint + type-check sweep"
```

If clean, skip commit step.

---

## Self-review checklist

**Spec coverage:**
- §3 "why new builtin not extending generator" — addressed in plan header (architecture rationale).
- §4 externalInputs (3 fields) — Task 4 IR.
- §5 stages — Tasks 4 (IR) + 6-9 (prompts). 5.1 loadCurrent → Task 6. 5.2 analyzeGap → Task 7. 5.3 awaitingConfirm → Task 4 (gate is config-only). 5.4 genPatch → Task 8. 5.5 applying → Task 9.
- §6 error handling matrix — distributed across the relevant prompts (Task 6 for self-modify + target-unknown, Task 8 for dry-run unsafe, Task 9 for migrate failures).
- §7 new MCP tool → Tasks 2 + 3.
- §8 observability — Task 10 happy-path test asserts `actor = "pipeline-modifier-task-{taskId}"`.
- §9 tests (6 listed) → Task 4 (IR test, 6 cases counts as 1 logical test file), Task 10 happy path, Task 11 structural, Task 12 migrate, Task 13 self-modify-rejected. **Gap: §9 test #2 was "loadCurrent.test.ts" as a unit test.** Replaced by full e2e because loadCurrent is an agent stage now (no in-process script unit). The 4 e2e tests cover everything that loadCurrent.test.ts would have covered. Acceptable trade.
- §10 hard invariants — preserved by virtue of using existing kernel APIs unchanged.
- §11 file layout — matches plan File Map exactly.
- §13 acceptance — verified by Tasks 10-14.

**Placeholder scan:**
- Task 6/7/8/9 do not embed prompt prose. Justified: prompts are domain content, not code; embedding them locks the plan to wording that immediately rots. Each task lists structural sections + tool sequences explicitly + output port contract — that's the contract. The wording is left to whoever implements.
- Tasks 10-13 e2e test bodies: skeleton + assertion list; the harness fleshing-out is left to the implementer who must read `end-to-end.test.ts` first. This is cited as a deliberate handoff because copy-pasting e2e harness boilerplate into the plan would inflate it 4x with reading-only content.
- No "TODO", "TBD", "implement later", "add appropriate error handling" remain in any task body.

**Type consistency:**
- `currentVersionHash` (string) — consistent across loadCurrent.outputs / genPatch.inputs / applying.inputs.
- `currentIr`, `currentPromptsMap` (unknown) — consistent across loadCurrent → analyzeGap & genPatch.
- `failureBundle` (unknown) — consistent loadCurrent → analyzeGap & genPatch.
- `patch` (unknown), `rerunFrom` (string), `migrateRunningTasks` (unknown), `dryRunVerdict` (string), `prompts` (unknown), `proposalId` (string), `proposedVersion` (string), `outcome` (string), `migrationResult` (unknown) — declared once in Task 4 IR, referenced consistently in Tasks 8/9 prompt specs.
- Diagnostic codes `MODIFIER_TARGET_UNKNOWN`, `MODIFIER_SELF_MODIFY_REJECTED` — added in Task 1, referenced in Tasks 3 (MCP tool) and 6 (loadCurrent prompt).

No drift found.
