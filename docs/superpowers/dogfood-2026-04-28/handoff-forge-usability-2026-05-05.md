# Forge Usability Round — Handoff (2026-05-05)

**Status**: Forge is **working end-to-end** but **not yet "好用"**.
This handoff is the punch list for closing the usability gap, with
enough context that a fresh session can execute it without re-deriving
anything.

**Branch**: `main` (already merged from `session-mining`).
**Latest commit**: `06a7e46` ("split forge_analyze into async start+result").
**Current state**: 22 forge test files / 192 tests green, tsc clean,
end-to-end MCP call verified live with a real session.

---

## Why this handoff exists

I (the previous session) verified Forge works by running `forge_analyze_start`
+ `forge_analyze_result` from inside Claude Code on a 96-line web3 research
session. The user got back a structured recommendation. Then we asked
"is it 好用?" and surfaced 11 real frustrations. The user told me to
fix all 11 in another session. This is that punch list.

**Read first**:
- `/Users/minghao/workflow-control/docs/forge-quickstart.md` — the
  user-facing 3-step guide (server, ~/.claude.json, in-CC trigger).
- `apps/server/src/forge/api/analyze-handler.ts` — the orchestrator.
- `apps/server/src/forge/distillation/submit-distill.ts` — async
  start + harvest split landed in `06a7e46`.
- `apps/server/src/kernel-next/mcp/tools/forge.ts` — current MCP tool
  surface (forge_analyze_start, forge_analyze_result).

---

## What's working today (don't break)

- forge.db schema (sessions / events / episodes / signatures / clusters /
  cluster_members / pipeline_candidates / pipeline_embeddings)
- redactor (5 secret patterns, word-boundary fixed 2026-05-05)
- session-loader (peeks first 64KB for canonical sessionId; fixed
  filename≠sessionId FK violation)
- pipeline-matcher (descriptor embedding, cosine ≥ 0.78 threshold)
- multi-episode partition into recommendations + skippedEpisodes
- async MCP pair (`forge_analyze_start` returns <1s, `forge_analyze_result`
  polls). Verified live, end-to-end.
- HTTP `/api/forge/analyze/start` + `/api/forge/analyze/result` mirror
  the MCP tools.
- Sync `/api/forge/analyze` retained for the web UI.

---

## The 7 issues to fix

Priority order (descending impact). Pick them up one-by-one — each
is a small, testable, committable unit.

### Issue 1 — `forge_analyze_result` should accept a `waitMs` parameter

**Why it's painful now**: The agent has to write a polling loop:
"call result, check status, sleep 10s, retry". MCP clients don't
naturally do this; the agent often forgets and stops after one call.
The result is "wait, did it finish?" hand-wringing.

**Fix**: Add an optional `waitMs` parameter to `forge_analyze_result`
(MCP tool + HTTP endpoint). When set, the handler internally polls
the kernel-next task at small intervals (e.g. 1s) until either:
- the task reaches a terminal state (return final result), OR
- `waitMs` elapses (return `kind: "running"` so the agent knows to
  call again).

Bound `waitMs` to ≤ 50_000 (50s) so we still leave headroom under
the MCP client's ~60s tool-call timeout. Default: 50_000. Tests
should cover: (a) finishes within wait → returns final, (b) doesn't
finish → returns running, (c) waitMs=0 → behaves like today
(single non-blocking poll).

**Touch points**:
- `apps/server/src/forge/api/analyze-handler.ts` —
  `analyzeHarvest(ctx, analysisId, opts?: { waitMs?: number })`.
- `apps/server/src/kernel-next/mcp/tools/forge.ts` — add `waitMs`
  to inputSchema; default 50_000.
- `apps/server/src/forge/api/routes.ts` — `?waitMs=` query param.
- New tests in `apps/server/src/forge/__tests__/analyze-handler.test.ts`.

**Reference pattern**: kernel-next already has
`wait_for_task_event` with similar wait-or-give-up semantics. Look
at how it's plumbed for inspiration.

---

### Issue 2 — Short, ergonomic `analysisId` instead of 1.2KB base64

**Why it's painful now**: Current `analysisId` is base64url of
`{sessionId, jsonlPath, taskId, truncated}` — about 600-1200 chars.
Agent has to round-trip the full thing; humans copy-pasting in
debug see a wall of characters.

