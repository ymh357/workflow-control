# B5 Confirm UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dashboard render per-task pending gates with full upstream-stage context and answer them with a button click, replacing the current `curl + sqlite3` flow that was shown to be blocking M2 in Phase 6 runs #4–#7.

**Architecture:** One new read endpoint (`GET /api/kernel/gates/:gateId/context`) that joins `gate_queue` + IR wires + latest successful `port_values` to assemble a decision payload. One new React component (`GateCard`) plus two `useEffect` hooks on the existing per-task page: a 2 s `/status` poller that discovers pending gate IDs, and a fetcher that loads `/context` for each new ID. Answer flow reuses the unmodified `POST /api/kernel/gates/:gateId/answer`.

**Tech Stack:** TypeScript 5, Hono (HTTP), Zod (request validation), node:sqlite, Vitest (server), React 19 / Next.js 15 App Router (client). No new dependencies.

**Source spec:** `docs/superpowers/specs/2026-04-23-b5-confirm-ui-design.md`

---

## File Structure

**Server (modify):**

- `apps/server/src/kernel-next/mcp/kernel.ts` — add `GateContext` type + `getGateContext(gateId)` method on `KernelService`. Same file as `createGate/listGates/answerGate`.
- `apps/server/src/kernel-next/mcp/kernel.test.ts` — add `describe("KernelService.getGateContext")` block.
- `apps/server/src/routes/kernel-gates.ts` — add `GET /kernel/gates/:id/context` handler. Same file as the existing answer route.
- `apps/server/src/routes/kernel-gates.test.ts` — add REST coverage for the new route.

**Client (create + modify):**

- `apps/web/src/components/gate-card.tsx` (create) — one self-contained React component rendering a pending gate.
- `apps/web/src/app/kernel-next/[taskId]/page.tsx` — add polling + gate-context fetching + card rendering in the existing page.

**No changes** to SSE types/broadcaster, `/status` endpoint, `/answer` endpoint, runner, or XState compiler.

---

## Task 1: `GateContext` response type

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/kernel.ts` (export a new interface near the existing `GateRow`)

- [ ] **Step 1: Add the `GateContext` interface**

Open `apps/server/src/kernel-next/mcp/kernel.ts`. Immediately below the existing `PendingGate` interface (around line 184 — search for `export interface PendingGate`), add:

```ts
/**
 * B5: full decision payload for a single gate. Returned by
 * KernelService.getGateContext and consumed by the dashboard's
 * GateCard. `upstreams[i].outputs` holds every latest successful
 * output port of a stage that feeds this gate via a wire with
 * `from.source === 'stage'`. External-sourced wires contribute no
 * upstream entry (they render in the page's existing Seed block).
 */
export interface GateContext {
  gateId: string;
  taskId: string;
  stageName: string;
  question: { text: string; options?: string[] };
  createdAt: number;
  answeredAt: number | null;
  answer: string | null;
  answerOptions: string[];
  upstreams: Array<{
    stage: string;
    outputs: Array<{
      port: string;
      value: unknown;
      writtenAt: number;
    }>;
  }>;
}

export type GateContextResult =
  | { ok: true; context: GateContext }
  | { ok: false; diagnostics: Diagnostic[] };
```

- [ ] **Step 2: Run type check to confirm the interface compiles**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 0 errors. (The type is exported but not yet used — tsc must still accept it.)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/kernel-next/mcp/kernel.ts
git commit -m "feat(B5): GateContext response type"
```

---

