# PG API Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to walk this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `pipeline-generator` end-to-end against the real Claude Agent SDK for one tech-research-class taskDescription, validate the resulting IR + prompts, archive the full artefact in `docs/phase6-usage-log.md` as run #17. Zero code changes.

**Architecture:** Five sequential steps — launch server, POST run, approve gate, validate via existing `KernelService.validate`, dump to docs. All artefacts live in the existing `/tmp/workflow-control-data/kernel-next.db` after the run; extraction is direct SQL + `npx tsx -e`.

**Tech Stack:** Node 22, existing kernel-next server, Claude Agent SDK (already configured; preflight validated `claude` binary), SQLite via `sqlite3` CLI, curl.

**Spec:** `docs/superpowers/specs/2026-04-23-pg-api-validation-design.md`

---

## Preconditions (before Task 1)

- No uncommitted work (git status clean)
- Port 3001 free
- `/tmp/workflow-control-data/kernel-next.db*` either absent or disposable (will be wiped)
- `claude` binary resolvable (preflight validates this)

---

## Task 1: Clean launch server

**Files:** none (operational only)

- [ ] **Step 1: Kill any pre-existing server on port 3001**

```bash
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill
sleep 2
```

- [ ] **Step 2: Wipe DB so pipeline_versions starts empty except for seeded builtins**

```bash
rm -f /tmp/workflow-control-data/kernel-next.db*
```

