# Workflow Control — Whitepaper Visuals

> Version 2.0 · 2026-05-03 · companion to [`whitepaper.md`](./whitepaper.md)
>
> Supersedes `architecture-visual.md` (archived 2026-04-24).
>
> **Chinese version**: [`whitepaper-visuals-zh.md`](./whitepaper-visuals-zh.md).

This file is the **visual companion** to the v2.0 whitepaper. Every
diagram below renders in GitHub-flavoured Markdown via Mermaid. Pair
each diagram with the cited whitepaper Part for the prose.

---

## §1. System topology

> Whitepaper Part 3.1.

```mermaid
flowchart TB
  subgraph SURFACES["Surfaces (single-user, no auth)"]
    WEB["Web (Next.js)<br/>:3000"]
    MCP_CLIENT["MCP clients<br/>(other Claude Code,<br/>Cursor, Codex)"]
    CLI["CLI<br/>(registry, prune)"]
  end

  subgraph HONO["Hono server (:3001)"]
    direction LR
    REST["/api/kernel/* REST"]
    SSE["/api/kernel-next/<br/>tasks/:id/stream SSE"]
    MCP_HTTP["/api/mcp<br/>JSON-RPC 2.0"]
    REGAPI["/api/registry/*"]
  end

  subgraph CORE["Service layer"]
    KSVC["KernelService"]
    REGSVC["RegistryService"]
  end

  subgraph STATE["Persistent state"]
    DB[("kernel-next.db<br/>(SQLite WAL)")]
    LOCK[/".wfctl-registry.lock"/]
  end

  subgraph RUNTIME["Runtime"]
    RUNNER["Runner<br/>(per-task)"]
    MACHINE["XState v5 root machine<br/>(parallel regions per stage)"]
    EXEC["StageExecutor<br/>(real / script / fanout)"]
    SDK["Claude SDK<br/>subprocess"]
  end

  WEB -->|HTTP| REST
  WEB -->|EventSource| SSE
  MCP_CLIENT -->|JSON-RPC over HTTP| MCP_HTTP
  CLI -->|in-process| REGSVC
  WEB -->|HTTP| REGAPI

  REST --> KSVC
  SSE --> KSVC
  MCP_HTTP --> KSVC
  REGAPI --> REGSVC

  KSVC <--> DB
  KSVC -->|spawn| RUNNER
  RUNNER --> MACHINE
  MACHINE --> EXEC
  EXEC --> SDK
  EXEC --> DB

  REGSVC <--> LOCK
  REGSVC -->|HTTP| GH["GitHub<br/>workflow-control-registry"]
```

---

## §2. Pipeline IR — what gets registered

> Whitepaper Part 3.2.

```mermaid
flowchart LR
  EXT["externalInputs<br/>{name, type}"]
  STAGE["stages[]"]
  WIRES["wires[]"]
  STORE["store_schema<br/>(optional)"]

  STAGE --> AGENT["agent stage<br/>config.promptRef<br/>config.mcpServers"]
  STAGE --> SCRIPT["script stage<br/>config.source = registry|inline<br/>config.retry"]
  STAGE --> GATE["gate stage<br/>config.question<br/>config.routing.routes"]

  AGENT --> FANOUT["+ fanout<br/>spec (optional)"]
  SCRIPT --> FANOUT

  WIRES --> WSRC["from.source ∈ {external, stage}"]
  WIRES --> WDST["to.{stage, port}"]

  GATE --> GROUTE["routes:<br/>{ approve: targetA,<br/>  reject: [B, C] }"]

  EXT -.canonicalize+hash.-> VH[(version_hash)]
  STAGE -.canonicalize+hash.-> VH
  WIRES -.canonicalize+hash.-> VH
  STORE -.canonicalize+hash.-> VH
  PROMPTS["pipeline_prompt_refs<br/>+ prompt_contents"] -.fold prompts.-> VH

  VH --> ROW[("pipeline_versions row")]
```

Key: `version_hash = pipelineVersionHash({ ir, prompts })`.
Whitepaper §3.2 detail; code in `ir/canonical.ts`.

---

## §3. Stage region state machine (per stage, parallel)