## Task 2: Failing test — happy path for `getGateContext`

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/kernel.test.ts`

- [ ] **Step 1: Add a new `describe` block at the end of the file**

Append to `apps/server/src/kernel-next/mcp/kernel.test.ts`:

```ts
describe("KernelService.getGateContext — B5", () => {
  // Helper: pipeline with one 3-output upstream agent `A`, one gate
  // `G` fed by A.x, and a rollback route so `_default` filtering and
  // answerOptions both get exercised.
  function gateCtxIR() {
    return {
      name: "ctx-test",
      stages: [
        {
          name: "A", type: "agent" as const,
          inputs: [],
          outputs: [
            { name: "x", type: "number" as const },
            { name: "summary", type: "string" as const },
            { name: "items", type: "string[]" as const },
          ],
          config: { promptRef: "p" },
        },
        {
          name: "G", type: "gate" as const,
          inputs: [{ name: "__gate_signal", type: "unknown" as const }],
          outputs: [],
          config: {
            question: { text: "Continue?", options: ["approve", "reject"] },
            routing: {
              routes: { approve: "done", reject: "A", _default: "done" },
            },
          },
        },
        {
          name: "done", type: "agent" as const,
          inputs: [{ name: "ack", type: "unknown" as const }],
          outputs: [],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        { from: { source: "stage" as const, stage: "A", port: "x" },
          to: { stage: "G", port: "__gate_signal" } },
      ],
    };
  }

  function seedUpstreamOutputs(
    db: DatabaseSync,
    taskId: string,
    versionHash: string,
  ): void {
    // One successful attempt on A with 3 port writes.
    const attemptId = "a-" + Math.random().toString(36).slice(2, 10);
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, ended_at, status, kind)
       VALUES (?, ?, ?, 'A', 1, ?, ?, 'success', 'regular')`,
    ).run(attemptId, taskId, versionHash, now - 100, now - 50);
    const rows: Array<[string, unknown]> = [
      ["x", 42],
      ["summary", "hello world"],
      ["items", ["a", "b", "c"]],
    ];
    for (const [port, value] of rows) {
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction,
          value_json, written_at)
         VALUES (?, ?, 'A', ?, 'out', ?, ?)`,
      ).run(
        "v-" + Math.random().toString(36).slice(2, 10),
        attemptId, port, JSON.stringify(value), now - 50,
      );
    }
  }

  function openGateAttempt(
    db: DatabaseSync,
    taskId: string,
    versionHash: string,
  ): string {
    const attemptId = "ga-" + Math.random().toString(36).slice(2, 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status, kind)
       VALUES (?, ?, ?, 'G', 1, ?, 'running', 'regular')`,
    ).run(attemptId, taskId, versionHash, Date.now());
    return attemptId;
  }

  it("returns question + answerOptions (minus _default) + upstream outputs", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(gateCtxIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed: " + JSON.stringify(submit.diagnostics));

      seedUpstreamOutputs(db, "t1", submit.versionHash);
      const gateAttempt = openGateAttempt(db, "t1", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId: gateAttempt,
        question: { text: "Continue?", options: ["approve", "reject"] },
      });

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ctx = r.context;
      expect(ctx.gateId).toBe(gateId);
      expect(ctx.taskId).toBe("t1");
      expect(ctx.stageName).toBe("G");
      expect(ctx.question).toEqual({ text: "Continue?", options: ["approve", "reject"] });
      expect(ctx.answer).toBeNull();
      expect(ctx.answeredAt).toBeNull();
      // _default must be filtered out.
      expect(ctx.answerOptions.sort()).toEqual(["approve", "reject"]);
      // One upstream (A). External wires don't contribute; gate has none.
      expect(ctx.upstreams).toHaveLength(1);
      expect(ctx.upstreams[0]!.stage).toBe("A");
      // Outputs sorted by port_name ascending, values parsed back from JSON.
      expect(ctx.upstreams[0]!.outputs.map((o) => o.port)).toEqual(["items", "summary", "x"]);
      expect(ctx.upstreams[0]!.outputs.find((o) => o.port === "x")!.value).toBe(42);
      expect(ctx.upstreams[0]!.outputs.find((o) => o.port === "summary")!.value).toBe("hello world");
      expect(ctx.upstreams[0]!.outputs.find((o) => o.port === "items")!.value).toEqual(["a", "b", "c"]);
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/kernel.test.ts -t "getGateContext"`
Expected: FAIL with `svc.getGateContext is not a function` or `TypeError`.

- [ ] **Step 3: Commit the failing test**

```bash
git add apps/server/src/kernel-next/mcp/kernel.test.ts
git commit -m "test(B5): failing test for KernelService.getGateContext happy path"
```

---

## Task 3: Implement `getGateContext` to pass happy-path test

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/kernel.ts`

- [ ] **Step 1: Add the method**

Locate `answerGate` in `apps/server/src/kernel-next/mcp/kernel.ts` (starts around line 789). Immediately above it, add:

```ts
  /**
   * B5 — assemble a gate's full decision payload. The UI calls this
   * once per pending gate to render upstream-stage context, question
   * text, and the set of valid answer keys.
   *
   * Diagnostics use the same vocabulary as answerGate so the HTTP
   * route can reuse the existing mapping (GATE_NOT_FOUND → 404,
   * GATE_ANSWER_INVALID → 500 for corrupted lineage).
   */
  getGateContext(gateId: string): GateContextResult {
    const row = this.db.prepare(
      `SELECT gate_id, task_id, stage_name, attempt_id, question_json,
              answer, answered_at, created_at
       FROM gate_queue WHERE gate_id = ?`,
    ).get(gateId) as
      | {
          gate_id: string;
          task_id: string;
          stage_name: string;
          attempt_id: string;
          question_json: string;
          answer: string | null;
          answered_at: number | null;
          created_at: number;
        }
      | undefined;
    if (!row) {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_NOT_FOUND",
          message: `gateId '${gateId}' not found`,
          context: { gateId },
        }],
      };
    }

    const attemptRow = this.db.prepare(
      `SELECT version_hash FROM stage_attempts WHERE attempt_id = ?`,
    ).get(row.attempt_id) as { version_hash: string } | undefined;
    if (!attemptRow) {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_ANSWER_INVALID",
          message: `gate '${gateId}' references attempt '${row.attempt_id}' which no longer exists`,
          context: { gateId, attemptId: row.attempt_id },
        }],
      };
    }
    const ir = getPipelineIR(this.db, attemptRow.version_hash);
    if (!ir) {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_ANSWER_INVALID",
          message: `pipeline version '${attemptRow.version_hash}' not found for gate '${gateId}'`,
          context: { gateId, versionHash: attemptRow.version_hash },
        }],
      };
    }
    const stage = ir.stages.find((s) => s.name === row.stage_name);
    if (!stage || stage.type !== "gate") {
      return {
        ok: false,
        diagnostics: [{
          code: "GATE_ANSWER_INVALID",
          message: `stage '${row.stage_name}' is not a gate in version '${attemptRow.version_hash}'`,
          context: { gateId, stageName: row.stage_name },
        }],
      };
    }

    // Answer options = routing keys minus "_default" (which is a
    // fallback, not a user-selectable answer).
    const answerOptions = Object.keys(stage.config.routing.routes)
      .filter((k) => k !== "_default")
      .sort();

    // Upstream stages: every stage-sourced wire whose target is this
    // gate. External wires contribute no stage context — seed values
    // render in the page's existing Seed Inputs block.
    const upstreamSet = new Set<string>();
    for (const w of ir.wires) {
      if (w.to.stage !== row.stage_name) continue;
      if (w.from.source !== "stage") continue;
      upstreamSet.add(w.from.stage);
    }

    // Per upstream, fetch latest successful output per port for the
    // same task. The per-port subquery scopes by (task_id, stage_name,
    // port_name, direction='out') so a later superseded attempt's
    // writes (if any) never clobber the success row of the same
    // attempt — we additionally require sa.status='success' on the
    // outer join.
    const outputsStmt = this.db.prepare(
      `SELECT pv.port_name,
              pv.value_json,
              pv.written_at
       FROM port_values pv
       JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
       WHERE sa.task_id = ?
         AND sa.stage_name = ?
         AND sa.status = 'success'
         AND pv.direction = 'out'
         AND pv.written_at = (
           SELECT MAX(pv2.written_at)
           FROM port_values pv2
           JOIN stage_attempts sa2 ON sa2.attempt_id = pv2.attempt_id
           WHERE sa2.task_id = sa.task_id
             AND sa2.stage_name = sa.stage_name
             AND pv2.port_name = pv.port_name
             AND pv2.direction = 'out'
             AND sa2.status = 'success'
         )
       ORDER BY pv.port_name ASC`,
    );

    const upstreams: GateContext["upstreams"] = [];
    for (const stageName of Array.from(upstreamSet).sort()) {
      const rows = outputsStmt.all(row.task_id, stageName) as Array<{
        port_name: string;
        value_json: string;
        written_at: number;
      }>;
      const outputs = rows.map((r) => {
        let value: unknown;
        try { value = JSON.parse(r.value_json); }
        catch { value = null; }
        return { port: r.port_name, value, writtenAt: r.written_at };
      });
      upstreams.push({ stage: stageName, outputs });
    }

    return {
      ok: true,
      context: {
        gateId: row.gate_id,
        taskId: row.task_id,
        stageName: row.stage_name,
        question: JSON.parse(row.question_json),
        createdAt: row.created_at,
        answeredAt: row.answered_at,
        answer: row.answer,
        answerOptions,
        upstreams,
      },
    };
  }
