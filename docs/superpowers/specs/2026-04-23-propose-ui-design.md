# Propose UI Design — B5 Extension

> **Date**: 2026-04-23
> **Scope**: Add a UI path to create `pipeline_proposals`, unblocking M2
> (3-5 friends試用). Pre-change, proposals can only be created via MCP
> or a hand-written HTTP curl with IRPatch JSON; the UI can only
> approve/reject what someone else created.
>
> **Non-goals**: Structured IR editing in the browser (add/remove
> stage, rewire ports). The API keeps that power; the UI does not
> expose it. 95% of Phase 6 dogfood iterations were prompt-only
> changes — the UI optimises for that path and gets out of the way
> for everything else.

---

## 1. Problem

`propose()` currently requires a non-empty `IRPatch.ops` at the zod
schema boundary (`ir/schema.ts:271`, `routes/kernel-proposals.ts:42`).
But `pipelineVersionHash` already folds prompts into the hash, so a
prompts-only change naturally produces a new version — the non-empty
patch requirement is a **historical artefact that forced the run #15
workaround** (`patch: [{ op: "update_stage_config", ..., configPatch:
{ promptRef: "system/write-pr" } }]` — re-setting the same value to
force an IR-hash diff). Fossilising that hack in the UI would make it
a permanent user-facing pattern.

Additionally, no HTTP endpoint exposes:
- The list of known pipelines (so UI can pick one)
- A version's IR + prompts map (so UI can show what's editable)

Proposal and pipeline inventory are server-only knowledge today.

## 2. Architecture

Three layers, each an independently testable unit:

```
[API layer]        IRPatchSchema         ← ops.min(1) → ops.min(0)
                   kernel-proposals.ts   ← route schema ops.min(1) → ops.min(0)
                   KernelService.propose ← NO_OP_PROPOSAL when
                                            proposedHash === currentVersion

[Inventory]        GET /api/kernel/pipelines
                   GET /api/kernel/pipelines/:versionHash

[UI layer]         /kernel-next/pipelines                (list)
                   /kernel-next/pipelines/[name]          (edit + submit proposal)
                   /kernel-next/proposals                 (list + approve/reject)
```

The flow:

```
User opens /pipelines                     GET /api/kernel/pipelines
  → picks `pr-description-generator`      GET /api/kernel/pipelines/:hash
  → edits `system/write-pr.md` textarea
  → actor = "human:ymh"
  → Submit                                POST /api/kernel/proposals
                                             body: { currentVersion, patch: {ops:[]},
                                                     actor, prompts: {…} }
  → Redirect to /proposals                GET /api/kernel/proposals?status=pending
  → approve                               POST /api/kernel/proposals/:id/approve
  → (optional) migrate running task       POST /api/kernel/tasks/:id/migrate
```

The UI never constructs an IRPatch. The empty `{ops:[]}` is the
structural way to say "no IR change, only prompts". After the API
layer change below, the server accepts it directly.

## 3. Component Responsibilities

### 3.1 API layer — `NO_OP_PROPOSAL`

`propose()` today silently succeeds on truly no-op inputs because the
outer schema blocks empty `ops` and no other no-op signal is checked.
After we relax that schema, we need an explicit guard so that
"submitted form with zero edits" doesn't create an empty proposal.

Rule: after computing `proposedHash`, if
`proposedHash === currentVersion`, return
```ts
{ ok: false, diagnostics: [{ code: "NO_OP_PROPOSAL", message, context }] }
```
This covers:
- Empty patch + empty prompts (truly no change)
- Non-empty patch that happens to be idempotent (e.g., setting a field
  to its current value) + empty prompts
- Prompts override that exactly matches base content

`NO_OP_PROPOSAL` joins the existing diagnostic vocabulary
(`PATCH_APPLY_ERROR`, `PROMPT_REF_MISSING`, etc.) and maps to HTTP 400
in `kernel-proposals.ts` route.

### 3.2 Inventory endpoints

**`GET /api/kernel/pipelines`**
Returns `{ ok: true, pipelines: Array<{ name: string; latestVersion: string;
          latestCreatedAt: number }> }`. Sourced from:
```sql
SELECT pipeline_name, version_hash, MAX(created_at)
FROM pipeline_versions GROUP BY pipeline_name
```
One row per pipeline name. UI uses this for the picker.

**`GET /api/kernel/pipelines/:versionHash`**
Returns `{ ok: true, ir: PipelineIR, prompts: Record<string, string>,
          parentHash: string|null, createdAt: number }`. 404 if hash
unknown. Prompts come from `getPromptsByVersion`. UI uses this to
populate the edit form and to compute "did any field change".

Both endpoints are read-only; no auth (single-user local product).

### 3.3 UI — `/kernel-next/pipelines`

Server-render-free page (client `"use client"` consistent with existing
`[taskId]/page.tsx`). Fetches `GET /api/kernel/pipelines` on mount.

Table columns: name | latest version (short hash) | created at |
action (→ edit link).

### 3.4 UI — `/kernel-next/pipelines/[name]`