- [ ] **Step 3: Launch server in background (non-watch)**

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server.log 2>&1 &
```

- [ ] **Step 4: Wait for server ready and verify port 3001 listening**

```bash
sleep 20
lsof -nP -iTCP:3001 | head -3
```

Expected: one LISTEN line on TCP 3001.

- [ ] **Step 5: Verify pipeline-generator is seeded**

```bash
curl -s http://localhost:3001/api/kernel/pipelines | python3 -c 'import json,sys;d=json.load(sys.stdin);names=[p["name"] for p in d["pipelines"]];print("Pipeline Generator" in names, names)'
```

Expected: `True [...]`

---

## Task 2: Start PG task with tech-research taskDescription

**Files:** none (HTTP call)

- [ ] **Step 1: Get current PG versionHash for run**

```bash
PG_HASH=$(curl -s http://localhost:3001/api/kernel/pipelines | python3 -c 'import json,sys;d=json.load(sys.stdin);print([p["latestVersion"] for p in d["pipelines"] if p["name"]=="Pipeline Generator"][0])')
echo "PG_HASH=$PG_HASH"
```

- [ ] **Step 2: POST run with fixed taskDescription**

The taskDescription text below is verbatim per spec §3.1. Do not rephrase on first attempt.

```bash
RUN_RESP=$(curl -s -X POST http://localhost:3001/api/kernel/tasks/run \
  -H "content-type: application/json" \
  -d '{
    "versionHash": "'"$PG_HASH"'",
    "seedValues": {
      "taskDescription": "Build a technical research pipeline that takes a topic name as input, collects authoritative sources (official docs, reputable engineering blogs, peer-reviewed papers if any), and synthesises a structured report with an executive summary, source list, and detailed findings. Output a single markdown report."
    },
    "maxTurns": 30,
    "maxBudgetUsd": 3.0
  }')
echo "$RUN_RESP" | python3 -m json.tool
TASK_ID=$(echo "$RUN_RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["taskId"])')
echo "TASK_ID=$TASK_ID"
```

Expected: HTTP 202 JSON response with `ok:true`, `taskId`, `versionHash`.

If response is 400 / 500: abort — that means preflight / seed is broken, not a PG issue. Investigate.

---

## Task 3: Poll for gate, approve

**Files:** none

- [ ] **Step 1: Poll status until gate shows up or task terminal**

```bash
for i in $(seq 1 40); do
  sleep 15
  ST=$(curl -s "http://localhost:3001/api/kernel/tasks/$TASK_ID/status" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("status","?"),";pending=",len(d.get("pending",[])))')
  echo "[poll $i] $ST"
  CASE=$(curl -s "http://localhost:3001/api/kernel/tasks/$TASK_ID/status" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("status","?"))')
  if [ "$CASE" = "gated" ] || [ "$CASE" = "completed" ] || [ "$CASE" = "failed" ] || [ "$CASE" = "orphaned" ]; then
    break
  fi
done
```

Expected: eventual `gated` with one pending gate.

- [ ] **Step 2: Fetch gate id + context**

```bash
GATE_ID=$(curl -s "http://localhost:3001/api/kernel/tasks/$TASK_ID/status" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["pending"][0]["gateId"])')
echo "GATE_ID=$GATE_ID"
curl -s "http://localhost:3001/api/kernel/gates/$GATE_ID/context" | python3 -m json.tool | head -40
```

Expected: context shows `stageName` of the awaiting gate and its upstream outputs.

- [ ] **Step 3: Approve**

```bash
curl -s -X POST "http://localhost:3001/api/kernel/gates/$GATE_ID/answer" \
  -H "content-type: application/json" \
  -d '{"answer":"approve"}' | python3 -m json.tool
```

Expected: `{"ok":true, …}`

---

## Task 4: Poll to terminal

**Files:** none

- [ ] **Step 1: Continue polling until completed or failed**

```bash
for i in $(seq 1 60); do
  sleep 15
  CASE=$(curl -s "http://localhost:3001/api/kernel/tasks/$TASK_ID/status" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("status","?"))')
  echo "[post-gate $i] $CASE"
  if [ "$CASE" = "completed" ] || [ "$CASE" = "failed" ] || [ "$CASE" = "orphaned" ]; then
    break
  fi
done
```

Expected: `completed`. If `failed` / `orphaned` see Task 5 partial path.

- [ ] **Step 2: Summarise stage outcomes + cost**

```bash
sqlite3 /tmp/workflow-control-data/kernel-next.db "SELECT stage_name, attempt_idx, status, kind FROM stage_attempts WHERE task_id='$TASK_ID' ORDER BY started_at;"
sqlite3 /tmp/workflow-control-data/kernel-next.db "SELECT SUM(cost_usd) FROM agent_execution_details WHERE attempt_id IN (SELECT attempt_id FROM stage_attempts WHERE task_id='$TASK_ID');"
```

Record: list of (stage, attempt, status) + total cost.

---

## Task 5: Extract new pipeline versionHash

**Files:** none

- [ ] **Step 1: Read the `versionHash` port emitted by the persisting stage**

```bash
NEW_HASH=$(sqlite3 /tmp/workflow-control-data/kernel-next.db "SELECT json_extract(value_json, '\$') FROM port_values WHERE attempt_id IN (SELECT attempt_id FROM stage_attempts WHERE task_id='$TASK_ID' AND stage_name='persisting' AND status='success') AND port_name='versionHash' ORDER BY written_at DESC LIMIT 1;" | tr -d '"')
echo "NEW_HASH=$NEW_HASH"
```

- [ ] **Step 2: Branch based on value**

If `NEW_HASH` is empty / null / "FAILED" / equals `$PG_HASH`: jump to Task 8 (record PARTIAL/FAIL). Otherwise continue to Task 6.

---

## Task 6: Validate new IR via existing validator

**Files:** one-shot inline script, not committed

- [ ] **Step 1: Run the structural + store_schema validator against the new IR**

```bash
cd /Users/minghao/workflow-control/apps/server
npx tsx -e "
import { DatabaseSync } from 'node:sqlite';
import { KernelService } from './src/kernel-next/mcp/kernel.js';

const db = new DatabaseSync('/tmp/workflow-control-data/kernel-next.db');
const hash = process.argv[1];
const row = db.prepare('SELECT ir_json FROM pipeline_versions WHERE version_hash = ?').get(hash);
if (!row) { console.error('NOT_FOUND'); process.exit(1); }
const ir = JSON.parse(row.ir_json);
const svc = new KernelService(db, { skipTypeCheck: true });
const v = svc.validate(ir);
console.log(JSON.stringify(v, null, 2));
" "$NEW_HASH"
```

Expected: `{"ok":true}` or `{"ok":false,"diagnostics":[…]}`.

- [ ] **Step 2: Check prompt coverage**

```bash
npx tsx -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/tmp/workflow-control-data/kernel-next.db');
const hash = process.argv[1];
const row = db.prepare('SELECT ir_json FROM pipeline_versions WHERE version_hash = ?').get(hash);
const ir = JSON.parse(row.ir_json);
const refs = db.prepare('SELECT prompt_ref FROM pipeline_prompt_refs WHERE version_hash = ?').all(hash).map(r => r.prompt_ref);
const missing = [];
const extra = new Set(refs);
for (const s of ir.stages) {
  if (s.type !== 'agent') continue;
  const ref = s.config.promptRef;
  if (!refs.includes(ref)) missing.push({stage: s.name, ref});
  extra.delete(ref);
}
console.log('missing:', JSON.stringify(missing));
console.log('extraneous:', JSON.stringify([...extra]));
" "$NEW_HASH"
```

Expected: `missing: []` and ideally `extraneous: []` (may have whitelisted `system/*` or `global-constraints` keys).

- [ ] **Step 3: Dump full IR JSON for archiving**

```bash
sqlite3 /tmp/workflow-control-data/kernel-next.db "SELECT ir_json FROM pipeline_versions WHERE version_hash='$NEW_HASH';" | python3 -m json.tool > /tmp/run17-ir.json
cat /tmp/run17-ir.json | head -5
```

- [ ] **Step 4: Dump all prompt contents**

```bash
sqlite3 -header /tmp/workflow-control-data/kernel-next.db "SELECT ppr.prompt_ref, pc.content FROM pipeline_prompt_refs ppr JOIN prompt_contents pc ON pc.content_hash = ppr.content_hash WHERE ppr.version_hash = '$NEW_HASH';" > /tmp/run17-prompts.txt
wc -l /tmp/run17-prompts.txt
```

---

## Task 7: Optional executability smoke

**Files:** none. Only proceed if Task 6 was fully green.

- [ ] **Step 1: Inspect externalInputs to decide a sensible seed**

```bash
python3 -c "
import json
ir = json.load(open('/tmp/run17-ir.json'))
print('externalInputs:', ir.get('externalInputs', []))
print('stages:', [s['name'] for s in ir['stages']])
"
```

- [ ] **Step 2: Construct seedValues and fire run**

Build a `seedValues` JSON matching externalInputs (e.g. `{"topic": "WebAssembly"}`). If the IR declares different input names, use those names and values that fit their types.

```bash
SMOKE_RESP=$(curl -s -X POST http://localhost:3001/api/kernel/tasks/run \
  -H "content-type: application/json" \
  -d '{
    "versionHash": "'"$NEW_HASH"'",
    "seedValues": { "topic": "WebAssembly" },
    "maxTurns": 5,
    "maxBudgetUsd": 0.5
  }')
echo "$SMOKE_RESP" | python3 -m json.tool
SMOKE_TASK=$(echo "$SMOKE_RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("taskId",""))')
```

If externalInputs disagree with `topic`, adjust the seed dict per externalInputs declaration. If the task doesn't launch, skip to Task 8 and record the reason under "smoke run".

- [ ] **Step 3: Poll smoke task briefly (max 3 min)**

```bash
for i in $(seq 1 12); do
  sleep 15
  SST=$(curl -s "http://localhost:3001/api/kernel/tasks/$SMOKE_TASK/status" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("status","?"))')
  echo "[smoke $i] $SST"
  if [ "$SST" = "completed" ] || [ "$SST" = "failed" ] || [ "$SST" = "gated" ] || [ "$SST" = "orphaned" ]; then
    break
  fi
done
sqlite3 /tmp/workflow-control-data/kernel-next.db "SELECT stage_name, status FROM stage_attempts WHERE task_id='$SMOKE_TASK';"
```

Acceptance: at least one stage reached `success`. `gated` mid-run is fine (gate stages are not a failure). `failed` on stage 1 is a partial pass (IR was well-formed enough to start, just prompt/content was off).

---

## Task 8: Archive to phase6-usage-log

**Files:**
- Modify: `docs/phase6-usage-log.md`

- [ ] **Step 1: Append new row to the ledger table**

Open `docs/phase6-usage-log.md`. Find the table under `## 运行台账`. Append after run #16:

```
| 17 | 2026-04-23 | **PG 真实 API 验证（tech-research 场景）** | Pipeline Generator → <generated pipeline name> | <TASK_ID> | <PG outcome: completed/failed/PARTIAL> | <PG duration>, $<PG cost> | — | PG 自产 IR；validator.ok=<bool>；missing prompts=<count>；smoke run: <outcome / skipped>. Generated versionHash=<NEW_HASH>. 详见本日志下新章节 "PG API validation run #17" |
```

Fill `<...>` placeholders with real values captured above. Use `—` for bug column (no new bug found unless observed).

- [ ] **Step 2: Update 成熟度快照 if applicable**

If the PG run completed successfully and smoke run also passed, increment M3 (分子 & 分母).

```
- **M3 分子/分母**: 10 / 17  (if smoke = success)  OR  9 / 17  (if PG completed but smoke skipped/failed on content)
```

(Do NOT touch M4 — this is not a propose. It's a PG dogfood, so it's an M1 / M3 data point only.)

- [ ] **Step 3: Add new section at file bottom**

After the last existing section, add:

```markdown
## PG API validation run #17 (2026-04-23)

### Input

**taskDescription**:

> Build a technical research pipeline that takes a topic name as input, collects authoritative sources (official docs, reputable engineering blogs, peer-reviewed papers if any), and synthesises a structured report with an executive summary, source list, and detailed findings. Output a single markdown report.

### Outcome

- PG status: <completed/failed/PARTIAL>
- Stage attempts: <table from sqlite3>
- Cost: $<PG cost>
- Duration: <wall clock>
- Generated versionHash: `<NEW_HASH>`
- Generated pipeline name: <ir.name>
- Validator: `{"ok":true}` / `{"ok":false,"diagnostics":[...]}`
- Prompt coverage: missing=<list>, extraneous=<list>

### Smoke run

<if run:>
- Task id: <SMOKE_TASK>
- First stage outcome: <success/failed/gated>
- sqlite result: <...>

<if skipped:>
- Skipped because: <reason>

### Generated IR (verbatim, canonical JSON)

\`\`\`json
<contents of /tmp/run17-ir.json>
\`\`\`

### Generated prompts (verbatim)

#### `<promptRef 1>`

\`\`\`markdown
<content>
\`\`\`

#### `<promptRef 2>`

...

(One ```markdown ... ``` fence per promptRef. Use full content, not excerpts.)

### Lessons

- What PG did well: <observations>
- What surprised me: <observations>
- Whether re-phrasing was needed: <yes/no>; if yes, what I changed
- Whether I'd ship this pipeline as a builtin: <my judgement>
```

Fill in all `<…>` with real captured data. Do NOT paraphrase; paste.

- [ ] **Step 4: Kill background server**

```bash
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill
```

- [ ] **Step 5: Verify no code changes**

```bash
cd /Users/minghao/workflow-control
git status
```

Expected: only `docs/phase6-usage-log.md` modified. If anything else shows up — investigate before committing.

- [ ] **Step 6: Commit**

```bash
git add docs/phase6-usage-log.md
git commit -m "$(cat <<'EOF'
docs(phase6): run #17 — pipeline-generator real-API validation against tech-research scenario

Ran the pipeline-generator builtin against the live Claude Agent SDK
with a verbatim tech-research-class taskDescription. Archived the
full generated IR + every prompt contents block + validator outcome
+ optional smoke-run outcome.

Artefact lives in pipeline_versions / pipeline_prompt_refs — no
promotion to a 6th builtin, no filesystem artefact. The run #17
section contains the complete canonical output for future replay.

Outcome: <completed|failed|PARTIAL>.
Validator: <ok|diagnostics>.
Smoke: <ran|skipped>, <success|failed|gated>.

Self-review:
- Functional: <validator outcome honestly reported>
- Consistency: docs-only change
- Regression: zero code touched
- YAGNI: no reusable tooling
- TDD: N/A — validation via existing KernelService.validate

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Fill `<…>` placeholders with the run's actual outcomes before committing.

---

## Self-review of this plan

**Spec coverage check**:

- §2 Architecture sequence → Tasks 1–8 map 1:1 to the flow box
- §3.1 Subject input → Task 2 step 2 verbatim
- §3.2 Gate answer → Task 3 step 3
- §3.3 Validation (validate + prompt coverage) → Task 6 steps 1–2
- §3.4 Optional smoke → Task 7 (marked optional)
- §3.5 Dump → Task 8 step 3 (full IR + full prompts, verbatim)
- §4 Error handling → covered per-task (Task 2 step 2 note, Task 5 step 2 branch, Task 7 step 2 adjust clause, Task 8 step 2 conditional)
- §5 Self-review checklist → commit body encodes those 5 criteria
- §6 Commit plan → Task 8 step 6
- §7 Out of scope → explicitly not included as tasks

**Placeholder scan**:

- `<TASK_ID>`, `<NEW_HASH>`, `<PG outcome>` etc. are **runtime value placeholders** in shell variables and doc templates — those are expected ("fill in during execution"). They are not design-level TBDs.
- No "TODO", "add error handling later", or "similar to task N" wording.

**Type / name consistency**:

- `$PG_HASH`, `$TASK_ID`, `$GATE_ID`, `$NEW_HASH`, `$SMOKE_TASK` used consistently
- `/tmp/workflow-control-data/kernel-next.db` canonical DB path referenced uniformly
- Spec's "taskDescription" = plan's taskDescription text

Plan consistent.