```

Ensure the file already imports `getPipelineIR` (it does — used by `answerGate` — grep confirms).

- [ ] **Step 2: Run the happy-path test and confirm it passes**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/kernel.test.ts -t "getGateContext"`
Expected: PASS, 1 test.

- [ ] **Step 3: Full test suite — zero regression**

Run: `cd apps/server && npx vitest run`
Expected: same pass count as before plus 1 (currently 1400 / 4 skipped → expect 1401 / 4).

- [ ] **Step 4: tsc green**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 0 output.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp/kernel.ts
git commit -m "feat(B5): KernelService.getGateContext"
```

---

## Task 4: Remaining `getGateContext` edge-case tests

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/kernel.test.ts`

- [ ] **Step 1: Add the five remaining tests inside the existing describe block**

Inside `describe("KernelService.getGateContext — B5", ...)` in `apps/server/src/kernel-next/mcp/kernel.test.ts` (append inside the braces, after the happy-path `it`), add:

```ts
  it("unknown gate -> GATE_NOT_FOUND", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const r = svc.getGateContext("does-not-exist");
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.diagnostics[0]!.code).toBe("GATE_NOT_FOUND");
    } finally {
      db.close();
    }
  });

  it("already-answered gate still returns 200 with answer and answeredAt populated", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(gateCtxIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      seedUpstreamOutputs(db, "t2", submit.versionHash);
      const gateAttempt = openGateAttempt(db, "t2", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "t2", stageName: "G", attemptId: gateAttempt,
        question: { text: "Continue?", options: ["approve", "reject"] },
      });
      const ans = svc.answerGate(gateId, "approve");
      expect(ans.ok).toBe(true);

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.context.answer).toBe("approve");
      expect(typeof r.context.answeredAt).toBe("number");
    } finally {
      db.close();
    }
  });

  it("gate with zero stage upstream (pure external-feed) returns upstreams=[]", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const ir = {
        name: "ext-only-gate",
        externalInputs: [{ name: "sig", type: "unknown" as const }],
        stages: [
          { name: "G", type: "gate" as const,
            inputs: [{ name: "__gate_signal", type: "unknown" as const }],
            outputs: [],
            config: {
              question: { text: "?" },
              routing: { routes: { approve: "done" } },
            } },
          { name: "done", type: "agent" as const,
            inputs: [{ name: "ack", type: "unknown" as const }],
            outputs: [],
            config: { promptRef: "p" } },
        ],
        wires: [
          { from: { source: "external" as const, port: "sig" },
            to: { stage: "G", port: "__gate_signal" } },
        ],
      };
      const submit = svc.submit(ir, { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      const gateAttempt = openGateAttempt(db, "t3", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "t3", stageName: "G", attemptId: gateAttempt,
        question: { text: "?" },
      });

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.context.upstreams).toEqual([]);
      expect(r.context.answerOptions).toEqual(["approve"]);
    } finally {
      db.close();
    }
  });

  it("superseded attempts are ignored; only success attempts' latest port values surface", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(gateCtxIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");

      // 1) Superseded attempt with an early "wrong" value.
      const supAttempt = "sup-" + Math.random().toString(36).slice(2, 10);
      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind)
         VALUES (?, 't4', ?, 'A', 1, ?, ?, 'superseded', 'regular')`,
      ).run(supAttempt, submit.versionHash, 100, 200);
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction,
          value_json, written_at)
         VALUES ('v-sup-x', ?, 'A', 'x', 'out', '999', 150)`,
      ).run(supAttempt);

      // 2) Subsequent success attempt with the real value.
      const successAttempt = "succ-" + Math.random().toString(36).slice(2, 10);
      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind)
         VALUES (?, 't4', ?, 'A', 2, ?, ?, 'success', 'regular')`,
      ).run(successAttempt, submit.versionHash, 300, 400);
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction,
          value_json, written_at)
         VALUES ('v-suc-x', ?, 'A', 'x', 'out', '42', 350)`,
      ).run(successAttempt);

      const gateAttempt = openGateAttempt(db, "t4", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "t4", stageName: "G", attemptId: gateAttempt,
        question: { text: "Continue?", options: ["approve", "reject"] },
      });

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const xOut = r.context.upstreams[0]!.outputs.find((o) => o.port === "x");
      expect(xOut).toBeDefined();
      expect(xOut!.value).toBe(42); // not 999
    } finally {
      db.close();
    }
  });

  it("corrupted value_json surfaces as value=null without throwing", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(gateCtxIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");

      const attemptId = "a-" + Math.random().toString(36).slice(2, 10);
      const now = Date.now();
      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind)
         VALUES (?, 't5', ?, 'A', 1, ?, ?, 'success', 'regular')`,
      ).run(attemptId, submit.versionHash, now - 100, now - 50);
      // Intentionally invalid JSON — simulates lineage corruption.
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction,
          value_json, written_at)
         VALUES ('v-bad', ?, 'A', 'x', 'out', '{not valid json', ?)`,
      ).run(attemptId, now - 50);

      const gateAttempt = openGateAttempt(db, "t5", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "t5", stageName: "G", attemptId: gateAttempt,
        question: { text: "?" },
      });

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const xOut = r.context.upstreams[0]!.outputs.find((o) => o.port === "x");
      expect(xOut).toBeDefined();
      expect(xOut!.value).toBeNull();
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 2: Run the new tests to verify they pass**

Run: `cd apps/server && npx vitest run src/kernel-next/mcp/kernel.test.ts -t "getGateContext"`
Expected: PASS, 5 tests total (1 from Task 2 + 4 new).

- [ ] **Step 3: Full suite — no regression**

Run: `cd apps/server && npx vitest run`
Expected: pass count = previous + 4 (so 1405 / 4 skipped).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/kernel-next/mcp/kernel.test.ts
git commit -m "test(B5): getGateContext edge cases (not-found, answered, external-only, superseded, bad JSON)"
```

