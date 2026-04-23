# B5 Confirm UI — Design

> **Date**: 2026-04-23
> **Source trigger**: Phase 6 runs #4, #6, #7 (see `docs/phase6-usage-log.md`) —
> the only gate answer channel was `curl POST /api/kernel/gates/:id/answer`,
> and the gate question text (`"Approve this result?"`) carried no context,
> forcing the operator to inspect SQLite directly before deciding. Blocks M2.

## Goal

When a kernel-next task reaches a `gated` state, the dashboard shows:
1. The gate's question text.
2. The full set of output ports produced by every stage that feeds the
   gate via a wire (pipeline-generator's `awaitingConfirm` → exposes all
   16 `analyzing.*` output ports as decision context).
3. An answer button per valid routing key.

Clicking a button calls the existing `/answer` endpoint and the card
disappears when the gate is no longer pending.

## Non-Goals

- Gate question template interpolation / render hints (YAGNI — wire
  topology already identifies the decision context).
- Cross-task gate inbox (dashboard stays per-task for this milestone).
- New SSE event for gate opening (polling `/status` is cheap enough at
  the per-task page granularity; P6-10 resumability is a separate
  project).
- Authentication (single-user product).
- Editing in-flight answers or retracting an answer.

## Architecture Overview

Server adds exactly one new read endpoint:

```
GET /api/kernel/gates/:gateId/context
```

No change to `/answer`, `/status`, SSE, or any write path.

Client adds a `GateCard` component and a 2 s `/status` poller to the
existing `apps/web/src/app/kernel-next/[taskId]/page.tsx`. For each
pending gate the page fetches `/context` once and renders a card; the
user's click on an answer button calls `/answer` and re-polls.

## Server: Endpoint

### Route

`apps/server/src/routes/kernel-gates.ts` gains a handler:

```
GET /api/kernel/gates/:gateId/context
```

**200** body:
```ts
{
  ok: true;
  gateId: string;
  taskId: string;
  stageName: string;
  question: { text: string; options?: string[] };
  createdAt: number;
  answeredAt: number | null;
  answer: string | null;
  answerOptions: string[];          // routes keys, filtered to exclude "_default"
  upstreams: Array<{
    stage: string;
    outputs: Array<{
      port: string;
      value: unknown;               // parsed from port_values.value_json
      writtenAt: number;
    }>;
  }>;
}
```

**404** body: `{ ok: false, diagnostics: [{ code: "GATE_NOT_FOUND", ... }] }`

### KernelService.getGateContext

Lives in `apps/server/src/kernel-next/mcp/kernel.ts` (same file as
`createGate` / `answerGate` / `listGates` — this is their natural
neighbour).

Algorithm:
1. Fetch gate row from `gate_queue` by `gate_id`. Return `GATE_NOT_FOUND`
   if absent.
2. Fetch the attempt's `version_hash` from `stage_attempts`. If absent,
   return the same `GATE_ANSWER_INVALID` code `answerGate` uses (keeps
   diagnostic vocabulary consistent across gate operations).
3. Load the IR via `getPipelineIR(db, versionHash)`. If absent, return
   `GATE_ANSWER_INVALID`.
4. Find the gate stage (`ir.stages.find(s => s.name === row.stage_name &&
   s.type === "gate")`). If missing, return `GATE_ANSWER_INVALID`.
5. Derive `answerOptions`:
   `Object.keys(stage.config.routing.routes).filter(k => k !== "_default")`.
6. Derive `upstreamStages` set: for every wire in `ir.wires` where
   `to.stage === row.stage_name` AND `from.source === "stage"`,
   collect `from.stage` into a Set. External-source wires contribute
   no upstream stage (seed inputs render in the existing "Seed Inputs"
   block of the page already, and a gate whose only upstream is a seed
   has no stage-level context to surface).
7. For each upstream stage, query the latest successful `direction='out'`
   port_values rows tied to the same `task_id`:
   ```sql
   SELECT pv.port_name,
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
     );
   ```
   Order the outputs by `port_name` ascending for deterministic rendering.
   Parse each `value_json` via `JSON.parse`; if parsing throws, emit
   `value: null` (lineage is corrupted but the gate-render path must not
   take down the UI).
8. Return the assembled payload.

### Why one query per upstream stage, not one join

The query as written above is one query that picks the latest-per-port
row for one stage. `getGateContext` runs it once per upstream stage in
a simple loop. For pipeline-generator's `awaitingConfirm` that's one
query (single upstream: `analyzing`). For pathological gates with many
upstreams, it would still be N small queries against the partial index
on `port_values(stage_name, port_name, direction, written_at DESC)`
(existing: `idx_pv_port`). A single flat join would be denser to read
without a measurable win at N ≤ 5 upstreams, which is the realistic
shape.

## Client: Gate Card

### New component

`apps/web/src/components/gate-card.tsx`

```tsx
interface GateContextResponse {
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
    outputs: Array<{ port: string; value: unknown; writtenAt: number }>;
  }>;
}

interface Props {
  context: GateContextResponse;
  onAnswer: (answer: string) => Promise<{ ok: boolean; error?: string }>;
}
```

Render:
- Card header: `stageName` + question text.
- One collapsed `<details>` per upstream stage, title
  `<stage> (<N> outputs)`. Inside: table of port/value/writtenAt.
