# Propose UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a browser UI that creates `pipeline_proposals` without
the run-#15 workaround, unblocking M2 (3-5 friends dogfood).

**Architecture:** Three layers, each independently shippable. (1)
Relax `IRPatch.ops.min(1)` at the two schema sites and introduce a
`NO_OP_PROPOSAL` diagnostic keyed on `proposedHash === currentVersion`.
(2) Add two read-only HTTP inventory endpoints
(`GET /api/kernel/pipelines`, `GET /api/kernel/pipelines/:versionHash`)
and enrich the existing proposals list endpoint with `pipelineName`.
(3) Build three Next.js pages + one PromptsEditor component that
drives the existing `POST /api/kernel/proposals` endpoint with empty
patch + prompts override.

**Tech Stack:** TypeScript, Hono (server routes), zod (schema),
node:sqlite, Vitest (unit tests), Next.js 15 App Router, React 19,
Tailwind, next-intl (i18n), @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-04-23-propose-ui-design.md`

---

## File Structure

### Backend (apps/server)

**Modified**
- `apps/server/src/kernel-next/ir/schema.ts` — relax `ops.min(1)` → `ops.min(0)` at line 271
- `apps/server/src/kernel-next/mcp/kernel.ts` — `propose()`: add NO_OP_PROPOSAL check; `ProposalRow` + `listProposals` now carry `pipelineName`
- `apps/server/src/routes/kernel-proposals.ts` — relax route body `ops.min(1)` → `ops.min(0)`; map `NO_OP_PROPOSAL` to 400
- `apps/server/src/kernel-next/mcp/kernel.test.ts` — new test cases for empty-patch + prompts, NO_OP_PROPOSAL, idempotent patch
- `apps/server/src/routes/kernel-proposals.test.ts` — new tests for empty-ops + prompts path, NO_OP_PROPOSAL HTTP shape, pipelineName enrichment
- `apps/server/src/index.ts` — register new pipelines route

**Created**
- `apps/server/src/routes/kernel-pipelines.ts` — `GET /api/kernel/pipelines` + `GET /api/kernel/pipelines/:versionHash`
- `apps/server/src/routes/kernel-pipelines.test.ts` — route tests

### Frontend (apps/web)

**Modified**
- `apps/web/src/components/nav.tsx` — add Pipelines + Proposals links
- `apps/web/src/messages/en/common.json` + `apps/web/src/messages/zh/common.json` — nav translation keys

**Created**
- `apps/web/src/components/prompts-editor.tsx` — reusable multi-textarea editor component
- `apps/web/src/components/prompts-editor.test.tsx`
- `apps/web/src/app/kernel-next/pipelines/page.tsx` — list page
- `apps/web/src/app/kernel-next/pipelines/page.test.tsx`
- `apps/web/src/app/kernel-next/pipelines/[name]/page.tsx` — editor page (pick latest version + POST proposal)
- `apps/web/src/app/kernel-next/pipelines/[name]/page.test.tsx`
- `apps/web/src/app/kernel-next/proposals/page.tsx` — proposals list + approve/reject
- `apps/web/src/app/kernel-next/proposals/page.test.tsx`

---

## Milestones

- **M-A (Tasks 1-3)** — NO_OP_PROPOSAL + schema relax (backend)
- **M-B (Tasks 4-5)** — Inventory endpoints
- **M-C (Task 6)** — Enrich `listProposals` with pipelineName
- **M-D (Tasks 7-8)** — PromptsEditor component
- **M-E (Tasks 9-11)** — Pipelines list + detail pages
- **M-F (Tasks 12-13)** — Proposals list page
- **M-G (Tasks 14-15)** — Nav wiring + dogfood M4 sample

Each milestone ends with a **self-review block** (criteria from spec
§7) in the commit body. Criteria: functional correctness, consistency,
regression surface, YAGNI check, TDD discipline.

---

## Task 1: Relax IRPatchSchema ops min

**Files:**
- Modify: `apps/server/src/kernel-next/ir/schema.ts:271`

- [ ] **Step 1: Write a failing test that parses an empty ops patch**

Add to `apps/server/src/kernel-next/ir/schema.test.ts` (create if missing; check first):

```ts
import { describe, it, expect } from "vitest";
import { IRPatchSchema } from "./schema.js";