> Whitepaper Part 3.3.

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> waiting: machine root entry

  waiting --> executing: all inbound wires deliver<br/>AND (gate-routed → authorized)
  waiting --> error: STAGE_FAILED (this stage)
  waiting --> error: noDeliverableWire<br/>(authorisation arrived but<br/>some wire is dropped)

  executing --> done: all outputs present<br/>(PORT_WRITTEN or always)
  executing --> done: GATE_ANSWERED (gate stages only)
  executing --> error: STAGE_FAILED
  executing --> waiting: STAGE_FAILED + retry budget remaining<br/>(scripts only)

  done --> [*]
  error --> [*]

  note right of executing
    agent / script: invoke executor child
    INTERRUPT forwards via sendTo()

    gate: idle by design
    no INTERRUPT handler — runner-level
    bug 80 fix skips INTERRUPT for gates
  end note

  note right of waiting
    fanout stage: runner intercepts
    before invoke, calls
    orchestrateFanoutStage detached
  end note
```

The runner watches inspector snapshots for `error` finals to build a
verdict (natural / retry / rollback). Code: `compiler/ir-to-machine.ts`
+ `runtime/runner.ts`.

---

## §4. Task lifecycle (top-level)

> Whitepaper Part 1.1 + 3.4.

```mermaid
stateDiagram-v2
  [*] --> running: startPipelineRun
  running --> running: stage success<br/>→ next stage activates

  running --> gated: gate.executing
  gated --> running: answer_gate (approve)
  gated --> running: answer_gate (reject)<br/>→ rollback rebuild

  running --> secret_pending: MCP_ENV_MISSING<br/>raised by stage
  secret_pending --> running: provide_task_secrets

  running --> completed: all sink stages done<br/>(natural)
  running --> failed: STAGE_FAILED<br/>+ retry exhausted
  running --> cancelled: cancelTask<br/>OR INTERRUPT timeout

  completed --> [*]
  failed --> [*]
  cancelled --> [*]

  note right of secret_pending
    Lineage: idx=N attempt remains
    at status='secret_pending';
    new idx=N+1 opens after secrets
    are provided.
  end note

  note left of gated
    Idle by design.
    Bug 80 fix: migration skips
    INTERRUPT when only gates run.
  end note
```

---

## §5. Reject-rollback — multi-target

> Whitepaper Part 2.3 + dogfood-8/11.

```mermaid
sequenceDiagram
  participant U as User
  participant API as REST /gates/:id/answer
  participant K as KernelService
  participant R as Runner
  participant DB as SQLite

  U->>API: POST { answer: "reject", comment }
  API->>K: answerGate(gateId, "reject", comment)
  K->>DB: UPDATE gate_queue SET answer, answered_at
  K->>DB: INSERT __gate_feedback__ port value
  K->>K: detect rejectRollbackMap[gate]<br/>→ targetStages (string OR array)
  K->>R: dispatcher.send({type: "GATE_REJECTED",<br/>targetStage, affectedStages})
  Note over R: rejectHandler → resolveAttempt({verdict: "rollback"})

  R->>R: prune persistentPortValues<br/>for every affectedStage
  R->>R: re-seed __gate_feedback__ = ""<br/>for affected gates (NOT fromGate)<br/>(Bug 16 fix)
  R->>R: rebuild actor with isRetryRebuild=true
  R-->>DB: NEW stage_attempt rows<br/>(idx=2, status=running)
  Note over DB: idx=1 success rows preserved<br/>(lineage, NOT superseded)

  R->>R: stages re-run with new attempts
  R->>DB: INSERT new port_values
  R->>R: gate re-opens with new gate_id
  Note over U: User sees fresh gate to answer
