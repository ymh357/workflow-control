# PG API Validation Design — run #17 tech-research experiment

> **Date**: 2026-04-23
> **Scope**: One-shot experiment. Run the `pipeline-generator` builtin end-to-end against the real Claude Agent SDK, feed it a `tech-research`-class task description, let it emit a new pipeline into `pipeline_versions`, validate the artefact, and archive the result in `docs/phase6-usage-log.md`.
>
> **Explicit non-goals**:
> - Do NOT register the generated pipeline as a 6th builtin.
> - Do NOT delete / replace existing `tech-research-collector` + `tech-research-writer`.
> - Do NOT add new test suites. Validation uses existing validators only.
> - Do NOT write a reusable dump CLI / helper. This is a one-shot.

---

## 1. Problem

Roadmap §6.3 called for `pipeline-generator` to rewrite the builtin pipelines with proper `store_schema` as the A3 milestone's canonical reference. The "mechanical mirror" migration (Phase 4.5 T5) already produced valid store_schema for all 4 builtins, but none of the current builtins were emitted by a real PG run — the artefacts are hand-ported or mechanically derived.

The remaining uncertainty is narrow: **does the current `pipeline-generator` builtin, against the production Claude Agent SDK, produce an IR that is (a) structurally valid, (b) schema-consistent, and (c) executable on a fresh taskId?** Run #11 (2026-04-23) showed PG producing a valid simple linear pipeline (`markdown-table-of-contents-generator`). This experiment stresses PG on a harder scenario — a two-stage research pipeline with sources → synthesis — to widen that data point.

## 2. Architecture

Zero code changes. The experiment is a sequence of HTTP + SQL operations against a freshly-launched server:

```
[local] launch server (non-watch)
   │
   │ POST /api/kernel/tasks/run
   │   { pipeline: "pipeline-generator", seedValues: { taskDescription: <string> } }
   ▼
[server] PG task starts
   │ analyzing → (gate: Approve design?)
   │
   │ POST /api/kernel/gates/:id/answer  {answer: "approve"}
   ▼
[server] PG task resumes
   │ genSkeleton → genPrompts → persisting
   │   └─ submit_pipeline MCP call → pipeline_versions + pipeline_prompt_refs insert
   ▼
[DB] new pipeline_version <hash> + its prompts land
   │
   │ sqlite3 SELECT … → fetch new IR + prompts
   │
   │ validate via KernelService.validate(ir) + validateStoreSchema(ir)
   ▼
[docs] archive to phase6-usage-log.md run #17
```

## 3. Components

### 3.1 Subject pipeline input

- `taskDescription` (single externalInput to PG): a natural-language request for a "tech research" class pipeline. One shot, fixed text. Sample text chosen to exercise multi-source + synthesis:

  > "Build a technical research pipeline that takes a topic name as input, collects authoritative sources (official docs, reputable engineering blogs, peer-reviewed papers if any), and synthesises a structured report with an executive summary, source list, and detailed findings. Output a single markdown report."

  The exact wording is tuning, not contract. If PG rejects / produces nothing useful, I re-phrase once then report results.

### 3.2 Gate answer

PG's first gate is `Approve this pipeline design?`. I answer `approve`. If the gate proposes alternate routing values (`reject`, `_default`), I still answer `approve` — the point is to get to persisting.

### 3.3 Validation

After persist success, read new `versionHash` from the `versionHash` output port of the `persisting` stage's latest successful attempt. Then:

```ts
// pseudocode, run inline from a one-off script or sqlite3 read + inline JS
const irJson = sqlite3.get("SELECT ir_json FROM pipeline_versions WHERE version_hash = ?", [hash]);
const ir: PipelineIR = JSON.parse(irJson);

// Existing services — no new code
const svc = new KernelService(db, { skipTypeCheck: true });
const v = svc.validate(ir); // runs structural + dag + store_schema
expect(v.ok).toBe(true);

// Prompt coverage
const refs = sqlite3.all("SELECT prompt_ref, content_hash FROM pipeline_prompt_refs WHERE version_hash = ?", [hash]);
for (const s of ir.stages) {
  if (s.type !== "agent") continue;
  expect(refs.find(r => r.prompt_ref === s.config.promptRef)).toBeDefined();
}
```