describe("IRPatchSchema — NO_OP_PROPOSAL prep", () => {
  it("accepts empty ops (no-op check is enforced at propose() layer, not schema)", () => {
    const r = IRPatchSchema.safeParse({ ops: [] });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — should FAIL**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/schema.test.ts`
Expected: FAIL with `Array must contain at least 1 element(s)`.

- [ ] **Step 3: Relax the schema**

Edit `apps/server/src/kernel-next/ir/schema.ts` line 271:

```ts
export const IRPatchSchema = z.object({
  // ops may be empty: a prompts-only change is a legitimate
  // proposal (pipelineVersionHash folds prompts into the hash).
  // The "is this actually a change?" guard lives at propose() and
  // raises NO_OP_PROPOSAL when proposedHash === currentVersion.
  ops: z.array(IRPatchOpSchema).min(0),
});
```

- [ ] **Step 4: Run test — should PASS**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full schema test suite to ensure no regressions**

Run: `cd apps/server && npx vitest run src/kernel-next/ir/`
Expected: PASS all.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/ir/schema.ts apps/server/src/kernel-next/ir/schema.test.ts
git commit -m "$(cat <<'EOF'
refactor(ir-patch): relax ops.min(1) — empty ops is a legitimate shape

A prompts-only proposal has zero IR ops but is still a valid version
change (pipelineVersionHash folds prompts into the hash). Forcing
non-empty ops at schema time required a workaround patch in run #15
(update_stage_config with configPatch:{promptRef: current}). Guard
moves to propose() as NO_OP_PROPOSAL (next task).

Self-review:
- Correctness: schema change is minimal, test-covered
- Consistency: comment explains why guard moved
- Regression: grep confirmed ops.length reads all in smoke tests, not
  schema-rejection paths
- YAGNI: no new code, just removed a constraint
- TDD: test-first, RED observed, GREEN confirmed
EOF
)"
```

---

## Task 2: Relax route body schema ops min

**Files:**
- Modify: `apps/server/src/routes/kernel-proposals.ts:40`

- [ ] **Step 1: Write a failing test for empty-ops HTTP path**

Add to `apps/server/src/routes/kernel-proposals.test.ts` inside the
existing `describe("REST /api/kernel/proposals")` block (after existing
POST tests):

```ts
it("POST /api/kernel/proposals accepts ops:[] at the route layer (service layer's NO_OP check is the gatekeeper)", async () => {
  // Seed a base version first.
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
  if (!submitted.ok) throw new Error("setup submit failed");

  const app = buildApp();
  const res = await app.fetch(new Request("http://t/api/kernel/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      currentVersion: submitted.versionHash,
      patch: { ops: [] },
      actor: "ai:route-empty-ops",
      prompts: { ...diamondPrompts(), [Object.keys(diamondPrompts())[0]!]: "new content body" },
    }),
  }));
  // Route layer accepts; propose() at service layer gives 202 since
  // the prompts override makes proposedHash differ from base.
  expect(res.status).toBe(202);
});
```

- [ ] **Step 2: Run test — should FAIL**

Run: `cd apps/server && npx vitest run src/routes/kernel-proposals.test.ts`
Expected: FAIL — route rejects with 400 "Array must contain at least 1 element(s)".

- [ ] **Step 3: Relax route schema**

Edit `apps/server/src/routes/kernel-proposals.ts` line 40:

```ts
const createProposalBodySchema = z.object({
  currentVersion: z.string().min(1),
  // ops may be empty — prompts-only proposal is legitimate.
  // NO_OP_PROPOSAL at service layer rejects if nothing actually changed.
  patch: z.object({ ops: z.array(z.unknown()).min(0) }).passthrough(),
  actor: z.string().min(1).max(256),
  rerunFrom: z.union([z.string().min(1), z.null()]).optional(),
  migrateRunningTasks: z.union([
    z.literal("all"),
    z.literal("none"),
    z.array(z.string().min(1)),
  ]).optional(),
  autoApprove: z.boolean().optional(),
  prompts: z.record(z.string(), z.string()).optional(),
}).strict();
```

- [ ] **Step 4: Run test — should PASS**

Run: `cd apps/server && npx vitest run src/routes/kernel-proposals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/kernel-proposals.ts apps/server/src/routes/kernel-proposals.test.ts
git commit -m "$(cat <<'EOF'
refactor(route): propose body schema accepts ops:[] (mirror of Task 1)

HTTP route mirrors the relaxed IRPatchSchema so that prompts-only
proposals can go end-to-end without the run-15 workaround.

Self-review:
- Correctness: schema aligns with domain schema
- Consistency: comment references NO_OP_PROPOSAL (added next task)
- Regression: existing route tests unchanged; new test PASS
- YAGNI: minimal change
- TDD: test-first, red/green cycle observed
EOF
)"
```

---

## Task 3: Add NO_OP_PROPOSAL at propose() service layer

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/kernel.ts` — `propose()` around line 536 (after `proposedHash` computed), and `Diagnostic["code"]` union
- Modify: `apps/server/src/routes/kernel-proposals.ts` — route error-code → HTTP status map
- Modify: `apps/server/src/kernel-next/mcp/kernel.test.ts` — new test cases

- [ ] **Step 1: Write three failing tests**

Add to `apps/server/src/kernel-next/mcp/kernel.test.ts` (append to the
existing `describe("KernelService.propose")` block — find it; if it
lives in a separate file such as `propose.test.ts` under the same dir,
add there):

```ts
it("propose(empty patch, with prompts override) succeeds; proposedVersion ≠ base", () => {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
  if (!submitted.ok) throw new Error("setup submit failed");

  const firstPromptRef = Object.keys(diamondPrompts())[0]!;
  const r = svc.propose({
    currentVersion: submitted.versionHash,
    patch: { ops: [] },
    actor: "ai:test-prompts-only",
    prompts: { [firstPromptRef]: "fresh body" },
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.proposedVersion).not.toBe(submitted.versionHash);
});

it("propose(empty patch, empty prompts) returns NO_OP_PROPOSAL", () => {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
  if (!submitted.ok) throw new Error("setup submit failed");

  const r = svc.propose({
    currentVersion: submitted.versionHash,
    patch: { ops: [] },
    actor: "ai:test-truly-noop",
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.diagnostics[0]!.code).toBe("NO_OP_PROPOSAL");
});

it("propose(idempotent patch, empty prompts) returns NO_OP_PROPOSAL", () => {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
  if (!submitted.ok) throw new Error("setup submit failed");

  // Find an agent stage and re-assign its promptRef to itself
  // (pre-audit workaround pattern).
  const agentStage = diamondIR().stages.find((s) => s.type === "agent")!;
  const currentRef = (agentStage as { config: { promptRef: string } }).config.promptRef;
  const r = svc.propose({
    currentVersion: submitted.versionHash,
    patch: { ops: [{ op: "update_stage_config", stage: agentStage.name, configPatch: { promptRef: currentRef } }] },
    actor: "ai:test-idempotent",
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.diagnostics[0]!.code).toBe("NO_OP_PROPOSAL");
});
```

Note: the test file may need imports. Confirm `DatabaseSync`,
`initKernelNextSchema`, `KernelService`, `diamondIR`, `diamondPrompts`
(or equivalent) are already imported in `kernel.test.ts`. If not,
import them matching what `kernel-proposals.test.ts` does (see lines
5-11 of that file). If there is no `diamondPrompts()` helper already,
define it locally in the test file as:

```ts
function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}
```

- [ ] **Step 2: Run tests — should FAIL**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/kernel.test.ts`
Expected: the three new tests fail (one because propose returns ok
instead of no-op diagnostic; two because NO_OP_PROPOSAL is not yet a
known code).

- [ ] **Step 3: Add NO_OP_PROPOSAL to the Diagnostic code union**

Open `apps/server/src/kernel-next/mcp/kernel.ts`. Find the
`Diagnostic` interface / code-union declaration (search for
`"PATCH_APPLY_ERROR"` and look at the surrounding type). Add
`"NO_OP_PROPOSAL"` to the union of allowed codes. Example edit:

```ts
export interface Diagnostic {
  code:
    | "PATCH_APPLY_ERROR"
    | "NO_OP_PROPOSAL"
    | "PROMPT_REF_MISSING"
    | "CONFLICT"
    // ... existing codes preserved
    ;
  message: string;
  context?: Record<string, unknown>;
}
```

Read the current union first (it's longer than this sketch) so you
preserve every existing code exactly.

- [ ] **Step 4: Insert NO_OP_PROPOSAL check after proposedHash is computed**

In `apps/server/src/kernel-next/mcp/kernel.ts` inside `propose()`,
find the line that computes `proposedHash` (search `proposedHash =
pipelineVersionHash`, should be around line 536). Immediately after
that line, before the "Persist new version" comment block, insert:

```ts
// NO_OP_PROPOSAL: the merged IR + merged prompts produced the same
// version as the base. Either the patch was empty and prompts were
// absent / unchanged, or every op was idempotent. Reject — a proposal
// that doesn't change anything should never enter pipeline_proposals.
if (proposedHash === args.currentVersion) {
  return {
    ok: false,
    diagnostics: [{
      code: "NO_OP_PROPOSAL",
      message: "proposed version is identical to currentVersion — nothing changed",
      context: { currentVersion: args.currentVersion },
    }],
  };
}
```

- [ ] **Step 5: Run tests — should PASS**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/kernel.test.ts`
Expected: the three new tests PASS. Run wider:
`cd apps/server && npx vitest run src/kernel-next/mcp/` — everything
else stays green.

- [ ] **Step 6: Map NO_OP_PROPOSAL to HTTP 400 in the route**

Open `apps/server/src/routes/kernel-proposals.ts`. Find the status map
inside the `POST /kernel/proposals` handler (around line 127-133, the
chain that reads `code === "PATCH_APPLY_ERROR" ? 400 : ...`). Add
`NO_OP_PROPOSAL` to the 400 set:

```ts
const status =
  code === "PATCH_APPLY_ERROR" ? 400 :
  code === "NO_OP_PROPOSAL" ? 400 :
  code === "PROMPT_REF_MISSING" ? 400 :
  code === "CONFLICT" ? 409 :
  code === "WIRE_TYPE_MISMATCH" ||
  code === "DUPLICATE_STAGE_NAME" ||
  code === "STORE_SCHEMA_TYPE_MISMATCH" ? 400 :
  500;
```

- [ ] **Step 7: Write a failing test for the HTTP mapping**

In `apps/server/src/routes/kernel-proposals.test.ts`, add:

```ts
it("POST /api/kernel/proposals returns 400 NO_OP_PROPOSAL for empty patch + empty prompts", async () => {
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
  if (!submitted.ok) throw new Error("setup submit failed");

  const app = buildApp();
  const res = await app.fetch(new Request("http://t/api/kernel/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      currentVersion: submitted.versionHash,
      patch: { ops: [] },
      actor: "ai:http-noop",
    }),
  }));
  expect(res.status).toBe(400);
  const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
  expect(body.ok).toBe(false);
  expect(body.diagnostics[0]!.code).toBe("NO_OP_PROPOSAL");
});
```

- [ ] **Step 8: Run test — should PASS**

Run: `cd apps/server && npx vitest run src/routes/kernel-proposals.test.ts`
Expected: PASS.

- [ ] **Step 9: Run full server suite**

Run: `cd apps/server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean, vitest all green.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/kernel-next/mcp/kernel.ts \
        apps/server/src/kernel-next/mcp/kernel.test.ts \
        apps/server/src/routes/kernel-proposals.ts \
        apps/server/src/routes/kernel-proposals.test.ts
git commit -m "$(cat <<'EOF'
feat(propose): NO_OP_PROPOSAL replaces ops.min(1) as the "no change" guard

proposedHash === currentVersion is the precise definition of "nothing
changed", covering all three cases the old ops.min(1) couldn't:
empty patch + empty prompts, empty patch + identical prompts override,
non-empty idempotent patch. HTTP route maps to 400.

This retires the run-15 workaround pattern (update_stage_config with
configPatch matching current value just to force ops.length > 0).

Self-review:
- Correctness: three test cases cover the taxonomy of no-op shapes
- Consistency: error envelope + status mapping mirror existing codes
- Regression: full apps/server suite stays green; tsc clean
- YAGNI: guard is one hash equality, no branching per-case
- TDD: all three tests RED first, code added, GREEN observed
EOF
)"
```

**M-A self-review checkpoint reached. Proceed to M-B.**

---

## Task 4: Create GET /api/kernel/pipelines (list)

**Files:**
- Create: `apps/server/src/routes/kernel-pipelines.ts`
- Create: `apps/server/src/routes/kernel-pipelines.test.ts`
- Modify: `apps/server/src/index.ts` (register route)

- [ ] **Step 1: Write failing test — empty DB**

Create `apps/server/src/routes/kernel-pipelines.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { diamondIR } from "../kernel-next/generator-mock/mini-generator.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelPipelinesRoute } from "./kernel-pipelines.js";

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelPipelinesRoute);
  return app;
}

describe("GET /api/kernel/pipelines", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    __setKernelNextDbForTest(undefined);
    db.close();
  });

  it("returns empty list when no pipelines exist", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pipelines: [] });
  });
});
```

- [ ] **Step 2: Run test — FAIL (module not found)**

Run: `cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts`
Expected: module import error for `./kernel-pipelines.js`.

- [ ] **Step 3: Create the route with minimum to make empty case pass**

Create `apps/server/src/routes/kernel-pipelines.ts`:

```ts
// Read-only inventory for the propose UI. Two endpoints:
//   GET /api/kernel/pipelines             — one row per pipeline name,
//                                           with its latest version
//   GET /api/kernel/pipelines/:versionHash — the IR + prompts map for
//                                            a specific version, for
//                                            the editor page
//
// Both are local, single-user, unauthenticated — same posture as the
// rest of kernel-next HTTP.