Fetches `GET /api/kernel/pipelines`, picks the row matching `[name]`
to get `latestVersion`, then fetches `GET /api/kernel/pipelines/:hash`.

Renders:
- Pipeline name + base-version hash (read-only)
- For each promptRef in the returned `prompts` map: one `<textarea>`
  prefilled with current content. A diff indicator ("modified" badge)
  lights up when the textarea's value differs from the original.
- An `actor` input (required, free text, prefilled from
  `localStorage.kernelActor` if set).
- A "Submit proposal" button, disabled until at least one prompt is
  modified **and** `actor` is non-empty.

On submit:
1. Build `prompts` map containing **only modified refs** (unchanged
   refs are carried by `propose()` itself — no need to resend).
2. POST to `/api/kernel/proposals` with
   `{ currentVersion: latestVersion, patch: { ops: [] }, actor,
     prompts }`.
3. On 202 response, save actor to localStorage and redirect to
   `/kernel-next/proposals`.
4. On 400/409/500, display the diagnostic message inline, do not
   clear the form.

Edge case: `prompts` map is empty from the server (no agent stages in
this pipeline). Show "This pipeline has no editable prompts — nothing
to iterate via this UI yet" and disable submit. Keeps the page
structurally valid for future IR-editing features without half-baking
them now.

### 3.5 UI — `/kernel-next/proposals`

Fetches `GET /api/kernel/proposals` on mount. Three sections: pending,
approved, rejected.

Each row shows: proposal ID (short) | pipeline name (resolved by
joining `baseVersion` → `pipeline_versions` — requires a tiny
enrichment in the list endpoint, see 3.6) | actor | createdAt | diff
summary (from `diagnostic_json.diff`, extracted lazily).

Pending rows have Approve / Reject buttons. Approve POSTs to
`/api/kernel/proposals/:id/approve`. After success, row moves to
approved.

### 3.6 Enrichment to existing `GET /api/kernel/proposals`

The current route returns raw `ProposalRow[]`. UI needs `pipelineName`
per row. Two options:

- **(a)** Do the join server-side, add `pipelineName` to
  `ProposalRow`. Small, contained, single round trip.
- **(b)** UI joins client-side via the pipelines endpoint.
  Two round trips; N+1 problem if many proposals.

**Pick (a).** Single round trip; `pipelineName` is cheap SQL; keeps
the UI from reimplementing joins the server already knows how to do.
Update `ProposalRow` interface + SQL query accordingly.

### 3.7 Nav

Add two entries to `components/nav.tsx` (existing nav component):
- "Pipelines" → `/kernel-next/pipelines`
- "Proposals" → `/kernel-next/proposals`

## 4. Data Flow — Full Sequence

```
User            Browser                  Server                  DB
 │                │                        │                      │
 │ visit /pipelines                        │                      │
 │────────────────→                        │                      │
 │                │ GET /api/kernel/pipelines                     │
 │                │────────────────────────→                      │
 │                │                        │ SELECT pipeline_name …│
 │                │                        │─────────────────────→│
 │                │                        │←─────────────────────│
 │                │←───────────────────────│                      │
 │ click pr-description-generator          │                      │
 │                │ GET /api/kernel/pipelines/<hash>              │
 │                │────────────────────────→                      │
 │                │                        │ getPipelineIR+Prompts│
 │                │                        │─────────────────────→│
 │                │                        │←─────────────────────│
 │                │←───────────────────────│                      │
 │ edit prompt, actor=ymh, Submit          │                      │
 │                │ POST /api/kernel/proposals                    │
 │                │   body: {cv, patch:{ops:[]}, actor, prompts}  │
 │                │────────────────────────→                      │
 │                │                        │ propose():           │
 │                │                        │  applyPatch → same IR│
 │                │                        │  merge prompts       │
 │                │                        │  pipelineVersionHash │
 │                │                        │    ≠ currentVersion  │
 │                │                        │  insert new version +│
 │                │                        │    prompt_refs       │
 │                │                        │  INSERT proposal     │
 │                │←───────────────────────│                      │
 │ redirect /proposals                     │                      │
 │                │ GET /api/kernel/proposals                     │
 │                │────────────────────────→                      │
 │ approve                                 │                      │
 │                │ POST …/approve                                │
```

## 5. Error Handling

| Case | Where caught | Response |
|------|--------------|----------|
| No prompts edited | UI (button disabled) | N/A |
| Empty actor | UI (button disabled) | N/A |
| Submitted form unchanged somehow | Server (`NO_OP_PROPOSAL`) | 400, diagnostic shown inline |
| `currentVersion` stale (race with another proposer) | Server (`PATCH_APPLY_ERROR` → version not found) | 400, user reloads |
| Network error on submit | UI fetch wrapper | Keep form, red message |
| Approve of already-resolved proposal | Server (`PROPOSAL_ALREADY_RESOLVED`) | 409, refresh list |
| Invalid JSON | Server (`INVALID_JSON_BODY`) | 400, shouldn't happen from browser |

The `NO_OP_PROPOSAL` diagnostic also gets surfaced in inline form
error if a user somehow submits with zero real modifications (e.g.,
pasting identical content back). Doesn't block — user edits and
retries.