**Fix**: Use the kernel-next taskId directly as the analysisId
(it's already short: `forge-distill-1777993813697-4d43d155`).
Persist `(taskId → handle)` mapping in a new tiny forge.db table
or in-memory Map keyed by taskId. The handle stores `{sessionId,
jsonlPath, truncated, emptyResult?}`.

Decision needed during implementation:
- **DB table** (`forge_analyses`): survives restart, queryable for
  history. Recommended.
- **In-memory Map**: simpler, but lost on restart. Bad UX if user's
  forge_analyze_start landed before a restart.

Pick the DB table.

**Touch points**:
- New table in `apps/server/src/forge/db/schema.ts` and a CRUD module
  `apps/server/src/forge/db/analyses.ts` — `(analysis_id PK,
  session_id, jsonl_path, task_id, truncated, started_at,
  empty_result_json TEXT NULL)`.
- `analyzeStart()` writes the row, returns `analysisId = taskId`.
- `analyzeHarvest()` looks up the row to reconstruct the handle.
- `encodeAnalysisId` / `decodeAnalysisId` in analyze-handler.ts can
  be removed.
- Migrate the special "empty session" path: store `empty_result_json`
  in the row instead of inside the encoded handle.
- Tests: insert + lookup; INVALID_ANALYSIS_ID for unknown.

---

### Issue 3 — Suggested external input names are truncated mid-word

**Why it's painful now**: Real example from a live run:
- `task_specification_document_with` (cut at "with")
- `research_topics_bridge_contracts` (cut at "contracts")
- `discovered_urls_from_search_resu` (cut at "resu")

These get pasted verbatim into the pipeline-generator prompt as
suggested external input names. Pipeline-generator then either
rejects or generates broken input identifiers.

**Fix**: In `buildCreateProposal()` in `analyze-handler.ts`, change
the slug-name builder for inputs:

```ts
// Current (broken):
const slugName = input.toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .slice(0, 32)
  .replace(/^_+|_+$/g, "");

// Replacement strategy:
//  1. lowercase + non-alnum → _
//  2. truncate AT a word boundary so we never cut "specifications"
//     into "specifi"; if the first word is itself > 32 chars use
//     the full first word (no truncation in mid-word)
//  3. strip leading/trailing _
//  4. fall back to `input_<idx>` only if empty
```

Implement word-boundary-aware truncation. Helper:

```ts
function safeSlug(text: string, maxLen: number): string {
  const tokens = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/);
  let out = "";
  for (const t of tokens) {
    if (!t) continue;
    if (!out) { out = t; continue; }
    const next = out + "_" + t;
    if (next.length > maxLen) break;
    out = next;
  }
  return out;
}
```

Then `slugName = safeSlug(input, 32)`. Always at a word boundary;
if the first token alone exceeds the limit, use it whole rather
than mid-word truncate.

**Touch points**:
- `apps/server/src/forge/api/analyze-handler.ts:buildCreateProposal`
  + a sibling helper `safeSlug`.
- New tests with input strings that previously got mid-word cut.
- Same helper applies to Issue 4.

---

### Issue 4 — `suggestedName` ends in `-ar` mid-word

**Why it's painful now**: Live example:
`research-a-web3-protocol-s-cross-chain-bridge-ar` (real run).
Earlier I "fixed" this with `slice(0, 48).replace(/^-+|-+$/g, "")`
but slicing first then stripping just leaves whatever falls at the
boundary. The fix is identical to Issue 3: truncate **at a word
boundary**, not at character N.

**Fix**: Reuse `safeSlug(intent, 48)` from Issue 3 but with hyphens
as the separator (variant or parameter).

Suggested signature:

```ts
function safeKebabSlug(text: string, maxLen: number): string {
  // word-boundary-aware kebab-case truncation
}
```

Apply to `slug = safeKebabSlug(ep.intent, 48)`.

**Touch points**:
- Same file as Issue 3.
- Update existing test `pipeline-descriptor.test.ts` etc. if any
  fixture currently expects the old broken truncation.

---

### Issue 5 — `description` and `pipelineGeneratorPrompt` 99% duplicate

**Why it's painful now**: Look at `proposal.description` and
`proposal.pipelineGeneratorPrompt` side-by-side in the live result —
the prompt embeds the entire description verbatim plus a header.
Two large strings nearly identical. Wastes MCP tokens.

**Fix**: Stop computing `description` separately. Either:
- (a) drop the `description` field entirely (callers can use
  `pipelineGeneratorPrompt`), OR
- (b) keep `description` as the *one-paragraph* high-level summary
  (intent + outcome + rationale) and have `pipelineGeneratorPrompt`
  reference it.

Recommendation: **(a) drop `description`**. The intent + steps are
already structured fields; anyone who wants a paragraph can build
it from those. Update web UI to render from
`pipelineGeneratorPrompt` (or build its own paragraph from
intent+outcome+rationale).

**Touch points**:
- `apps/server/src/forge/api/types.ts` — remove `description` from
  `CreateNewRec.proposal`.
- `apps/server/src/forge/api/analyze-handler.ts:buildCreateProposal`
  — stop assembling it.
- `apps/web/src/app/forge/page.tsx` — adapt UI.
- Tests update.

---

### Issue 6 — `decodeProjectDir` mangles directory names containing hyphens

**Why it's painful now**: Live result showed
`cwd: "/private/tmp/workflow/control/data/workspaces/web3/tech/research/..."`
when the actual cwd is
`/private/tmp/workflow-control/data/workspaces/web3-tech-research/...`.
Claude Code encodes `/` as `-` in the project dir name, but my
naïve decode `dirName.replace(/^-/, "/").replace(/-/g, "/")`
collapses ALL hyphens — including hyphens that were originally
*part of the directory name*. spec acknowledges this can't round-trip,
but the error path surfaces wrong cwd to the user.

**Fix options**:
- **(a)** Stop trying to decode. Store the raw encoded dir name in
  `cwd` (e.g. `-private-tmp-workflow-control-data-...`) and surface
  it as-is. UI can label it "session project (encoded)".
- **(b)** Decode but mark `cwd` with a flag like `cwdReliable: false`
  when ambiguity is detected (e.g. consecutive hyphens, or any
  hyphen at all).
- **(c)** Best-effort: walk the filesystem upward looking for an
  existing path that matches one of the possible decodings. Slow,
  fallible.

Recommendation: **(a)** — honest, no false confidence. Update the
analyze response to include `cwd: <raw encoded form>` and a separate
`projectDirEncoded: true` marker so the UI can render it as a hint
("looks like /private/tmp/workflow-control/...") without claiming.

**Touch points**:
- `apps/server/src/forge/ingestion/watcher.ts:decodeProjectDir` —
  remove or rename to `rawProjectDir(dirName) → dirName`.
- `apps/server/src/forge/ingestion/session-loader.ts:loadSession` —
  store raw, not decoded.
- `apps/server/src/forge/db/schema.ts` — `cwd` semantics change is
  documented in a comment; existing rows can stay (already broken
  data, not worth migrating).
- Tests: existing `decodeProjectDir` tests need to change or be
  deleted.

---

### Issue 7 — No "analyze the last N sessions" surface

**Why it's painful now**: Common user intent: "I worked on three
small things over the last hour, can you tell me which ones are
worth automating?" Currently the user has to call
`forge_analyze_start` 3 times with 3 different `sessionId`s.

**Fix**: Add a new MCP tool `forge_analyze_recent` (and matching
HTTP `POST /api/forge/analyze/recent`) that:
1. Lists the most recent N (default 3, max 10) `.jsonl` files under
   `~/.claude-personal/projects/`.
2. Returns immediately with `{ analyses: [{ sessionId, analysisId,
   taskId, jsonlPath }, ...] }` — one analysisId per session, all
   distill tasks kicked off in parallel.
3. The agent then polls each analysisId via existing
   `forge_analyze_result`. (No new aggregate-result tool needed
   for v1.)

Default N=3; cap at 10 to prevent token spend explosions.

**Touch points**:
- `apps/server/src/forge/api/analyze-handler.ts` — new
  `analyzeRecent(ctx, { count?, since? })`.
- `apps/server/src/forge/ingestion/session-loader.ts` — add
  `listRecentSessionFiles(projectsRoot, count)` (similar to existing
  `findMostRecentSessionFile`).
- `apps/server/src/forge/api/routes.ts` — new endpoint.
- `apps/server/src/kernel-next/mcp/tools/forge.ts` — new tool.
- `apps/server/src/kernel-next/mcp/server.ts` — `ToolName` +
  `EXTERNAL_TOOLS` extended.
- Tests cover: (a) 3 sessions exist → 3 analysisIds; (b) only 1
  session exists → 1 analysisId; (c) no sessions → empty array.

---

## Out of scope for this round (keep notes for v2)

| Idea | Why deferring |
|---|---|
| `forge_recommendations_history` | Useful but not blocking. |
| `forge_list_recent_sessions` (read-only) | The recent-N analyze covers this need. |
| Re-analysis cache | First do the multi-session round, then see if cache is needed. |
| Localized error messages | Fix copy when other UX is solid; refactoring text now is wasteful. |
| Markdown-rendered humanSummary | The agent itself formats output for the user. |

---

## Suggested implementation order

1. **Issue 6** (cwd decode bug) — smallest, isolated, removes a
   user-visible wrongness. ~30 min including tests.
2. **Issue 3 + 4** (safe slug) — share a helper, do them together.
   ~45 min.
3. **Issue 5** (drop description) — touches types + UI but small.
   ~30 min.
4. **Issue 2** (short analysisId + DB table) — schema change + CRUD
   module + handler refactor. ~1.5h.
5. **Issue 1** (waitMs blocking poll) — last because it changes the
   agent UX contract; build on top of stable foundation. ~1h.
6. **Issue 7** (recent N) — additive new tool. ~1h.

Total: ~5 hours of focused work. Each issue is independently
committable.

---

## Verification before declaring done

After all 7, run:

```bash
cd /Users/minghao/workflow-control/apps/server
npx tsc --noEmit              # double-check tsc clean
npx vitest run src/forge/     # all forge tests green
```

Then **dogfood live**:

1. Restart the workflow-control server (`pnpm --filter
   @workflow-control/server dev`).
2. From inside a fresh Claude Code session, call `forge_analyze_start`
   with `waitMs: 50000`. Should return either final result in one
   call (most short sessions) or a running marker.
3. If running, call `forge_analyze_result` with same `analysisId`.
   The id should be a short kernel-next-style taskId, NOT a 1.2KB
   base64 blob.
4. Confirm `cwd` in the response is either the raw encoded dir
   name OR a verifiable real path.
5. Confirm `suggestedExternalInputs[*].name` are word-boundary-clean.
6. Confirm `proposal.suggestedName` does not end mid-word.
7. Confirm `proposal.description` is gone (or repurposed cleanly).
8. Try `forge_analyze_recent` with default count. Verify multiple
   analysisIds returned.

If all 8 pass: usability round done.

---

## Files most likely to change (no surprise list)

```
apps/server/src/forge/api/analyze-handler.ts      [issues 1, 2, 3, 4, 5, 7]
apps/server/src/forge/api/routes.ts               [issues 1, 2, 7]
apps/server/src/forge/api/types.ts                [issue 5]
apps/server/src/forge/db/schema.ts                [issue 2]
apps/server/src/forge/db/analyses.ts              [NEW for issue 2]
apps/server/src/forge/distillation/submit-distill.ts  [issue 1 — waitMs in harvest]
apps/server/src/forge/ingestion/session-loader.ts [issues 6, 7]
apps/server/src/forge/ingestion/watcher.ts        [issue 6]
apps/server/src/kernel-next/mcp/tools/forge.ts    [issues 1, 7]
apps/server/src/kernel-next/mcp/server.ts         [issue 7]
apps/web/src/app/forge/page.tsx                    [issue 5]
apps/server/src/forge/__tests__/...               [all issues]
```

---

## Roadmap entry to add when done

After all 7 land, append a row 1.32 to
`docs/product-roadmap.md` summarizing:

> Forge usability round: waitMs blocking poll (no more dual-call),
> short kernel-next-taskId-as-analysisId backed by `forge_analyses`
> table, word-boundary-aware slug helpers (suggestedName + input
> names no longer mid-word truncated), removed redundant
> `description` field, raw encoded cwd (no more wrong-decoded paths
> for projects with hyphens), `forge_analyze_recent` for multi-session
> kickoff.

---

## One last sanity check

The previous session caught **5 real bugs by actually running**
forge end-to-end. **Do that for this round too**: don't ship until
you've called `forge_analyze_start` from inside a real Claude Code
session and read the result with your own eyes. Unit tests will not
catch slug-truncation regressions or wrong-cwd surface-level bugs.
EOF