import { Hono } from "hono";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export const kernelPipelinesRoute = new Hono();

interface PipelineSummary {
  name: string;
  latestVersion: string;
  latestCreatedAt: number;
}

kernelPipelinesRoute.get("/kernel/pipelines", (c) => {
  const db = getKernelNextDb();
  // One row per pipeline_name with its newest version. We pull the
  // latest via correlated subquery rather than GROUP BY+MAX so we get
  // the version_hash that corresponds to MAX(created_at), not the
  // "any" version_hash GROUP BY would return.
  const rows = db.prepare(
    `SELECT pv.pipeline_name, pv.version_hash, pv.created_at
     FROM pipeline_versions pv
     WHERE pv.created_at = (
       SELECT MAX(created_at) FROM pipeline_versions
       WHERE pipeline_name = pv.pipeline_name
     )
     ORDER BY pv.pipeline_name ASC`,
  ).all() as Array<{ pipeline_name: string; version_hash: string; created_at: number }>;
  const pipelines: PipelineSummary[] = rows.map((r) => ({
    name: r.pipeline_name,
    latestVersion: r.version_hash,
    latestCreatedAt: r.created_at,
  }));
  return c.json({ ok: true, pipelines });
});
```

- [ ] **Step 4: Run empty-case test — PASS**

Run: `cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing test for populated list**

Append to `apps/server/src/routes/kernel-pipelines.test.ts`:

```ts
it("returns pipelines with their latest version, newest-first within name", async () => {
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
  if (!submitted.ok) throw new Error("setup submit failed");

  const app = buildApp();
  const res = await app.fetch(new Request("http://t/api/kernel/pipelines"));
  expect(res.status).toBe(200);
  const body = await res.json() as {
    ok: boolean;
    pipelines: Array<{ name: string; latestVersion: string; latestCreatedAt: number }>;
  };
  expect(body.ok).toBe(true);
  expect(body.pipelines).toHaveLength(1);
  expect(body.pipelines[0]!.name).toBe(diamondIR().name);
  expect(body.pipelines[0]!.latestVersion).toBe(submitted.versionHash);
});

it("returns the newest version when multiple versions exist for one pipeline", async () => {
  const svc = new KernelService(db, { skipTypeCheck: true });
  const first = svc.submit(diamondIR(), { prompts: diamondPrompts() });
  if (!first.ok) throw new Error("submit 1 failed");

  // Propose a real change so we produce a new version under the same name.
  const firstPromptRef = Object.keys(diamondPrompts())[0]!;
  const proposed = svc.propose({
    currentVersion: first.versionHash,
    patch: { ops: [] },
    actor: "ai:test",
    prompts: { [firstPromptRef]: "updated body" },
  });
  if (!proposed.ok) throw new Error("propose failed");

  const app = buildApp();
  const res = await app.fetch(new Request("http://t/api/kernel/pipelines"));
  const body = await res.json() as {
    ok: boolean;
    pipelines: Array<{ name: string; latestVersion: string }>;
  };
  expect(body.pipelines).toHaveLength(1);
  expect(body.pipelines[0]!.latestVersion).toBe(proposed.proposedVersion);
});
```

- [ ] **Step 6: Run tests — PASS**

Run: `cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts`
Expected: PASS all three.

- [ ] **Step 7: Register the route in server index**

Open `apps/server/src/index.ts`. Find where `kernelProposalsRoute` is
registered (search for `kernelProposalsRoute`). Add the same pattern
for the new route. Import at the top:

```ts
import { kernelPipelinesRoute } from "./routes/kernel-pipelines.js";
```

And register alongside proposals (same `app.route("/api", …)` pattern
that proposals uses — match the surrounding style exactly; do not
invent a new prefix).

- [ ] **Step 8: Run full server suite + tsc**

Run: `cd apps/server && npx tsc --noEmit && npx vitest run`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/routes/kernel-pipelines.ts \
        apps/server/src/routes/kernel-pipelines.test.ts \
        apps/server/src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): GET /api/kernel/pipelines — list pipelines with latest version

Powers the UI picker for /kernel-next/pipelines. One row per
pipeline name, latest version via correlated subquery (not GROUP BY
+ MAX which returns non-deterministic version_hash alongside MAX
timestamp).

Self-review:
- Correctness: 3 tests — empty DB, one pipeline, multiple versions
- Consistency: error envelope + route mounting match proposals route
- Regression: tsc clean, full suite green
- YAGNI: no pagination / filter — volume is <10 pipelines per user
- TDD: RED-GREEN observed on each of three behaviours
EOF
)"
```

---

## Task 5: Create GET /api/kernel/pipelines/:versionHash (detail)

**Files:**
- Modify: `apps/server/src/routes/kernel-pipelines.ts`
- Modify: `apps/server/src/routes/kernel-pipelines.test.ts`

- [ ] **Step 1: Write failing 404 test**

Append to `apps/server/src/routes/kernel-pipelines.test.ts`:

```ts
describe("GET /api/kernel/pipelines/:versionHash", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    __setKernelNextDbForTest(undefined);
    db.close();
  });

  it("returns 404 for unknown version", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/deadbeef"));
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("VERSION_NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run test — FAIL (handler missing)**

Run: `cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts`
Expected: the new test fails because the route returns 404 default but
not the right shape.

- [ ] **Step 3: Add the handler**

In `apps/server/src/routes/kernel-pipelines.ts`, add these imports at
the top:

```ts
import { getPipelineIR, getPromptsByVersion } from "../kernel-next/ir/sql.js";
```

Then append to the module (after the GET list handler):

```ts
kernelPipelinesRoute.get("/kernel/pipelines/:versionHash", (c) => {
  const hash = c.req.param("versionHash");
  const db = getKernelNextDb();
  const ir = getPipelineIR(db, hash);
  if (ir === null) {
    return c.json({
      ok: false,
      diagnostics: [{
        code: "VERSION_NOT_FOUND",
        message: `pipeline version '${hash}' not found`,
        context: { versionHash: hash },
      }],
    }, 404);
  }
  const prompts = getPromptsByVersion(db, hash);
  // parent_hash + created_at come from the same row we already
  // know exists via getPipelineIR. Fetch them here so the UI can
  // show provenance without a second round-trip.
  const meta = db.prepare(
    `SELECT parent_hash, created_at FROM pipeline_versions WHERE version_hash = ?`,
  ).get(hash) as { parent_hash: string | null; created_at: number } | undefined;
  return c.json({
    ok: true,
    ir,
    prompts,
    parentHash: meta?.parent_hash ?? null,
    createdAt: meta?.created_at ?? 0,
  });
});
```

- [ ] **Step 4: Run 404 test — PASS**

Run: `cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts`
Expected: PASS.

- [ ] **Step 5: Write happy-path failing test**

Append inside the same `describe("GET /api/kernel/pipelines/:versionHash")` block:

```ts
it("returns ir + prompts + parentHash + createdAt for a known version", async () => {
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
  if (!submitted.ok) throw new Error("setup submit failed");

  const app = buildApp();
  const res = await app.fetch(
    new Request(`http://t/api/kernel/pipelines/${encodeURIComponent(submitted.versionHash)}`),
  );
  expect(res.status).toBe(200);
  const body = await res.json() as {
    ok: boolean;
    ir: { name: string; stages: Array<{ name: string; type: string }> };
    prompts: Record<string, string>;
    parentHash: string | null;
    createdAt: number;
  };
  expect(body.ok).toBe(true);
  expect(body.ir.name).toBe(diamondIR().name);
  expect(Object.keys(body.prompts).length).toBe(Object.keys(diamondPrompts()).length);
  expect(body.parentHash).toBeNull();
  expect(body.createdAt).toBeGreaterThan(0);
});
```

- [ ] **Step 6: Run — PASS**

Run: `cd apps/server && npx vitest run src/routes/kernel-pipelines.test.ts`
Expected: PASS all.

- [ ] **Step 7: Full suite + tsc**

Run: `cd apps/server && npx tsc --noEmit && npx vitest run`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/routes/kernel-pipelines.ts apps/server/src/routes/kernel-pipelines.test.ts
git commit -m "$(cat <<'EOF'
feat(api): GET /api/kernel/pipelines/:versionHash — IR + prompts + meta

Powers the editor page: UI needs the IR (to enumerate agent stages)
and the prompts map (to populate editable textareas). Meta (parent +
createdAt) comes along so the page can show provenance without a
second round-trip.

Self-review:
- Correctness: 404 + happy-path covered
- Consistency: 404 uses the standard { ok:false, diagnostics:[…] }
  envelope with VERSION_NOT_FOUND code
- Regression: tsc + full suite green
- YAGNI: no "list all versions of a pipeline" endpoint — UI doesn't
  need it for this round
- TDD: RED-GREEN on both 404 and happy-path

M-B complete. Next milestone: enrich listProposals with pipelineName.
EOF
)"
```