---

## Task 5: HTTP route + tests

**Files:**
- Modify: `apps/server/src/routes/kernel-gates.ts`
- Modify: `apps/server/src/routes/kernel-gates.test.ts`

- [ ] **Step 1: Add the route handler**

Open `apps/server/src/routes/kernel-gates.ts`. Just before `kernelGatesRoute.post("/kernel/gates/:id/answer", ...)` (around line 65), add:

```ts
kernelGatesRoute.get("/kernel/gates/:id/context", (c) => {
  const id = c.req.param("id");
  const svc = new KernelService(getKernelNextDb(), { skipTypeCheck: true });
  const r = svc.getGateContext(id);
  if (r.ok) return c.json({ ok: true, ...r.context });
  const code = r.diagnostics[0]?.code;
  const status = code === "GATE_NOT_FOUND" ? 404 : 500;
  return c.json(r, status);
});
```

- [ ] **Step 2: Add REST-level tests**

Append to `apps/server/src/routes/kernel-gates.test.ts`, inside the top-level `describe("REST /api/kernel/gates", ...)` block:

```ts
  it("GET /:id/context returns 200 with gate payload + upstreams", async () => {
    const app = buildApp();
    const svc = new KernelService(db, { skipTypeCheck: true });

    // Seed upstream A (success attempt writing x=7).
    const sub = svc.submit(gateIR(), { prompts: { p: "dummy" } });
    if (!sub.ok) throw new Error("seed submit failed");
    const aAttempt = "a-" + Math.random().toString(36).slice(2, 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, ended_at, status, kind)
       VALUES (?, 't-ctx', ?, 'A', 1, 100, 200, 'success', 'regular')`,
    ).run(aAttempt, sub.versionHash);
    db.prepare(
      `INSERT INTO port_values
       (value_id, attempt_id, stage_name, port_name, direction,
        value_json, written_at)
       VALUES ('v-ctx-x', ?, 'A', 'x', 'out', '7', 150)`,
    ).run(aAttempt);

    // Open a gate on G.
    const gAttempt = "g-" + Math.random().toString(36).slice(2, 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status)
       VALUES (?, 't-ctx', ?, 'G', 1, 300, 'running')`,
    ).run(gAttempt, sub.versionHash);
    const { gateId } = svc.createGate({
      taskId: "t-ctx", stageName: "G", attemptId: gAttempt,
      question: { text: "continue?", options: ["yes", "no"] },
    });

    const res = await app.fetch(
      new Request(`http://test/api/kernel/gates/${gateId}/context`),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      gateId: string;
      answerOptions: string[];
      upstreams: Array<{ stage: string; outputs: Array<{ port: string; value: unknown }> }>;
    };
    expect(body.ok).toBe(true);
    expect(body.gateId).toBe(gateId);
    expect(body.answerOptions.sort()).toEqual(["no", "yes"]);
    expect(body.upstreams).toHaveLength(1);
    expect(body.upstreams[0]!.stage).toBe("A");
    expect(body.upstreams[0]!.outputs[0]!.value).toBe(7);
  });

  it("GET /:id/context returns 404 with GATE_NOT_FOUND for unknown gate", async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://test/api/kernel/gates/nonexistent/context`),
    );
    expect(res.status).toBe(404);
    const body = await res.json() as {
      ok: boolean;
      diagnostics: Array<{ code: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("GATE_NOT_FOUND");
  });