- Value rendering: if `typeof value === "string"` → `<pre>`
  (preserves multiline markdown like `summary`); else
  `<pre>JSON.stringify(value, null, 2)</pre>`. Truncate to 2 kB with
  a "show full" toggle (prevents a giant `subPipelineContracts`
  crashing scroll — the common case in pipeline-generator).
- Answer buttons: one `<button>` per `answerOptions` entry, disabled
  while request in flight. On error, render the server's diagnostic
  message in red below the buttons; leave buttons re-enabled so the
  user can try a different answer.

The card does NOT auto-dismiss on answer success. It polls `/status`
in the parent page and disappears when `status` no longer lists this
`gateId` as pending.

### Page changes

`apps/web/src/app/kernel-next/[taskId]/page.tsx`:

1. Add `const [pendingGateIds, setPendingGateIds] = useState<string[]>([])`
   and `const [gateContexts, setGateContexts] = useState<Map<string, GateContextResponse>>(new Map())`.
2. Add a new `useEffect` that polls `GET /api/kernel/tasks/:taskId/status`
   every 2 s (abort-controller pattern identical to the existing SSE
   effect). When status returns `gated`, set `pendingGateIds` to the
   `pending[].gateId` list. When status returns anything else, set
   `pendingGateIds` to `[]`.
3. Second `useEffect` (depends on `pendingGateIds`): for each ID not
   already in `gateContexts`, fetch `/api/kernel/gates/:id/context` and
   store in the map. IDs that left `pendingGateIds` get evicted from
   the map (prevents memory growth under long-running tasks).
4. Render `<GateCard>` for each `pendingGateIds[i]` whose context has
   loaded. Card placement: above the existing "Stages" section so the
   operator sees it first.
5. `onAnswer` handler: `POST /api/kernel/gates/:id/answer { answer }`,
   surface server `diagnostics[0].message` on failure, trigger immediate
   re-poll of `/status` on success.

No new dependency (uses fetch, React hooks already in file).

## Error Handling

| Layer | Failure | Behavior |
|---|---|---|
| `/status` poller | network error | silent retry next tick |
| `/context` fetch | 404 or network | fall back: render card with question + answer buttons, no upstream block, caption "upstream context unavailable" |
| `/answer` POST | `GATE_ALREADY_ANSWERED` | show message, keep buttons enabled so user can re-poll-check |
| `/answer` POST | `GATE_ANSWER_INVALID` | show message, keep buttons enabled |
| `/answer` POST | network | show "network error, retry" |
| Value parse | `value_json` unparseable | server emits `value: null`; card renders `"(unparseable lineage value)"` |

## Testing

### Server

`apps/server/src/kernel-next/mcp/kernel.test.ts` — new `describe`
block for `getGateContext`:

1. **happy path**: submit IR with 1 agent stage producing 3 ports + 1
   gate stage fed by one of those ports; open a gate; call
   `getGateContext`; assert `upstreams[0].stage === "a"`,
   `upstreams[0].outputs.length === 3`, values + `writtenAt` match
   what was written. `answerOptions` = `["approve", "reject"]`.
2. **unknown gate**: `getGateContext("bogus")` returns
   `{ ok: false, diagnostics: [{ code: "GATE_NOT_FOUND" }] }`.
3. **already answered**: answer the gate, call `getGateContext`;
   response still 200, `answer` and `answeredAt` populated.
4. **`_default` filtered**: gate with `routes: { approve: "X",
   _default: "Y" }` → `answerOptions === ["approve"]`.
5. **gate with no stage upstream (pure external feed)**:
   `upstreams === []`.
6. **superseded attempt output is ignored**: seed a superseded
   attempt's port write followed by a success attempt's port write for
   the same `(stage, port)`; assert only the success value surfaces.

`apps/server/src/routes/kernel-gates.test.ts` — new cases:

1. `GET /gates/:id/context` 200 shape (mirror kernel.test happy case,
   assert HTTP envelope).
2. `GET /gates/:id/context` 404 body shape.

### Client

No new unit test. Manual verification during the next Phase 6 run
(run #8+ via pipeline-generator): verify the card renders with all 16
`analyzing.*` port values, approve works, card disappears on answer.

## File Structure

Created:
- `apps/server/src/kernel-next/mcp/kernel.ts` → add `getGateContext`
  method (same file, same class)
- `apps/server/src/routes/kernel-gates.ts` → add `GET /:gateId/context`
  handler (same file)
- `apps/web/src/components/gate-card.tsx` (new)
- `apps/web/src/app/kernel-next/[taskId]/page.tsx` → two new useEffects,
  one new section

Modified tests:
- `apps/server/src/kernel-next/mcp/kernel.test.ts`
- `apps/server/src/routes/kernel-gates.test.ts`

## Out-of-Scope Follow-ups (captured, not built)

- P6-10 resumability (runner survives server restart): blocks true
  gate reliability but is independent engineering.
- P6-5 HTTP `run` taking IR.name instead of directory slug: slugify
  in start-pipeline-run.
- P6-6 taskId containing spaces: same fix as P6-5.
- Gate render hint (`gate.config.render.summary: "{stage.port}"`):
  deferred until B5 usage shows the whole-stage render is too much.