**M-B self-review checkpoint reached. Proceed to M-C.**

---

## Task 6: Enrich ProposalRow with pipelineName

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/kernel.ts` — `ProposalRow` interface + `listProposals` SQL
- Modify: `apps/server/src/kernel-next/mcp/kernel.test.ts` — assertion update if any
- Modify: `apps/server/src/routes/kernel-proposals.test.ts` — new test verifies `pipelineName` present

- [ ] **Step 1: Write failing test**

Add to `apps/server/src/routes/kernel-proposals.test.ts` (inside the
existing `describe("REST /api/kernel/proposals")`):

```ts
it("GET /api/kernel/proposals enriches rows with pipelineName", async () => {
  seedProposal(db, "ai:test-enrich");

  const app = buildApp();
  const res = await app.fetch(new Request("http://t/api/kernel/proposals"));
  const body = await res.json() as {
    ok: boolean;
    proposals: Array<{ proposalId: string; pipelineName: string }>;
  };
  expect(body.ok).toBe(true);
  expect(body.proposals).toHaveLength(1);
  expect(body.proposals[0]!.pipelineName).toBe(diamondIR().name);
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd apps/server && npx vitest run src/routes/kernel-proposals.test.ts`
Expected: fail with `pipelineName` undefined in response.

- [ ] **Step 3: Update ProposalRow + query**

In `apps/server/src/kernel-next/mcp/kernel.ts` line 105-117 (the
`ProposalRow` interface), add `pipelineName: string;`:

```ts
export interface ProposalRow {
  proposalId: string;
  baseVersion: string;
  proposedVersion: string | null;
  actor: string;
  status: ProposalStatus;
  diagnosticJson: string | null;
  createdAt: number;
  rerunFrom: string | null;
  migrateRunning: "all" | "none" | string[];
  // Post-audit: UI needs pipeline identity per-row so the proposals
  // page can group/display without a round-trip to /api/kernel/pipelines.
  pipelineName: string;
}
```

Then update `listProposals` (around line 1330) to JOIN
`pipeline_versions`:

```ts
listProposals(filter: { status?: ProposalStatus } = {}): ProposalRow[] {
  const rows = filter.status
    ? this.db.prepare(
        `SELECT pp.proposal_id, pp.base_version, pp.proposed_version, pp.actor,
                pp.status, pp.diagnostic_json, pp.created_at, pp.rerun_from,
                pp.migrate_running, pv.pipeline_name
         FROM pipeline_proposals pp
         JOIN pipeline_versions pv ON pv.version_hash = pp.base_version
         WHERE pp.status = ?
         ORDER BY pp.created_at DESC, pp.rowid DESC`,
      ).all(filter.status)
    : this.db.prepare(
        `SELECT pp.proposal_id, pp.base_version, pp.proposed_version, pp.actor,
                pp.status, pp.diagnostic_json, pp.created_at, pp.rerun_from,
                pp.migrate_running, pv.pipeline_name
         FROM pipeline_proposals pp
         JOIN pipeline_versions pv ON pv.version_hash = pp.base_version
         ORDER BY pp.created_at DESC, pp.rowid DESC`,
      ).all();
  return (rows as Array<{
    proposal_id: string;
    base_version: string;
    proposed_version: string | null;
    actor: string;
    status: string;
    diagnostic_json: string | null;
    created_at: number;
    rerun_from: string | null;
    migrate_running: string | null;
    pipeline_name: string;
  }>).map((r) => ({
    proposalId: r.proposal_id,
    baseVersion: r.base_version,
    proposedVersion: r.proposed_version,
    actor: r.actor,
    status: r.status as ProposalStatus,
    diagnosticJson: r.diagnostic_json,
    createdAt: r.created_at,
    rerunFrom: r.rerun_from,
    migrateRunning: parseMigrateRunning(r.migrate_running),
    pipelineName: r.pipeline_name,
  }));
}
```

- [ ] **Step 4: Check other ProposalRow consumers**

Run: `cd apps/server && grep -rn "ProposalRow" src/ --include="*.ts"`

For each hit, read the surrounding code. If any construct a
`ProposalRow` literal (not just consume `listProposals` output), add
`pipelineName` there too. Likely sites: MCP server tool handlers in
`kernel-next/mcp/server.ts`.

- [ ] **Step 5: Run full suite — should be GREEN**

Run: `cd apps/server && npx tsc --noEmit && npx vitest run`
Expected: all green. If a consumer broke because they constructed a
ProposalRow by hand, fix them up to match.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/mcp/kernel.ts \
        apps/server/src/routes/kernel-proposals.test.ts
git commit -m "$(cat <<'EOF'
feat(proposals): listProposals returns pipelineName via JOIN

UI proposals page needs pipeline identity per row for the label.
Server-side JOIN is cheaper than the two-round-trip alternative
(fetch /api/kernel/pipelines then correlate by baseVersion on client)
and avoids N+1 inside the client.

Self-review:
- Correctness: test asserts pipelineName === pipeline's own name
- Consistency: JOIN matches how other listing queries (port_values)
  thread IR metadata
- Regression: audited all ProposalRow consumers; tsc clean
- YAGNI: no "proposals by pipelineName filter" yet — client can filter
  the list it already has
- TDD: test RED, added pipelineName to type + query, test GREEN

M-C complete. Next milestone: PromptsEditor React component.
EOF
)"
```

**M-C self-review checkpoint reached. Proceed to M-D.**

---

## Task 7: PromptsEditor component (pure)

**Files:**
- Create: `apps/web/src/components/prompts-editor.tsx`
- Create: `apps/web/src/components/prompts-editor.test.tsx`

- [ ] **Step 1: Write failing component test**

Create `apps/web/src/components/prompts-editor.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PromptsEditor } from "./prompts-editor";

const originalPrompts = {
  "system/a": "original a content",
  "system/b": "original b content",
};

describe("PromptsEditor", () => {
  it("renders one textarea per prompt ref, prefilled with original content", () => {
    render(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor=""
        onActorChange={() => {}}
        onSubmit={() => Promise.resolve({ ok: true })}
      />,
    );
    const ta = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    // 2 prompt textareas + 1 actor input → getAllByRole("textbox") gets 3,
    // but <input type=text> is also role=textbox; filter to textareas.
    const textareas = ta.filter((el) => el.tagName === "TEXTAREA");
    expect(textareas).toHaveLength(2);
    expect(textareas.map((t) => t.value).sort()).toEqual([
      "original a content",
      "original b content",
    ]);
  });

  it("Submit is disabled until a prompt is modified AND actor is non-empty", () => {
    const { rerender } = render(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor=""
        onActorChange={() => {}}
        onSubmit={() => Promise.resolve({ ok: true })}
      />,
    );
    const btn = screen.getByRole("button", { name: /submit proposal/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    // Modify a textarea but still no actor — still disabled.
    const first = (screen.getAllByRole("textbox").find((el) => el.tagName === "TEXTAREA")) as HTMLTextAreaElement;
    fireEvent.change(first, { target: { value: "changed body" } });
    expect(btn.disabled).toBe(true);

    // Now provide actor via re-render — still depends on textarea state;
    // component owns textarea state so a rerender with actor="ymh" should
    // flip the button.
    rerender(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor="ymh"
        onActorChange={() => {}}
        onSubmit={() => Promise.resolve({ ok: true })}
      />,
    );
    // The previously edited textarea value persists (component-local
    // state), so the button should now be enabled.
    const btnAfter = screen.getByRole("button", { name: /submit proposal/i }) as HTMLButtonElement;
    // Re-edit to ensure modified-state is tracked post-rerender.
    const firstAfter = (screen.getAllByRole("textbox").find((el) => el.tagName === "TEXTAREA")) as HTMLTextAreaElement;
    fireEvent.change(firstAfter, { target: { value: "changed body 2" } });
    expect(btnAfter.disabled).toBe(false);
  });

  it("onSubmit receives only modified refs, not the whole prompts map", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor="ymh"
        onActorChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const textareas = screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement[];
    // Edit only the second one.
    const target = textareas.find((t) => t.value === "original b content")!;
    fireEvent.change(target, { target: { value: "new b body" } });
    fireEvent.click(screen.getByRole("button", { name: /submit proposal/i }));
    // Flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(onSubmit).toHaveBeenCalledWith({ "system/b": "new b body" });
  });

  it("renders inline error when onSubmit returns { ok:false, error }", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: false, error: "NO_OP_PROPOSAL: nothing changed" });
    render(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor="ymh"
        onActorChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const first = screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA")[0] as HTMLTextAreaElement;
    fireEvent.change(first, { target: { value: "tweak" } });
    fireEvent.click(screen.getByRole("button", { name: /submit proposal/i }));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByText(/NO_OP_PROPOSAL/)).toBeDefined();
  });

  it("shows 'no editable prompts' state when originalPrompts is empty", () => {
    render(
      <PromptsEditor
        originalPrompts={{}}
        actor=""
        onActorChange={() => {}}
        onSubmit={() => Promise.resolve({ ok: true })}
      />,
    );
    expect(screen.getByText(/no editable prompts/i)).toBeDefined();
    const btn = screen.queryByRole("button", { name: /submit proposal/i }) as HTMLButtonElement | null;
    // Button absent OR disabled — either works; pick absent for clarity.
    expect(btn).toBeNull();
  });
});
```

- [ ] **Step 2: Run — FAIL (component missing)**

Run: `cd apps/web && npx vitest run src/components/prompts-editor.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement PromptsEditor**

Create `apps/web/src/components/prompts-editor.tsx`:

```tsx
"use client";

// Multi-textarea editor for a pipeline's prompts map. Pure component:
// owns the editable state (textarea values), emits only modified refs
// on submit, displays inline errors from the upstream HTTP call.
// Parent owns `actor` (single source of truth across pages).

import { useState } from "react";

type SubmitResult = { ok: true } | { ok: false; error: string };

interface Props {
  originalPrompts: Record<string, string>;
  actor: string;
  onActorChange: (next: string) => void;
  onSubmit: (modified: Record<string, string>) => Promise<SubmitResult>;
}

export function PromptsEditor({ originalPrompts, actor, onActorChange, onSubmit }: Props) {
  // Local mutable state mirrors originalPrompts at first render and
  // diverges as the user types. modifiedRefs is derived (not stored)
  // so stale state can't drift from textarea values.
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...originalPrompts }));
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const refs = Object.keys(originalPrompts).sort();
  if (refs.length === 0) {
    return (
      <p className="text-sm italic text-gray-600">
        No editable prompts in this pipeline — nothing to iterate via this UI yet.
      </p>
    );
  }

  const modifiedEntries = refs.filter((r) => draft[r] !== originalPrompts[r]);
  const canSubmit = modifiedEntries.length > 0 && actor.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    setSubmitting(true);
    setErrorMsg(null);
    const payload: Record<string, string> = {};
    for (const r of modifiedEntries) payload[r] = draft[r]!;
    try {
      const result = await onSubmit(payload);
      if (!result.ok) setErrorMsg(result.error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-semibold">Actor (required)</span>
        <input
          type="text"
          value={actor}
          onChange={(e) => onActorChange(e.target.value)}
          placeholder="human:ymh"
          className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 font-mono text-sm"
        />
      </label>

      {refs.map((ref) => {
        const modified = draft[ref] !== originalPrompts[ref];
        return (
          <label key={ref} className="block">
            <span className="text-sm font-semibold">
              {ref}{" "}
              {modified && (
                <span className="ml-1 rounded bg-amber-200 px-1 text-[10px] uppercase text-amber-900">
                  modified
                </span>
              )}
            </span>
            <textarea
              value={draft[ref] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [ref]: e.target.value }))}
              rows={10}
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs"
            />
          </label>
        );
      })}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void handleSubmit()}
        className="rounded bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Submit proposal"}
      </button>

      {errorMsg && (
        <p className="text-sm text-red-700">submit failed: {errorMsg}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests — PASS**

Run: `cd apps/web && npx vitest run src/components/prompts-editor.test.tsx`
Expected: PASS all five tests.

- [ ] **Step 5: tsc + full web suite**

Run: `cd apps/web && npx tsc --noEmit && npx vitest run`
Expected: clean + green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/prompts-editor.tsx apps/web/src/components/prompts-editor.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): PromptsEditor — multi-textarea editor for prompts-only proposals

Pure component. Parent owns actor; component owns textarea drafts.
onSubmit receives only modified refs so propose() can carry the rest
forward from base. Inline error path renders server diagnostics from
POST /api/kernel/proposals.

Self-review:
- Correctness: 5 tests (render, submit-disabled gates, only-modified
  payload, inline error, no-prompts state)
- Consistency: styling matches GateCard (amber accent, monospace
  content, Tailwind utilities)
- Regression: no existing UI surface affected
- YAGNI: no draft persistence, no diff view — iterate if needed
- TDD: all five tests RED first; component written once, GREEN observed

M-D complete. Next milestone: pipelines list + detail pages.
EOF
)"
```

**M-D self-review checkpoint reached. Proceed to M-E.**

---

## Task 8: /kernel-next/pipelines list page

**Files:**
- Create: `apps/web/src/app/kernel-next/pipelines/page.tsx`
- Create: `apps/web/src/app/kernel-next/pipelines/page.test.tsx`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/app/kernel-next/pipelines/page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import PipelinesPage from "./page";

describe("PipelinesPage", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = origFetch;
  });

  it("renders empty state when list is empty", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, pipelines: [] }),
    });
    render(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getByText(/no pipelines/i)).toBeDefined();
    });
  });

  it("renders one row per pipeline with a link to the editor", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        pipelines: [
          { name: "pr-description-generator", latestVersion: "a1b2c3d4e5f6", latestCreatedAt: 1_700_000_000_000 },
          { name: "pipeline-generator",       latestVersion: "deadbeefcafe", latestCreatedAt: 1_700_000_001_000 },
        ],
      }),
    });
    render(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getByText("pr-description-generator")).toBeDefined();
      expect(screen.getByText("pipeline-generator")).toBeDefined();
    });
    const link = screen.getByRole("link", { name: /pr-description-generator/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/kernel-next/pipelines/pr-description-generator");
  });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd apps/web && npx vitest run src/app/kernel-next/pipelines/page.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement page**

Create `apps/web/src/app/kernel-next/pipelines/page.tsx`:

```tsx
"use client";