```

---

## §6. Hot-update migration

> Whitepaper Part 3.5 + dogfood-10/12/13.

```mermaid
sequenceDiagram
  participant U as User
  participant API as REST /tasks/:id/migrate
  participant K as KernelService
  participant ORCH as migration-orchestrator
  participant R as Live Runner
  participant START as startPipelineRun
  participant DB as SQLite

  U->>API: POST { proposalId }
  API->>K: migrateTask(taskId, proposalId)
  K->>ORCH: executeMigration(...)

  ORCH->>ORCH: acquire per-task lock
  ORCH->>DB: load proposal + check status='approved'

  ORCH->>DB: query running stage_attempts
  alt every running attempt is a gate
    Note over ORCH: Bug 80 path:<br/>skip INTERRUPT round-trip
  else any non-gate attempt is running
    ORCH->>R: dispatcher.send(INTERRUPT)
    Note over R: dispatcher aborts<br/>fanoutInterruptController<br/>(Bug 81 fix)<br/>then forwards to actor
    R->>R: stage region INTERRUPT handler<br/>→ aborts AbortSignal<br/>→ executor cleanup
    R->>R: graceful summary turn<br/>(B10)
    R->>DB: writeTaskFinals(reason='interrupted')
    R->>ORCH: awaitTermination resolves
  end

  ORCH->>DB: snapshot pre-supersede status
  ORCH->>DB: BEGIN TX
  ORCH->>DB: UPDATE stage_attempts SET status='superseded'<br/>for supersedeSet (preserves fanout_element success)
  ORCH->>DB: close stale gate_queue rows
  ORCH->>DB: INSERT hot_update_events (status='success')
  ORCH->>DB: COMMIT

  alt has rerunFrom
    ORCH->>ORCH: tryResetWorktreeToBeforeSha (B9)
    ORCH->>START: startRunner({resumeFrom: rerunFrom})
    alt startRunner fails
      Note over ORCH: REVERSE-SUPERSEDE
      ORCH->>DB: BEGIN TX
      ORCH->>DB: restore status from snapshot
      ORCH->>DB: COMMIT
      ORCH->>DB: writeAuditFailed(reason='RESUME_FAILED')
      ORCH-->>K: { ok: false, code: MIGRATION_RESUME_FAILED }
    else startRunner ok
      Note over R: NEW Runner picks up<br/>at rerunFrom on toVersion<br/>fanout_element idx=0..N (B17)<br/>preserved as lineage
    end
  else no rerunFrom (forward-only)
    Note over ORCH: prompts-only proposal<br/>does not trigger rerun.<br/>new tasks use toVersion
  end

  K-->>API: { ok: true, eventId, supersededStages }
  API-->>U: 200 OK
```

---

## §7. Resumability after restart

> Whitepaper Part 3.6.

```mermaid
sequenceDiagram
  participant SIG as SIGTERM
  participant SHUT as graceful-shutdown
  participant DB as SQLite
  participant BOOT as bootResumability
  participant ORPH as orphan-reconciler
  participant R as new Runner

  SIG->>SHUT: kill -TERM
  SHUT->>SHUT: taskRegistry.interruptAll(deadline)
  Note over SHUT: every live runner gets INTERRUPT<br/>+ awaits termination
  SHUT->>DB: BEGIN TX
  SHUT->>DB: stage_attempts status='running' → 'superseded'
  SHUT->>DB: gate_queue answered_at = now (synthetic)
  SHUT->>DB: task_finals INSERT OR IGNORE<br/>(reason='interrupted') for each task
  SHUT->>DB: COMMIT

  Note over SIG,R: ───── server stopped ─────

  Note over BOOT,R: ───── server boot ─────
  BOOT->>DB: query tasks NOT in task_finals
  loop each unfinalised task
    BOOT->>ORPH: classifyOrphan(taskId)
    ORPH->>DB: read stage_attempts state
    alt fully terminated
      ORPH->>DB: write task_finals(failed/orphaned)
    else mid-flight, recoverable
      ORPH->>BOOT: { resumeFrom: <stage> }
      BOOT->>R: startPipelineRun({ resumeFrom })
      Note over R: rebuilt machine sees<br/>portValues = persisted<br/>finalizedStages = derived<br/>fanout: succeeded elements preserved
    end
  end
```

---

## §8. Fanout execution

> Whitepaper Part 3.3 (note) + dogfood-12.

```mermaid
flowchart TB
  START["orchestrateFanoutStage(args)"]
  START --> SOURCE["read source array<br/>(splitter output)"]
  SOURCE --> PRESERVED["query preservedByIdx<br/>(B17: fanout_element WHERE status='success')"]
  PRESERVED --> POOL["spawn worker pool<br/>(concurrency cap, default 3)"]

  POOL --> WORKER1["worker 1"]
  POOL --> WORKER2["worker 2"]
  POOL --> WORKERN["worker N"]

  WORKER1 --> ELEM["pull next idx (atomic cursor)"]
  ELEM --> CHECK_INT{interruptSignal<br/>aborted?}
  CHECK_INT -->|yes| BAIL["set firstError<br/>(Bug 81 entry check)"]
  CHECK_INT -->|no| CHECK_PRESERVED{idx in<br/>preservedByIdx?}
  CHECK_PRESERVED -->|yes| AGGREGATE["copy preserved outputs<br/>into aggregate"]
  CHECK_PRESERVED -->|no| RUN["execute element<br/>via executor.executeStage<br/>(per-element AbortController<br/>+ parent INTERRUPT signal listener)"]
  RUN --> RESULT{result.status}
  RESULT -->|success| AGGREGATE
  RESULT -->|error + retry left| RUN
  RESULT -->|error final| FIRSTERR["set firstError"]
  RESULT -->|secret_pending| PAUSE["secretPendingObserved = true"]
  RESULT -->|timeout| RUN
  AGGREGATE --> ELEM

  POOL --> JOIN["wait for all workers"]
  JOIN --> EMIT{state}
  EMIT -->|firstError set| EMIT_ERR["return error"]
  EMIT -->|secretPendingObserved| EMIT_PAUSE["return secret_pending"]
  EMIT -->|all ok| EMIT_OK["write aggregate row<br/>+ aggregated arrays<br/>via livePortRuntime"]