```

- [ ] **Step 3: Run the route tests**

Run: `cd apps/server && npx vitest run src/routes/kernel-gates.test.ts`
Expected: PASS including the 2 new tests.

- [ ] **Step 4: Full suite + tsc**

Run: `cd apps/server && npx vitest run && npx tsc --noEmit`
Expected: all pass, 0 tsc output.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/kernel-gates.ts apps/server/src/routes/kernel-gates.test.ts
git commit -m "feat(B5): GET /api/kernel/gates/:id/context route"
```

---

## Task 6: `GateCard` React component

**Files:**
- Create: `apps/web/src/components/gate-card.tsx`

- [ ] **Step 1: Create the component file**

Create `apps/web/src/components/gate-card.tsx`:

```tsx
"use client";

// B5 Confirm UI — renders a single pending gate with its upstream
// decision context and answer buttons. The parent page owns gate
// lifecycle (polling /status, fetching /context, dispatching
// /answer); this component is a pure render + click-forward.

import { useState } from "react";

export interface GateContextResponse {
  gateId: string;
  taskId: string;
  stageName: string;
  question: { text: string; options?: string[] };
  createdAt: number;
  answeredAt: number | null;
  answer: string | null;
  answerOptions: string[];
  upstreams: Array<{
    stage: string;
    outputs: Array<{
      port: string;
      value: unknown;
      writtenAt: number;
    }>;
  }>;
}

interface Props {
  context: GateContextResponse;
  // Returns { ok: true } on HTTP success, { ok: false, error } otherwise.
  onAnswer: (answer: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

// Truncate long string / JSON values to keep the card scrollable.
// 2 kB is roughly two screens in a monospace font at typical DPI —
// plenty for decision-making without breaking layout on
// pipeline-generator's fat `subPipelineContracts`.
const PREVIEW_LIMIT = 2048;

function renderValue(value: unknown): { text: string; truncated: boolean } {
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
  if (text.length <= PREVIEW_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, PREVIEW_LIMIT) + " …", truncated: true };
}

function PortRow({ port, value, writtenAt }: { port: string; value: unknown; writtenAt: number }) {
  const [expanded, setExpanded] = useState(false);
  const rendered = expanded
    ? { text: typeof value === "string" ? value : JSON.stringify(value, null, 2), truncated: false }
    : renderValue(value);
  return (
    <tr>
      <td className="border border-gray-300 px-2 py-1 align-top font-semibold">{port}</td>
      <td className="border border-gray-300 px-2 py-1 align-top">
        <pre className="whitespace-pre-wrap break-all text-xs">{rendered.text}</pre>
        {rendered.truncated && !expanded && (
          <button
            type="button"
            className="mt-1 text-xs text-blue-600 underline"
            onClick={() => setExpanded(true)}
          >
            show full
          </button>
        )}
      </td>
      <td className="border border-gray-300 px-2 py-1 align-top text-xs text-gray-500">
        {new Date(writtenAt).toLocaleTimeString()}
      </td>
    </tr>
  );
}

export function GateCard({ context, onAnswer }: Props) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const click = async (answer: string) => {
    setSubmitting(answer);
    setErrorMsg(null);
    try {
      const r = await onAnswer(answer);
      if (!r.ok) setErrorMsg(r.error);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <section className="mb-6 rounded border border-amber-400 bg-amber-50 p-4">
      <h2 className="mb-1 text-base font-bold text-amber-900">
        Gate pending: <span className="font-mono">{context.stageName}</span>
      </h2>
      <p className="mb-3 text-sm">{context.question.text}</p>

      {context.upstreams.length === 0 ? (
        <p className="mb-3 text-xs italic text-gray-600">
          (no stage upstream; gate is fed by external inputs only)
        </p>
      ) : (
        context.upstreams.map((up) => (
          <details key={up.stage} className="mb-2" open>
            <summary className="cursor-pointer font-semibold">
              {up.stage} ({up.outputs.length} outputs)
            </summary>
            <table className="mt-2 w-full border-collapse border border-gray-300 text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="border border-gray-300 px-2 py-1 text-left">Port</th>
                  <th className="border border-gray-300 px-2 py-1 text-left">Value</th>
                  <th className="border border-gray-300 px-2 py-1 text-left">Written</th>
                </tr>
              </thead>
              <tbody>
                {up.outputs.map((o) => (
                  <PortRow
                    key={o.port}
                    port={o.port}
                    value={o.value}
                    writtenAt={o.writtenAt}
                  />
                ))}
              </tbody>
            </table>
          </details>
        ))
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {context.answerOptions.map((opt) => (
          <button
            key={opt}
            type="button"
            disabled={submitting !== null}
            onClick={() => void click(opt)}
            className="rounded bg-amber-700 px-3 py-1 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
          >
            {submitting === opt ? `${opt} …` : opt}
          </button>
        ))}
      </div>

      {errorMsg && (
        <p className="mt-2 text-sm text-red-700">answer failed: {errorMsg}</p>
      )}
    </section>
  );
}
```