// /kernel-next/pipelines — list all known pipelines with their latest
// version. Click-through navigates to the per-pipeline editor at
// /kernel-next/pipelines/[name].

import { useEffect, useState } from "react";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface PipelineSummary {
  name: string;
  latestVersion: string;
  latestCreatedAt: number;
}

export default function PipelinesPage() {
  const [pipelines, setPipelines] = useState<PipelineSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/kernel/pipelines`, { signal: controller.signal });
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          setPipelines([]);
          return;
        }
        const body = await res.json() as { ok: boolean; pipelines: PipelineSummary[] };
        setPipelines(body.ok ? body.pipelines : []);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setPipelines([]);
      }
    })();
    return () => controller.abort();
  }, []);

  if (pipelines === null) {
    return <p className="p-6 font-mono text-sm text-gray-600">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-4xl p-6 font-mono text-sm">
      <h1 className="mb-4 text-xl font-bold">Pipelines</h1>
      {error && <p className="mb-3 text-red-600">Error: {error}</p>}
      {pipelines.length === 0 ? (
        <p className="text-gray-600">No pipelines registered yet.</p>
      ) : (
        <table className="w-full border-collapse border border-gray-300">
          <thead className="bg-gray-100">
            <tr>
              <th className="border border-gray-300 px-2 py-1 text-left">Name</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Latest version</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Updated</th>
            </tr>
          </thead>
          <tbody>
            {pipelines.map((p) => (
              <tr key={p.name}>
                <td className="border border-gray-300 px-2 py-1">
                  <Link
                    href={`/kernel-next/pipelines/${p.name}`}
                    className="text-blue-600 hover:underline"
                  >
                    {p.name}
                  </Link>
                </td>
                <td className="border border-gray-300 px-2 py-1 text-xs text-gray-600">
                  {p.latestVersion.slice(0, 12)}…
                </td>
                <td className="border border-gray-300 px-2 py-1 text-xs text-gray-500">
                  {new Date(p.latestCreatedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests — PASS**

Run: `cd apps/web && npx vitest run src/app/kernel-next/pipelines/page.test.tsx`
Expected: PASS both.

- [ ] **Step 5: tsc**

Run: `cd apps/web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/kernel-next/pipelines/page.tsx apps/web/src/app/kernel-next/pipelines/page.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): /kernel-next/pipelines — list page with click-through to editor