"Inline JS" here = short `npx tsx -e '…'` style or a discarded `scripts/one-shot.ts` I delete after use. No file checked into `apps/server/src/**`.

### 3.4 Optional executability smoke

If time permits within the run session: kick off a task on the new versionHash with a concrete seed value (e.g., `topic: "WebAssembly"`). Acceptance = at least the first stage enters `executing` and produces a non-empty output port. This is a *canary*, not correctness.

### 3.5 Dump artefact

Update `docs/phase6-usage-log.md`:
- Append run #17 row to the main ledger.
- New section "PG API validation run #17" containing:
  - taskDescription text (verbatim)
  - Final IR canonical JSON (pretty-printed) — the entire generated IR
  - Every `promptRef` → content (full content blocks, code-fence each)
  - Validator outcome
  - Smoke-run outcome (if attempted)
  - Cost: total cost of the PG run (from `result_usd` in agent_execution_details)
  - Lessons (what PG did well, what surprised me, whether re-phrasing was needed)

Size budget: no arbitrary limit on the dump. If the prompts are large, they go in verbatim. Future readers (including myself) want the raw artefact.

## 4. Error handling

| Case | Response |
|---|---|
| Server won't start / preflight fails | Fix env issue inline (claude path, DATA_DIR); if not fixable in ≤5 min, abort with partial log |
| PG stage hits max turns / error | Record diagnostics, dump any partial IR from genSkeleton's output port, mark run #17 as "PARTIAL" |
| submit_pipeline returns non-ok | PG persist.md handles it (retry 1x, then writes FAILED port). I capture that output as "PG failed to produce valid IR" and stop |
| Gate times out (shouldn't — I watch for it) | Record the timeout, re-run PG once |
| Validator fails on new IR | Record precise diagnostic, still dump the IR, stop |
| Concurrent DB lock / sqlite oddity | Retry SELECT |

Any terminal state (PASS / PARTIAL / FAIL) gets a full dump in phase6-usage-log. Failure is also data.

## 5. Self-review checklist (pre-commit)

1. **PASS predicate met?** IR exists in DB + validate.ok + all prompts resolved + doc updated
2. **Doc complete?** Run #17 ledger row + full section + cost + lessons
3. **No code added?** git status shows only `docs/phase6-usage-log.md` modified
4. **Server teardown?** Background server process killed; DB still intact (so I can re-read later if needed)
5. **M1 / M3 / M4 ledger updated?** This is a PG dogfood, so M1 data point; not a propose → M4 untouched

## 6. Commit plan

One commit:
```
docs(phase6): run #17 — pipeline-generator real-API validation against tech-research scenario

<summary of what PG produced>

Self-review:
- Functional: IR produced, validator green
- Consistency: docs-only, no code change
- Regression: none — no code touched
- YAGNI: one-shot experiment, no reusable tooling
- TDD: N/A — validation via existing validators, not new tests
```

## 7. Out of scope (explicit)

- Building a "dump-pipeline CLI" tool
- Adding the generated pipeline to `seedBuiltinPipelineByName`
- Deleting existing tech-research-* builtins
- Running PG multiple times to measure success rate (single data point is the target)
- Measuring prompt-quality (that's human judgement; we only measure structural correctness)

---

## Self-review of this spec

- **Placeholders**: none
- **Internal consistency**: architecture §2 = components §3 = error map §4; validation bar explicit
- **Scope**: one session, one run, docs-only change — appropriately small
- **Ambiguity**: "tech-research" fixed by verbatim taskDescription in §3.1; validation bar explicit (validate.ok + prompt coverage); smoke run is explicitly optional