```

---

## §9. The web UI surface

> Whitepaper Part 4.1.

```mermaid
flowchart LR
  ROOT["/<br/>Launch hub"] --> TASKS
  TASKS["/kernel-next<br/>Task list"] --> TASK
  TASK["/kernel-next/[taskId]<br/>Live task detail"] --> ATTEMPT
  TASK --> AUDIT
  TASK --> MOD["Modify pipeline →<br/>launches pipeline-modifier"]
  TASK --> CXL["Cancel"]
  TASK --> RBK["Rollback (per-event)"]

  ATTEMPT["/kernel-next/<br/>attempts/[id]<br/>Per-attempt drill-down"]
  AUDIT["Hot-update timeline<br/>(inline component)"]

  ROOT --> PIPES["/kernel-next/pipelines"]
  PIPES --> PIPE["/kernel-next/<br/>pipelines/[name]<br/>IR + version history"]

  ROOT --> PROPS["/kernel-next/proposals"]
  PROPS --> MIGRATE["Migrate dialog →<br/>POST /tasks/:id/migrate"]

  ROOT --> CAT["/kernel-next/mcp-catalog"]
  CAT --> SECRET["Add MCP entry +<br/>encrypted secret"]

  ROOT --> REG["/registry<br/>(this session)"]
  REG --> INSTALL["Install / Uninstall /<br/>Update / Outdated badge"]
```

---

## §10. Bug-fix highlights — the wire diagrams

Three bugs surfaced during dogfood that defined the current
INTERRUPT story across stage types.

### §10.1 Bug 16 — gate-feedback re-seed

> dogfood-5/6.

```mermaid
flowchart LR
  REJ["GATE_REJECTED arrives"] --> PRUNE["prune persistentPortValues<br/>for affectedStages"]
  PRUNE --> WHY["BUT: compiler seeds every gate's<br/>__gate_feedback__ = '' on first compile"]
  WHY --> BAD["pruning drops them"]
  BAD --> BUG["downstream gate-routed stages<br/>see undefined feedback port<br/>→ wireDelivers fails<br/>→ actor wedges in waiting"]
  BUG --> FIX["FIX: re-seed __gate_feedback__ = ''<br/>for every affected gate<br/>(skip fromGate which keeps comment)"]
```

### §10.2 Bug 80 — gated task INTERRUPT timeout

> dogfood-10.

```mermaid
flowchart LR
  MIG["migrate gated task"] --> SEND["dispatcher.send INTERRUPT"]
  SEND --> GATE["gate.executing has NO<br/>INTERRUPT handler"]
  GATE --> SILENT["XState v5 noop"]
  SILENT --> WAIT["awaitTermination 30s"]
  WAIT --> FAIL["MIGRATION_INTERRUPT_TIMEOUT"]
  FAIL --> FIX2["FIX: orchestrator queries<br/>running stage_attempts;<br/>if every running attempt<br/>is a gate stage → skip INTERRUPT"]
```

### §10.3 Bug 81 — fanout doesn't observe INTERRUPT

> dogfood-13.

```mermaid
flowchart LR
  MIG2["migrate fanout-mid task"] --> SEND2["dispatcher.send INTERRUPT"]
  SEND2 --> ACTOR["forward to actor"]
  ACTOR --> ACTORSTOP["actor.stop() after 1500ms"]
  ACTORSTOP --> DETACHED["BUT: fanout promises<br/>are detached from actor"]
  DETACHED --> KEEPGOING["queued elements keep<br/>running for full 30s"]
  KEEPGOING --> FAIL2["MIGRATION_INTERRUPT_TIMEOUT"]
  FAIL2 --> FIX3["FIX: runner-level<br/>fanoutInterruptController<br/>aborted FIRST in dispatcher.send;<br/>orchestrateFanoutStage entry-checks<br/>+ per-element controller listens to parent"]