Fetches GET /api/kernel/pipelines on mount, renders a table with a
Link to the editor (/kernel-next/pipelines/[name]). Empty / error
states handled.

Self-review:
- Correctness: empty + populated path covered
- Consistency: layout mirrors the [taskId] page (max-w, font-mono,
  Tailwind table borders)
- Regression: new route only
- YAGNI: no search, no sort — volume is small
- TDD: red/green cycle observed
EOF
)"
```

---

## Task 9: /kernel-next/pipelines/[name] editor page

**Files:**
- Create: `apps/web/src/app/kernel-next/pipelines/[name]/page.tsx`
- Create: `apps/web/src/app/kernel-next/pipelines/[name]/page.test.tsx`

- [ ] **Step 1: Write failing test — happy path (load + submit)**

Create `apps/web/src/app/kernel-next/pipelines/[name]/page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import PipelineEditorPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "pr-description-generator" }),
  useRouter: () => ({ push: vi.fn() }),
}));

describe("PipelineEditorPage", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    // localStorage prefill test: start clean
    if (typeof window !== "undefined") window.localStorage.clear();
  });
  afterEach(() => {
    global.fetch = origFetch;
  });

  it("loads pipeline, renders PromptsEditor with its prompts map", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({  // GET /api/kernel/pipelines
        ok: true,
        json: async () => ({
          ok: true,
          pipelines: [{ name: "pr-description-generator", latestVersion: "abcdef123456", latestCreatedAt: 1 }],
        }),
      })
      .mockResolvedValueOnce({  // GET /api/kernel/pipelines/:hash
        ok: true,
        json: async () => ({
          ok: true,
          ir: { name: "pr-description-generator", stages: [] },
          prompts: { "system/write-pr": "original body" },
          parentHash: null,
          createdAt: 1,
        }),
      });
    render(<PipelineEditorPage />);
    await waitFor(() => {
      expect(screen.getByText("system/write-pr")).toBeDefined();
    });
    const textareas = screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement[];
    expect(textareas[0]!.value).toBe("original body");
  });

  it("submits POST /api/kernel/proposals with only modified refs", async () => {
    const postMock = vi.fn().mockResolvedValue({
      ok: true, status: 202,
      json: async () => ({ ok: true, proposalId: "prop-1", proposedVersion: "newhash" }),
    });
    (global.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          pipelines: [{ name: "pr-description-generator", latestVersion: "abcdef123456", latestCreatedAt: 1 }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          ir: { name: "pr-description-generator", stages: [] },
          prompts: { "system/write-pr": "original body" },
          parentHash: null,
          createdAt: 1,
        }),
      })
      .mockImplementationOnce(postMock);

    render(<PipelineEditorPage />);
    await waitFor(() => expect(screen.getByText("system/write-pr")).toBeDefined());

    // Edit textarea + actor.
    const ta = (screen.getAllByRole("textbox").find((el) => el.tagName === "TEXTAREA")) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "fresh body" } });
    const actorInput = (screen.getAllByRole("textbox").find((el) => el.tagName === "INPUT")) as HTMLInputElement;
    fireEvent.change(actorInput, { target: { value: "human:ymh" } });

    fireEvent.click(screen.getByRole("button", { name: /submit proposal/i }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const call = postMock.mock.calls[0]!;
    const reqArg = call[0] as Request;
    expect(reqArg.url).toMatch(/\/api\/kernel\/proposals$/);
    const reqBody = JSON.parse(call[1]?.body ?? "{}");
    expect(reqBody).toEqual({
      currentVersion: "abcdef123456",
      patch: { ops: [] },
      actor: "human:ymh",
      prompts: { "system/write-pr": "fresh body" },
    });
  });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd apps/web && npx vitest run src/app/kernel-next/pipelines/\[name\]/page.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement the page**

Create `apps/web/src/app/kernel-next/pipelines/[name]/page.tsx`:

```tsx
"use client";

// /kernel-next/pipelines/[name] — pick the pipeline's latest version,
// fetch its IR + prompts, render PromptsEditor; on submit, POST a
// prompts-only proposal to /api/kernel/proposals and redirect to
// /kernel-next/proposals.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PromptsEditor } from "../../../../components/prompts-editor";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const ACTOR_LS_KEY = "kernelActor";

interface PipelineDetail {
  name: string;
  latestVersion: string;
  prompts: Record<string, string>;
}

export default function PipelineEditorPage() {
  const params = useParams();
  const router = useRouter();
  const nameRaw = params?.name;
  const pipelineName = Array.isArray(nameRaw) ? nameRaw[0]! : (nameRaw as string | undefined);

  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [actor, setActor] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Prefill actor from localStorage so repeat users don't re-type.
    if (typeof window !== "undefined") {
      const saved = window.localStorage.getItem(ACTOR_LS_KEY);
      if (saved) setActor(saved);
    }
  }, []);

  useEffect(() => {
    if (!pipelineName) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const listRes = await fetch(`${API_BASE}/api/kernel/pipelines`, { signal: controller.signal });
        if (!listRes.ok) { setError(`list HTTP ${listRes.status}`); return; }
        const listBody = await listRes.json() as {
          ok: boolean;
          pipelines: Array<{ name: string; latestVersion: string }>;
        };
        const match = listBody.pipelines.find((p) => p.name === pipelineName);
        if (!match) { setError(`pipeline '${pipelineName}' not found`); return; }

        const detailRes = await fetch(
          `${API_BASE}/api/kernel/pipelines/${encodeURIComponent(match.latestVersion)}`,
          { signal: controller.signal },
        );
        if (!detailRes.ok) { setError(`detail HTTP ${detailRes.status}`); return; }
        const detailBody = await detailRes.json() as {
          ok: boolean;
          prompts: Record<string, string>;
        };
        if (!detailBody.ok) { setError("detail not ok"); return; }
        setDetail({ name: pipelineName, latestVersion: match.latestVersion, prompts: detailBody.prompts });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => controller.abort();
  }, [pipelineName]);

  const handleSubmit = useCallback(async (modified: Record<string, string>) => {
    if (!detail) return { ok: false as const, error: "pipeline not loaded" };
    try {
      const res = await fetch(new Request(`${API_BASE}/api/kernel/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentVersion: detail.latestVersion,
          patch: { ops: [] },
          actor,
          prompts: modified,
        }),
      }));
      const body = await res.json() as {
        ok: boolean;
        diagnostics?: Array<{ code: string; message: string }>;
      };
      if (!res.ok || !body.ok) {
        const diag = body.diagnostics?.[0];
        return { ok: false as const, error: diag ? `${diag.code}: ${diag.message}` : `HTTP ${res.status}` };
      }
      if (typeof window !== "undefined") window.localStorage.setItem(ACTOR_LS_KEY, actor);
      router.push("/kernel-next/proposals");
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [detail, actor, router]);

  if (!pipelineName) return <p className="p-6 font-mono">Missing pipeline name.</p>;
  if (error) return <p className="p-6 font-mono text-red-600">Error: {error}</p>;
  if (!detail) return <p className="p-6 font-mono text-gray-600">Loading…</p>;

  return (
    <div className="mx-auto max-w-4xl p-6 font-mono text-sm">
      <h1 className="mb-2 text-xl font-bold">{detail.name}</h1>
      <p className="mb-4 text-xs text-gray-600">
        base version: <code>{detail.latestVersion}</code>
      </p>
      <PromptsEditor
        originalPrompts={detail.prompts}
        actor={actor}
        onActorChange={setActor}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests — PASS**

Run: `cd apps/web && npx vitest run src/app/kernel-next/pipelines/\[name\]/page.test.tsx`
Expected: PASS.

- [ ] **Step 5: tsc + web suite**

Run: `cd apps/web && npx tsc --noEmit && npx vitest run`
Expected: clean + green.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/kernel-next/pipelines/[name]/page.tsx" \
        "apps/web/src/app/kernel-next/pipelines/[name]/page.test.tsx"
git commit -m "$(cat <<'EOF'
feat(ui): /kernel-next/pipelines/[name] — prompts-only proposal editor

Composes GET /api/kernel/pipelines (to resolve latest version) +
GET /api/kernel/pipelines/:hash (to hydrate prompts) + POST
/api/kernel/proposals (empty patch + prompts override). Persists
actor via localStorage so repeat users skip retyping. Redirects to
/kernel-next/proposals on success.

Self-review:
- Correctness: load + submit covered by tests; useRouter mocked
- Consistency: styling mirrors [taskId] page; error envelope decoded
  into "CODE: message" form
- Regression: no cross-page impact
- YAGNI: no prompt diff viewer; handled by the "modified" badge in
  PromptsEditor
- TDD: RED/GREEN cycle observed

M-E complete (pipelines list + editor). Next: proposals list.
EOF
)"
```

**M-E self-review checkpoint reached. Proceed to M-F.**

---

## Task 10: /kernel-next/proposals list + approve/reject

**Files:**
- Create: `apps/web/src/app/kernel-next/proposals/page.tsx`
- Create: `apps/web/src/app/kernel-next/proposals/page.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/app/kernel-next/proposals/page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ProposalsPage from "./page";