## 6. Testing

Every layer gets tests before code, per TDD principle.

### 6.1 Backend

New + modified tests in `apps/server/src/kernel-next/mcp/kernel.test.ts`:

- `propose() with empty patch + prompts override → success, proposedVersion ≠ base`
- `propose() with empty patch + empty prompts → NO_OP_PROPOSAL`
- `propose() with non-empty patch that is idempotent + empty prompts → NO_OP_PROPOSAL`
- Existing tests that rely on `ops.min(1)` as a rejection path: audit,
  migrate to `NO_OP_PROPOSAL` assertions where semantically equivalent.

New tests in `apps/server/src/routes/kernel-proposals.test.ts`:

- `POST /api/kernel/proposals with ops:[] + prompts → 202`
- `POST … with ops:[] + no prompts → 400 NO_OP_PROPOSAL`
- `GET /api/kernel/pipelines → lists names with latest versions` (new test file if needed: `kernel-pipelines.test.ts`)
- `GET /api/kernel/pipelines/:versionHash → 200 with ir + prompts`
- `GET /api/kernel/pipelines/:versionHash → 404 unknown hash`
- `GET /api/kernel/proposals now includes pipelineName`

### 6.2 Frontend

- `apps/web/src/components/prompts-editor.test.tsx` (new) — component
  that owns the multi-textarea editor:
  - Renders one textarea per prompt ref
  - "Submit" disabled until a textarea is modified and actor is filled
  - Emits only modified refs in onSubmit callback
- `apps/web/src/app/kernel-next/pipelines/page.test.tsx` (new) —
  renders pipelines list from mocked fetch.
- `apps/web/src/app/kernel-next/proposals/page.test.tsx` (new) —
  renders proposals list with mocked fetch; approve/reject click dispatches POST.

### 6.3 Dogfood Verification (M4 sample)

After all tests pass:
1. Start server, open `/kernel-next/pipelines`.
2. Pick `pr-description-generator`, edit `system/write-pr.md` adding
   a new rule.
3. Submit, approve via `/kernel-next/proposals`.
4. Run a task via existing POST `/api/kernel/tasks/run`.
5. Observe new rule in output → M4 third data point (3 propose / 0
   reject / 0 rollback target).

## 7. Milestones + Self-Review Checkpoints

I will self-review at the end of each milestone against these
criteria, and write the self-review into the commit body as
`Self-review:`:

1. **Functional correctness** — Do the tests cover the milestone's
   behaviour? Normal path + edge cases?
2. **Consistency** — Does this match surrounding modules' conventions
   (propose/approve/migrate vocabulary, GateCard styling, route
   error envelope)?
3. **Regression surface** — Have I checked what other code paths
   depend on the thing I changed? (`ops.min(1)` had downstream
   callers; `ProposalRow` has typed callers.)
4. **YAGNI check** — Anything speculative added "for future"? Remove.
5. **TDD discipline** — Test first, red, then code, then green? Or
   did I shortcut?

Milestones:

- **M-A**: `NO_OP_PROPOSAL` + schema relax + tests (backend only)
- **M-B**: New inventory endpoints + tests
- **M-C**: Enrichment of existing proposals list with pipelineName
- **M-D**: Frontend prompts-editor component
- **M-E**: Pipelines list page + pipeline detail page + wiring
- **M-F**: Proposals list page + approve/reject
- **M-G**: Nav integration + dogfood sample (real M4 data point)

Each M ships with: all tests green from `apps/server` and `apps/web`;
`npx tsc --noEmit` clean in both; self-review block in commit body;
commit directly to main (authorized).

## 8. Out of Scope (Explicit)

- Auth / actor identity verification — single-user local product.
- Migrate-on-approve from UI — approve alone leaves running tasks on
  old version. Add later if dogfood shows the need; MCP/HTTP still
  support it.
- IR structural editing (add_stage, wire management) — see Non-goals.
- Proposal diff visualisation beyond `diagnostic_json.diff` textual
  summary — acceptable at this maturity stage; rich diff is future.
- Proposal search / pagination — current volume is tiny (<20); `ORDER
  BY created_at DESC LIMIT 50` is enough.
- Prompt content versioning UI (show history per ref) — feature-flag
  territory; not this round.

## 9. Open Questions

None — the NO_OP_PROPOSAL semantics are the only contested call
(IR-only hash collision vs pipeline-version hash), and we're going
with pipeline-version hash as the equality test (already the canonical
version hash everywhere else post-audit).

---

## Self-review of this spec

- **Placeholders**: none.
- **Internal consistency**: §2 architecture = §3 responsibilities.
  `NO_OP_PROPOSAL` rule in 3.1 is the one quoted in 5's table and
  checked in 6.1's tests.
- **Scope**: one plan-sized feature (7 milestones, all in same cycle).
- **Ambiguity**: "did any field change" (§3.4) is concretely defined
  as "textarea value !== fetched content". "Enrichment"
  (§3.6) explicitly picks option (a) not (b).