```

---

## §11. Database — primary tables and their join paths

> Whitepaper Part 4.3.

```mermaid
erDiagram
  pipeline_versions ||--o{ stage_attempts : "version_hash"
  pipeline_versions ||--o{ pipeline_prompt_refs : "version_hash"
  pipeline_prompt_refs ||--|| prompt_contents : "content_hash"

  stage_attempts ||--o{ port_values : "attempt_id"
  stage_attempts ||--o| gate_queue : "attempt_id"
  stage_attempts ||--o| stage_checkpoints : "attempt_id"
  stage_attempts ||--o| agent_execution_details : "attempt_id"
  stage_attempts ||--o| script_execution_details : "attempt_id"

  task_finals ||--|| pipeline_versions : "version_hash"
  task_worktrees ||--|| task_finals : "task_id (eventually)"
  task_env_values ||--o{ stage_attempts : "task_id (purged on final)"
  secret_gate_queue ||--|| stage_attempts : "attempt_id"
  hot_update_events ||--o| pipeline_proposals : "proposal_id"
  hot_update_events }o--|| pipeline_versions : "from_version + to_version"

  migration_hints ||--|| stage_attempts : "(task_id, stage_name)<br/>partial unique unconsumed"

  mcp_servers ||--o{ mcp_secrets : "entry_id"
```

A key quality of this schema: **every cross-table join is by
`attempt_id` or `version_hash`**, never by `task_id + stage_name + idx`
strings. This is why lineage queries are fast and unambiguous —
lineage rows live forever even after retries because they're
attached to the specific attempt that produced them.

---

## §12. The dogfood arc — what we shipped

> Whitepaper Part 5; full prose in
> `docs/superpowers/dogfood-2026-04-28/handoff-dogfood-11-12-13.md`.

```mermaid
gantt
  title Dogfood chain (2026-04-28 → 2026-05-03)
  dateFormat YYYY-MM-DD
  axisFormat %m-%d
  excludes weekends

  section c12+ review
  Wave 1 — Theme 1            :done, w1, 2026-04-28, 1d
  Wave 2 — Theme 2 + 3        :done, w2, 2026-04-29, 2d
  Wave 3                      :done, w3, after w2, 1d
  Wave 4                      :done, w4, after w3, 1d
  P2 sweep                    :done, p2, after w4, 1d

  section dogfood path
  Fresh dogfood (Bug 13/14/15) :done, d1, 2026-05-02, 1d
  Bug 16 root-cause + fix      :done, d2, after d1, 1d
  Cancel mid-run (dogfood-7)   :done, d3, 2026-05-03, 1d
  Multi-target rollback unit (dogfood-8) :done, d4, after d3, 1d
  Secret-pending (dogfood-9)   :done, d5, after d4, 1d
  Hot-update Bug 80 (dogfood-10) :done, d6, after d5, 1d
  Real-LLM multi-target (dogfood-11) :done, d7, after d6, 1d
  Fanout B17 (dogfood-12)      :done, d8, after d7, 1d
  Reverse-supersede + Bug 81 (dogfood-13) :done, d9, after d8, 1d

  section deliverables
  Registry UI                  :done, t1, 2026-05-03, 1d
  Web UI completion            :done, t2, after t1, 1d
  Whitepaper v2                :done, t3, after t2, 1d
```

---

## §13. Cumulative deliverables

> Whitepaper Part 6 (limitations) sets the boundary; this is the
> inside-the-boundary scoreboard.

| Artifact | Count |
|---|---|
| Server tests | 251 files / 2,374 tests pass |
| Web tests | 13 files / 66 tests pass |
| Registry-service tests | 65 (unit + adversarial) |
| Bugs found+fixed | 81 across c12+ → dogfood-13 |
| Commits since c12+ closure | ~50 |
| HTTP routes (kernel-next) | 18 (incl. SSE) |
| MCP tools surfaced | 17 |
| Web pages | 9 |
| Lines of TSC-clean TypeScript | ≈ 60K (server) + ≈ 18K (web) |

---

**End of visuals v2.0.**

Updates: bump version + add §N new for new diagrams. Don't edit the
legacy `architecture-visual.md`.