describe("ProposalsPage", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = origFetch;
  });

  it("renders pending / approved / rejected sections", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        proposals: [
          { proposalId: "p-1", pipelineName: "pr-description-generator", actor: "ymh", status: "pending", createdAt: 1, baseVersion: "aa", proposedVersion: "bb", diagnosticJson: null, rerunFrom: null, migrateRunning: "none" },
          { proposalId: "p-2", pipelineName: "pipeline-generator",       actor: "ymh", status: "approved", createdAt: 2, baseVersion: "cc", proposedVersion: "dd", diagnosticJson: null, rerunFrom: null, migrateRunning: "none" },
          { proposalId: "p-3", pipelineName: "pr-description-generator", actor: "ymh", status: "rejected", createdAt: 3, baseVersion: "ee", proposedVersion: null, diagnosticJson: null, rerunFrom: null, migrateRunning: "none" },
        ],
      }),
    });
    render(<ProposalsPage />);
    await waitFor(() => expect(screen.getByText("p-1")).toBeDefined());
    expect(screen.getByText(/Pending \(1\)/i)).toBeDefined();
    expect(screen.getByText(/Approved \(1\)/i)).toBeDefined();
    expect(screen.getByText(/Rejected \(1\)/i)).toBeDefined();
  });

  it("approve button POSTs /approve and removes row from pending", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        proposals: [
          { proposalId: "p-1", pipelineName: "pr-description-generator", actor: "ymh", status: "pending", createdAt: 1, baseVersion: "aa", proposedVersion: "bb", diagnosticJson: null, rerunFrom: null, migrateRunning: "none" },
        ],
      }),
    });
    // Approve call succeeds.
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ ok: true, proposalId: "p-1", status: "approved" }),
    });

    render(<ProposalsPage />);
    await waitFor(() => expect(screen.getByText("p-1")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(screen.getByText(/Pending \(0\)/i)).toBeDefined());
  });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd apps/web && npx vitest run src/app/kernel-next/proposals/page.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement page**

Create `apps/web/src/app/kernel-next/proposals/page.tsx`:

```tsx
"use client";

// /kernel-next/proposals — three-section list (pending/approved/
// rejected). Pending rows have Approve / Reject buttons that POST to
// the existing endpoints and locally move the row out of pending on
// success. No migrate-on-approve from UI (see spec §8); use MCP or
// curl for that.

import { useCallback, useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type Status = "pending" | "approved" | "rejected";

interface ProposalRow {
  proposalId: string;
  pipelineName: string;
  baseVersion: string;
  proposedVersion: string | null;
  actor: string;
  status: Status;
  createdAt: number;
  diagnosticJson: string | null;
  rerunFrom: string | null;
  migrateRunning: "all" | "none" | string[];
}

export default function ProposalsPage() {
  const [rows, setRows] = useState<ProposalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/kernel/proposals`, { signal: controller.signal });
        const body = await res.json() as { ok: boolean; proposals: ProposalRow[] };
        setRows(body.ok ? body.proposals : []);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setRows([]);
      }
    })();
    return () => controller.abort();
  }, []);

  const mutateStatus = useCallback(async (id: string, endpoint: "approve" | "reject") => {
    const res = await fetch(`${API_BASE}/api/kernel/proposals/${encodeURIComponent(id)}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: endpoint === "reject" ? JSON.stringify({}) : "",
    });
    const body = await res.json() as { ok: boolean; diagnostics?: Array<{ message: string }> };
    if (!res.ok || !body.ok) {
      setError(body.diagnostics?.[0]?.message ?? `HTTP ${res.status}`);
      return;
    }
    setRows((prev) => (prev ?? []).map((r) =>
      r.proposalId === id ? { ...r, status: endpoint === "approve" ? "approved" : "rejected" } : r,
    ));
  }, []);

  if (error && !rows) return <p className="p-6 font-mono text-red-600">Error: {error}</p>;
  if (!rows) return <p className="p-6 font-mono text-gray-600">Loading…</p>;

  const pending = rows.filter((r) => r.status === "pending");
  const approved = rows.filter((r) => r.status === "approved");
  const rejected = rows.filter((r) => r.status === "rejected");

  const Section = ({ title, items, actions }: {
    title: string;
    items: ProposalRow[];
    actions?: (r: ProposalRow) => React.ReactNode;
  }) => (
    <section className="mb-6">
      <h2 className="mb-2 text-base font-semibold">{title} ({items.length})</h2>
      {items.length === 0 ? (
        <p className="text-xs text-gray-500">none</p>
      ) : (
        <table className="w-full border-collapse border border-gray-300">
          <thead className="bg-gray-100">
            <tr>
              <th className="border border-gray-300 px-2 py-1 text-left">Proposal</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Pipeline</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Actor</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Created</th>
              {actions && <th className="border border-gray-300 px-2 py-1 text-left">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.proposalId}>
                <td className="border border-gray-300 px-2 py-1 text-xs">{r.proposalId}</td>
                <td className="border border-gray-300 px-2 py-1">{r.pipelineName}</td>
                <td className="border border-gray-300 px-2 py-1 text-xs">{r.actor}</td>
                <td className="border border-gray-300 px-2 py-1 text-xs text-gray-500">
                  {new Date(r.createdAt).toLocaleString()}
                </td>
                {actions && <td className="border border-gray-300 px-2 py-1">{actions(r)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );

  return (
    <div className="mx-auto max-w-5xl p-6 font-mono text-sm">
      <h1 className="mb-4 text-xl font-bold">Proposals</h1>
      {error && <p className="mb-3 text-red-600">Error: {error}</p>}
      <Section
        title="Pending"
        items={pending}
        actions={(r) => (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void mutateStatus(r.proposalId, "approve")}
              className="rounded bg-green-700 px-2 py-1 text-xs font-semibold text-white hover:bg-green-800"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => void mutateStatus(r.proposalId, "reject")}
              className="rounded bg-red-700 px-2 py-1 text-xs font-semibold text-white hover:bg-red-800"
            >
              Reject
            </button>
          </div>
        )}
      />
      <Section title="Approved" items={approved} />
      <Section title="Rejected" items={rejected} />
    </div>
  );
}
```

- [ ] **Step 4: Run tests — PASS**

Run: `cd apps/web && npx vitest run src/app/kernel-next/proposals/page.test.tsx`
Expected: PASS both.

- [ ] **Step 5: tsc + web suite**

Run: `cd apps/web && npx tsc --noEmit && npx vitest run`
Expected: clean + green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/kernel-next/proposals/page.tsx apps/web/src/app/kernel-next/proposals/page.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): /kernel-next/proposals — list with approve/reject

Three-section layout (pending/approved/rejected). Approve/Reject POST
to existing endpoints and move the row out of pending locally.
Migrate-on-approve deliberately not wired — MCP/curl still available
and dogfood volume is low.

Self-review:
- Correctness: render + approve flow covered
- Consistency: same table chrome as PipelinesPage + GateCard buttons
- Regression: isolated route
- YAGNI: no pagination, no filter, no diff viewer
- TDD: RED/GREEN observed

M-F complete. Final milestone: nav wiring + dogfood M4 sample.
EOF
)"
```

**M-F self-review checkpoint reached. Proceed to M-G.**

---

## Task 11: Nav integration

**Files:**
- Modify: `apps/web/src/components/nav.tsx`
- Modify: `apps/web/src/messages/en/common.json`
- Modify: `apps/web/src/messages/zh/common.json`

- [ ] **Step 1: Add translation keys**

Edit `apps/web/src/messages/en/common.json`, expand `nav`:

```json
"nav": {
  "tasks": "Tasks",
  "pipelines": "Pipelines",
  "proposals": "Proposals",
  "config": "Config",
  "store": "Store",
  "help": "Help"
},
```

Edit `apps/web/src/messages/zh/common.json` the same way (use
meaningful Chinese, matching the style of the existing entries;
concretely:

```json
"nav": {
  "tasks": "任务",
  "pipelines": "流水线",
  "proposals": "版本提案",
  "config": "配置",
  "store": "商店",
  "help": "帮助"
},
```

(If the file already has keys for the existing entries in Chinese,
preserve them verbatim and only add `pipelines` + `proposals`.)

- [ ] **Step 2: Wire links in nav.tsx**

Edit `apps/web/src/components/nav.tsx`:

```tsx
"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

const Nav = () => {
  const t = useTranslations("Common");
  const router = useRouter();

  const switchLocale = (locale: string) => {
    document.cookie = `locale=${locale};path=/;max-age=31536000`;
    router.refresh();
  };

  const link = "text-sm text-zinc-400 hover:text-zinc-200 transition-colors";

  return (
    <nav className="flex items-center gap-6">
      <h1 className="text-lg font-semibold">{t("appTitle")}</h1>
      <a href="/" className={link}>{t("nav.tasks")}</a>
      <a href="/kernel-next/pipelines" className={link}>{t("nav.pipelines")}</a>
      <a href="/kernel-next/proposals" className={link}>{t("nav.proposals")}</a>
      <div className="ml-auto flex items-center gap-1 text-xs">
        <button
          onClick={() => switchLocale("en")}
          className="px-2 py-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {t("language.en")}
        </button>
        <span className="text-zinc-600">|</span>
        <button
          onClick={() => switchLocale("zh")}
          className="px-2 py-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {t("language.zh")}
        </button>
      </div>
    </nav>
  );
};

export default Nav;
```

- [ ] **Step 3: tsc + web suite**

Run: `cd apps/web && npx tsc --noEmit && npx vitest run`
Expected: clean + green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/nav.tsx apps/web/src/messages/en/common.json apps/web/src/messages/zh/common.json
git commit -m "$(cat <<'EOF'
feat(ui): nav links for /kernel-next/pipelines and /kernel-next/proposals

Adds two entries + EN/ZH translation keys so the new UI surfaces are
reachable from every page.

Self-review:
- Correctness: hrefs match the new routes
- Consistency: styling extracted to `link` constant; i18n key pattern
  unchanged
- Regression: nav still renders on existing pages
- YAGNI: no breadcrumb / active-state yet — simple hrefs
- TDD: no behavioural test — this is wiring only; tsc + smoke covers it
EOF
)"
```

---

## Task 12: Dogfood M4 data point

**Files:** none (manual verification step)

- [ ] **Step 1: Start server fresh**

```bash
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill
sleep 2
rm -f /tmp/workflow-control-data/kernel-next.db*
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server.log 2>&1 &
sleep 20
lsof -nP -iTCP:3001 | head -3
```

Confirm 3001 open.

- [ ] **Step 2: Start web**

```bash
cd /Users/minghao/workflow-control/apps/web && npx next dev -p 3000 > /tmp/web.log 2>&1 &
sleep 15
curl -s http://localhost:3000 >/dev/null && echo "web ok"
```

- [ ] **Step 3: In a browser, walk the flow**

1. Open `http://localhost:3000/kernel-next/pipelines`.
2. Click `pr-description-generator`.
3. Edit `system/write-pr.md` — add a new rule, e.g.,
   `- Reference the related GitHub issue if any.`
4. Enter `human:ymh` as actor.
5. Click Submit proposal.
6. Page redirects to `/kernel-next/proposals`; pending section has a
   new row.
7. Click Approve → row moves to approved.
8. Open a separate terminal, kick off a task via existing route:

```bash
curl -s -X POST http://localhost:3001/api/kernel/tasks/run \
  -H "content-type: application/json" \
  -d '{
    "pipelineName": "pr-description-generator",
    "externalInputs": {
      "branchName": "main",
      "baseBranch": "main",
      "repoPath": "/Users/minghao/workflow-control"
    }
  }' | jq .
```

9. Open `/kernel-next/<taskId>` to watch it run; confirm the new
   rule influences the output (either "related issue" mentioned, or
   its absence reported per the prompt).

- [ ] **Step 4: Log the sample**

Append a `run #16` block to `docs/phase6-usage-log.md` with:
- New prompt rule text verbatim
- `proposedVersion` hash (from the proposals page)
- Whether the rule took effect (0 reject / 0 rollback = pass)

- [ ] **Step 5: Commit the log update**

```bash
git add docs/phase6-usage-log.md
git commit -m "$(cat <<'EOF'
docs(phase6): run #16 — first M4 data point through the new propose UI

Prompt iteration from browser (no curl, no MCP). End-to-end path:
/kernel-next/pipelines → editor → submit → /kernel-next/proposals →
approve → new run observes the updated rule.

M4 now at 3 propose / 0 reject / 0 rollback.

Self-review:
- Functional: new rule verifiably influenced output
- UI: every step reachable from nav; no shell needed for the propose
  path
- M-G complete. Full feature shipped.
EOF
)"
```

---

## Final verification

- [ ] **Step 1: Full repo type check**

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Run: `cd /Users/minghao/workflow-control/apps/web && npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 2: Full repo tests**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run`
Run: `cd /Users/minghao/workflow-control/apps/web && npx vitest run`
Expected: both green.

- [ ] **Step 3: Invoke finishing-a-development-branch skill**

Since work was done directly on main (authorized), the skill's
branch-merge options aren't applicable. But the verification step
is: tests pass + tsc clean = done. Log the summary.

---

## Self-review of this plan

**Spec coverage:**
- §2 architecture (API + Inventory + UI) → Tasks 1-3 (API), 4-6
  (Inventory+enrichment), 7-10 (UI) — covered
- §3.1 NO_OP_PROPOSAL → Task 3 — covered
- §3.2 inventory endpoints → Tasks 4-5 — covered
- §3.3 list page → Task 8 — covered
- §3.4 detail/edit page → Task 9 — covered
- §3.5 proposals page → Task 10 — covered
- §3.6 pipelineName enrichment → Task 6 — covered
- §3.7 nav → Task 11 — covered
- §4 data flow — verified in Task 12 dogfood
- §5 error table — NO_OP_PROPOSAL tested (T3), stale version tested
  via existing PATCH_APPLY_ERROR path, PROPOSAL_ALREADY_RESOLVED tested
  in existing proposals test suite (unchanged)
- §6 testing — each task ships its tests
- §7 milestones — M-A..M-G labelled in commit messages
- §8 out of scope — none implemented

**Placeholder scan:** none found.

**Type consistency:**
- `PipelineSummary` in Task 4 backend = Task 8 frontend (same 3 fields)
- `ProposalRow` in Task 6 backend + Task 10 frontend (frontend has
  same keys; matches enrichment)
- `PromptsEditor` props in Task 7 = usage in Task 9 (same shape:
  originalPrompts, actor, onActorChange, onSubmit)
- `NO_OP_PROPOSAL` spelled identically in Tasks 1/3/route test cases

Plan is consistent.