- [ ] **Step 2: tsc green**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 0 output (component is exported but not yet consumed — tsc accepts unused exports).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/gate-card.tsx
git commit -m "feat(B5): GateCard React component"
```

---

## Task 7: Wire `GateCard` into the task page

**Files:**
- Modify: `apps/web/src/app/kernel-next/[taskId]/page.tsx`

- [ ] **Step 1: Add the import**

At the top of `apps/web/src/app/kernel-next/[taskId]/page.tsx`, below the existing imports (just after `import { useParams } from "next/navigation";`), add:

```ts
import { GateCard, type GateContextResponse } from "../../../components/gate-card";
```

- [ ] **Step 2: Add state + polling inside the component**

Locate the existing `eventCountRef` declaration (around line 101). Immediately after it, add:

```ts
  const [pendingGateIds, setPendingGateIds] = useState<string[]>([]);
  const [gateContexts, setGateContexts] = useState<Map<string, GateContextResponse>>(new Map());
```

- [ ] **Step 3: Add the /status poller effect**

Immediately after the existing SSE `useEffect` that handles the stream (which ends with its `return` cleanup around line 248), append a new `useEffect`:

```ts
  // B5: poll /status every 2s to discover pending gate IDs. Polling is
  // cheap at per-task granularity (one open page = one poller) and
  // avoids introducing a new SSE event type. The poll runs for the
  // lifetime of the page — aborted via the controller.
  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();

    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(
          `${API_BASE}/api/kernel/tasks/${encodeURIComponent(taskId)}/status`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          setPendingGateIds([]);
          return;
        }
        const body = await res.json() as {
          status: string;
          pending?: Array<{ gateId: string }>;
        };
        if (body.status === "gated" && Array.isArray(body.pending)) {
          setPendingGateIds(body.pending.map((g) => g.gateId));
        } else {
          setPendingGateIds([]);
        }
      } catch {
        // network error — leave last known state and retry next tick
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), 2000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [taskId]);
```

- [ ] **Step 4: Add the gate-context fetcher effect**

Immediately after the poller effect, append:

```ts
  // B5: for every pending gateId we don't already have a context for,
  // fetch it once. Evict contexts whose gateId left pendingGateIds to
  // prevent unbounded growth on long-running tasks with many gates.
  useEffect(() => {
    if (pendingGateIds.length === 0) {
      setGateContexts((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    const controller = new AbortController();

    // Evict stale entries.
    setGateContexts((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!pendingGateIds.includes(key)) { next.delete(key); changed = true; }
      }
      return changed ? next : prev;
    });

    // Fetch missing entries.
    for (const id of pendingGateIds) {
      if (gateContexts.has(id)) continue;
      void (async () => {
        try {
          const res = await fetch(
            `${API_BASE}/api/kernel/gates/${encodeURIComponent(id)}/context`,
            { signal: controller.signal },
          );
          if (!res.ok) return;
          const body = await res.json() as { ok: boolean } & GateContextResponse;
          if (!body.ok) return;
          setGateContexts((prev) => {
            if (prev.has(id)) return prev;
            const next = new Map(prev);
            next.set(id, body);
            return next;
          });
        } catch {
          // network error — next poll tick can retry
        }
      })();
    }
    return () => controller.abort();
  }, [pendingGateIds, gateContexts]);
```

- [ ] **Step 5: Add the answer handler**

Immediately after the two new effects, add:

```ts
  const answerGate = useCallback(async (gateId: string, answer: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const res = await fetch(
        `${API_BASE}/api/kernel/gates/${encodeURIComponent(gateId)}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer }),
        },
      );
      const body = await res.json() as {
        ok: boolean;
        diagnostics?: Array<{ message: string; code: string }>;
      };
      if (!res.ok || !body.ok) {
        return { ok: false, error: body.diagnostics?.[0]?.message ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, []);
```

- [ ] **Step 6: Render gate cards above the Stages section**

Locate the existing `<section className="mb-6">` whose `<h2>` is "Stages" (around line 305). Immediately before this section, insert:

```tsx
      {pendingGateIds.length > 0 && (
        <div className="mb-6">
          {pendingGateIds.map((gid) => {
            const ctx = gateContexts.get(gid);
            if (!ctx) {
              return (
                <section key={gid} className="mb-2 rounded border border-amber-400 bg-amber-50 p-3">
                  <p className="text-sm text-amber-900">
                    Gate <code>{gid}</code> pending — loading context…
                  </p>
                </section>
              );
            }
            return (
              <GateCard
                key={gid}
                context={ctx}
                onAnswer={(ans) => answerGate(gid, ans)}
              />
            );
          })}
        </div>
      )}
```

- [ ] **Step 7: tsc green**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 0 output.

- [ ] **Step 8: Build green**

Run: `cd apps/web && npx next build`
Expected: `Compiled successfully` (or Next's equivalent). No type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/app/kernel-next/[taskId]/page.tsx
git commit -m "feat(B5): render GateCard on kernel-next task page"
```

---

## Task 8: End-to-end sanity via Phase 6 replay

**Files:**
- No code changes. This task verifies the implementation against a real `pipeline-generator` run and updates `docs/phase6-usage-log.md`.

- [ ] **Step 1: Start a clean server**

```bash
cd /Users/minghao/workflow-control
rm -f /tmp/workflow-control-data/kernel-next.db /tmp/workflow-control-data/kernel-next.db-shm /tmp/workflow-control-data/kernel-next.db-wal
cd apps/server
pnpm dev > /tmp/b5-server.log 2>&1 &
sleep 15
```

Expected: `lsof -nP -iTCP:3001` shows a single `node` process.

- [ ] **Step 2: Launch a Pipeline Generator task**

```bash
cat > /tmp/b5-seed.json <<'EOF'
{
  "name": "Pipeline Generator",
  "seedValues": {
    "taskDescription": "Build a pipeline that fetches the top 10 trending GitHub repos for a language and writes a one-page digest."
  }
}
EOF
curl -s -X POST http://localhost:3001/api/kernel/tasks/run \
  -H "Content-Type: application/json" \
  -d @/tmp/b5-seed.json
```

Capture the returned `taskId`. Open `http://localhost:3000/kernel-next/<url-encoded-taskId>` in a browser (web app served by `pnpm --filter web dev` in a second terminal if not already running).

- [ ] **Step 3: Verify the gate card renders with analyzing upstream**

After the task reaches `gated` (poll will catch it within 2 s), the dashboard must show a `GateCard` whose `upstreams[0].stage === "analyzing"` with ≥ 10 output ports visible (`pipelineName`, `pipelineId`, `description`, `summary`, `stageDesign`, `dataFlowSummary`, `useCases`, `assumptions`, `stageContracts`, `recommendedMcps`, etc.).

If the card does not appear:
- Check the browser console for fetch errors.
- `curl http://localhost:3001/api/kernel/tasks/$(python3 -c "import urllib.parse; print(urllib.parse.quote('<taskId>'))")/status` must return `{"status":"gated", "pending":[...]}`.
- `curl http://localhost:3001/api/kernel/gates/<gateId>/context` must return a 200 payload with `upstreams[0].stage === "analyzing"`.
- If both curls succeed but the UI is empty, the React state wiring has a bug — re-read Task 7 Steps 3–6.

- [ ] **Step 4: Click `approve` and confirm card disappears**

The answer POST should return 200 and the card should disappear within one poll tick (2 s). The task should progress to subsequent stages (`genSkeleton`, `genPrompts`, `persisting`) visible in the existing Stages table.

- [ ] **Step 5: Update the Phase 6 usage log**

Append a new row to `docs/phase6-usage-log.md` reflecting this run: status `completed` via `GateCard` approve (no curl/sqlite), note that P6-7 is resolved.

```bash
git add docs/phase6-usage-log.md
git commit -m "docs(phase6): B5 validated end-to-end; P6-7 resolved"
```

- [ ] **Step 6: Stop the dev server**

```bash
ps aux | grep "tsx.*watch" | grep -v grep | awk '{print $2}' | xargs -r kill
```

---

## Self-Review

**Spec coverage:**
- Spec §"Server: Endpoint" — Tasks 1, 3, 5 (type, service method, HTTP route).
- Spec §"Client: Gate Card" component — Task 6.
- Spec §"Client: Page changes" — Task 7.
- Spec §"Error Handling" rows — covered piecewise: `/status` network → Task 7 Step 3 catch; `/context` 404 → Task 7 Step 4 (returns early, placeholder shows "loading context"); `/answer` diagnostics → Task 7 Step 5 `answerGate` handler + Task 6 `errorMsg`; value parse → Task 4 corrupted JSON test.
- Spec §"Testing" server side — Tasks 2 (happy path), 4 (unknown / already-answered / external-only / superseded / bad JSON = five cases vs spec's six; the sixth "HTTP envelope" is Task 5 REST happy), 5 (REST 200 + 404).
- Spec §"Out-of-Scope Follow-ups" — confirmed nothing in this plan extends into P6-5/P6-6/P6-10/render hints.

**Type consistency:**
- `GateContext` in Task 1 matches the response shape used in Tasks 3, 5.
- `GateContextResponse` in `gate-card.tsx` (Task 6) is **structurally identical** to server `GateContext` plus wrapper — intentional mirror.
- `getGateContext` signature: `(gateId: string) => GateContextResult` — consistent across Tasks 1, 3, 4, 5.
- `answerOptions` is `string[]` everywhere.
- `onAnswer` returns `{ ok: true } | { ok: false; error: string }` — used in Task 6 (`GateCard` Props) and Task 7 Step 5 (`answerGate` handler) identically.

**Placeholder scan:** no TBD / TODO / "add appropriate" — all code blocks are complete, all assertions concrete.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-23-b5-confirm-ui.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
