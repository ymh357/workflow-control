# Phase 1: Proposal

## Context

The kernel-next dashboard's per-attempt detail page (`apps/web/src/app/kernel-next/attempts/[attemptId]/page.tsx`) presents execution details in five tabs: Tool Calls, Messages, Thinking, Status Timeline, and Usage. Currently, a single HTTP endpoint `GET /api/kernel/attempts/:attemptId/details` fetches all data at once via `AttemptDetailsPayload`, which unpacks:

- `toolCalls` (from `tool_calls_json`)
- `agentStream` (from `agent_stream_json` — contains both "text" and "thinking" event types)
- `compactEvents` (from `compact_events_json`)
- `subAgents` (from `sub_agents_json`)
- `statusHistory` (derived from `stage_attempts` row)
- Cost/token/model metadata (cost_usd, token_input, token_output, session_id, model, duration_ms, etc.)

The constraint is that this API must work with Hono + node:sqlite (no new dependencies) on a single-user local deployment. There is no auth, and the dashboard may issue dozens of requests per minute as the user clicks between tabs and attempts.

## Design Alternatives

### Alternative 1: Monolithic Single-Endpoint (Current State, Status Quo)

**Shape:**
```
GET /api/kernel/attempts/:attemptId/details -> AttemptDetailsPayload
```

**Payload:**
```typescript
interface AttemptDetailsPayload {
  toolCalls: unknown[];
  agentStream: unknown[];
  compactEvents: unknown[];
  subAgents: unknown[];
  statusHistory: Array<{ status: string; startedAt: number; endedAt: number | null }>;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  sessionId: string | null;
  model: string | null;
  durationMs: number | null;
  startedAt: number | null;
  endedAt: number | null;
  terminationReason: string | null;
}
```

**Pros:**
- Zero latency overhead: single round-trip, no request waterfall
- Simplicity: one endpoint, one database query, one type definition
- Dashboard already partitions `agentStream` client-side into messages vs. thinking tabs
- Works fine for local single-user (no scaling concerns)

**Cons:**
- Always transfers unused data: if user clicks "Tool Calls" tab, pays for full agentStream + thinking + compactEvents
- Payload bloat: agentStream can be large (thousands of events); subAgents can contain nested execution traces
- No cache granularity: cannot cache stable parts (model, cost) separately from live parts (compactEvents during execution)
- No composability: if a future feature needs only cost data + prompt, must fetch entire payload or add new endpoint

### Alternative 2: Multi-Endpoint (Tab-Scoped)

**Shape:**
```
GET /api/kernel/attempts/:attemptId/details/tool-calls -> { toolCalls: unknown[] }
GET /api/kernel/attempts/:attemptId/details/messages -> { agentStream: unknown[] }
GET /api/kernel/attempts/:attemptId/details/thinking -> { agentStream: unknown[] }
GET /api/kernel/attempts/:attemptId/details/status -> { statusHistory: [...]; compactEvents: [...] }
GET /api/kernel/attempts/:attemptId/details/usage -> { cost, tokens, model, duration, ... }
GET /api/kernel/attempts/:attemptId/details/summary -> { all scalar fields, array lengths }
```

**Pros:**
- Bandwidth efficient: user clicking only "Usage" tab pays for ~500 bytes, not 50KB
- Composability: future features can fetch any subset
- Perceived responsiveness: smaller payloads arrive faster on slower connections
- Opt-in granularity: client controls which tabs are populated

**Cons:**
- Waterfall latency: first load requires N sequential requests to populate all tabs (unless parallelized)
- Dashboard complexity: must track per-tab loading states, error states, retry logic
- Database load: 6 queries instead of 1 per full view (though SQLite is fast)
- Type fragmentation: each endpoint has its own response shape, harder to refactor

### Alternative 3: Hybrid: One Endpoint, Optional Projection

**Shape:**
```
GET /api/kernel/attempts/:attemptId/details
GET /api/kernel/attempts/:attemptId/details?include=toolCalls,usage
GET /api/kernel/attempts/:attemptId/details?exclude=agentStream
```

**Behavior:**
- By default (no query params), returns full payload (backward-compatible with Alternative 1)
- `?include=X,Y,Z` returns only named fields
- `?exclude=X,Y,Z` returns everything except named fields
- Unrecognized fields are ignored (graceful degradation)

**Pros:**
- Backward-compatible: existing consumers (dashboard) work unchanged
- Opt-in efficiency: future consumers can request only what they need
- Single endpoint, single query (can be optimized to SELECT only requested columns)
- Client-friendly: dashboard can request exact subset at load time
- Flexibility: same interface handles "fetch everything" and "fetch only cost"

**Cons:**
- Modest complexity in route handler: must parse, validate, and filter SELECT clause
- Payload shape is unpredictable (partial types are error-prone)
- May encourage API sprawl ("I added ?include=x for my use case")

## Trace: Use Cases vs. Alternatives

### Use Case: Dashboard first load of attempt detail page
- **Alt 1:** Single fetch, ~50-200KB payload. Latency = 1 RTT + SQL query.
- **Alt 2:** 6 fetches in parallel. Latency = 1 RTT + slowest SQL query. **Verdict: Monolithic wins on simplicity.**
- **Alt 3:** Single fetch with no params. Same as Alt 1. **Verdict: Tie with Alt 1.**

### Use Case: User clicks "Usage" tab while page is already loaded
- **Alt 1:** Data already loaded (fetched on first load). Instant. **Verdict: Monolithic wins.**
- **Alt 2:** Dashboard must fetch `/details/usage` if not cached. Additional request. **Verdict: Multi-endpoint loses.**
- **Alt 3:** Data already loaded. Instant. **Verdict: Tie with Alt 1.**

### Use Case: Attempt is still running; user refreshes detail page
- **Alt 1:** Fetch latest full payload. ~50-200KB. **Verdict: Monolithic, simple and complete.**
- **Alt 2:** Fetch only status/messages endpoints. **Verdict: Multi-endpoint adds client logic.**
- **Alt 3:** Fetch with `?include=status,agentStream`. Single request. **Verdict: Tie with Alt 1.**

### Use Case: Large agent stream (10,000+ events)
- **Alt 1:** 200-300KB payload. Acceptable on local hardware. **Verdict: Acceptable.**
- **Alt 2:** Multiple smaller fetches. More dashboard complexity. **Verdict: Adds complexity.**
- **Alt 3:** Selective fetch with projection. **Verdict: Acceptable.**

### Use Case: Dashboard calls endpoint dozens of times per minute
- **Alt 1:** 1 query per click. SQLite handles 100+ QPS easily. **Verdict: No problem.**
- **Alt 2:** 6 queries per full page, or 1 per tab. Still << 1000 QPS. **Verdict: No problem.**
- **Alt 3:** Same as Alt 1. **Verdict: No problem.**

### Use Case: Future feature needs only cost + model metadata
- **Alt 1:** Must accept full payload, parse unused arrays. **Verdict: Works but wasteful.**
- **Alt 2:** Requires new endpoint `/details/summary`. **Verdict: API sprawl.**
- **Alt 3:** Use `?include=costUsd,model,sessionId`. **Verdict: Single request, composable.**

## Chosen Design

**I choose Alternative 1 (Monolithic Single-Endpoint).**

The endpoint remains as implemented:
```
GET /api/kernel/attempts/:attemptId/details -> AttemptDetailsPayload
```

**Rationale:**

1. **Constraints satisfied.** Deployment is local, single-user, no bandwidth pressure. Monolithic endpoint is fast and simple.

2. **Dashboard already optimized.** The page partitions `agentStream` client-side. Adding complexity (multi-endpoint, projections) gains nothing for the current consumer.

3. **Latency matters most.** Dashboard responsiveness is driven by RTT, not payload size. One request beats multiple requests.

4. **No over-engineering.** The current implementation is the right complexity level for the brief.

5. **Future-proof via expansion.** If a future feature needs a different shape, it can add a new endpoint without breaking this one.

**Implementation:** No changes required. Status quo is the chosen design.

## Open Concerns

1. **Payload size in pathological cases:** If `agentStream` contains 100K+ events, JSON payload could exceed 1-5MB. For local single-user this is acceptable, but needs monitoring. **Mitigation:** Document the limitation; add pagination support if observed.

2. **Database lock contention during execution:** During running attempts, `agent_execution_details` is written frequently. Concurrent reads may block. **Mitigation:** The current code mitigates via `last_heartbeat_at` index; no change needed.

3. **No explicit versioning of payload shape:** Schema changes (new columns) change API response shape silently. **Mitigation:** Dashboard already uses defensive access patterns; this is standard API hygiene.

4. **Sub-agents payload opaque:** `subAgents` is unparsed JSON; could inflate size significantly if deep nesting. **Mitigation:** If deep nesting becomes a problem, add `/details/sub-agents?limit=100` pagination in a follow-up.

5. **Prompt content not included:** The brief asks for "prompt content" but the response does not include it. **Clarification needed:** Does the dashboard need to display the full prompt text?

---

# Phase 2: Critique

## Verdict

**REVISE** — The design rationale is sound for the stated brief (local single-user), but the chosen design makes problematic assumptions about growth and operational stability that conflict with the stated constraint that "the dashboard may issue dozens of requests per minute." The chosen design will become operationally difficult once: (a) attempts routinely exceed 1-2MB in size, or (b) the system is embedded in higher-latency contexts (remote dashboards, CI/CD integrations, or Registry federation). The design is not *wrong*, but it is **premature**, and Alternative 3 (projection) is the production choice for this codebase.

## Issues

### 1. **CRITICAL: Assumed use context is not the brief's actual use context** (Severity: High)

The proposal asserts "Deployment is local, single-user, no bandwidth pressure" but the brief's actual constraint is "may be called dozens of times per minute as the user clicks around."

"Dozens of times per minute" implies: rapid dashboard navigation, automated integrations (CI/CD logs, analytics), or future Registry federation. Under rapid repetition, monolithic fetch becomes a liability—user clicks "Usage" tab: 200KB fetch for 500 bytes needed. Multiplied over dozens of clicks: wasteful transfer, wasted memory, wasted I/O.

**Recommendation:** If Alternative 1 is kept, add a comment documenting the assumption: "This endpoint returns full payload without filtering. Acceptable for local deployment but needs projection support if: (a) attempts exceed 2MB, or (b) integration into remote/CI dashboards."

### 2. **The trace missed the "re-polling" use case** (Severity: Medium)

The trace assumes: user loads page once, clicks tabs. Reality: a running attempt is continuously written to. Dashboard may re-fetch every few seconds to see updated `agentStream` and `compactEvents`.

Over 60 seconds with 10 refreshes: Alt 1 transfers 2MB while Alt 3 transfers 500KB (4x savings). Re-polling is a common pattern in interactive dashboards, and the design does not explicitly support it.

**Recommendation:** Acknowledge this use case. If re-polling is a planned feature, Alternative 3's projection support becomes strategically important, not just "future-proofing."

### 3. **The rejection of Alternative 3 is under-justified** (Severity: High)

The proposal dismisses Alt 3 as "modest complexity" that creates "unpredictable payload shape," but:

- Current route is already hand-written SQL with 13 explicit column selects
- Adding `?include` filtering is trivial: parse query param, build SELECT filter, return `Partial<AttemptDetailsPayload>`
- "Unpredictable shape" is already solved: dashboard uses `as DetailsPayload` cast and defensive field access

The proposal chose Alt 1 because "dashboard is already optimized for this shape." But the dashboard is **already compatible with Alt 3** (just return whatever fields are present). The implementation cost is ~40 lines, and the payoff for future consumers (Registry, CI/CD, analytics) is significant.

**Recommendation:** Reconsider Alternative 3 as the chosen design. Implementation cost is lower than acknowledged; future-proofing is more valuable because Registry and CI integration are stated product roadmap items.

### 4. **Concern #6 (prompt content) is not minor** (Severity: Medium)

The brief explicitly asks for "prompt content." The current route omits it. The `agent_execution_details` table has `prompt_content` column, but the SELECT does not include it.

The proposal notes this is a "simple SELECT column addition" but then defers the question. **This is unresolved.** Either add it to the response, or update the brief to remove it from requirements.

**Recommendation:** Clarify with product owner: does dashboard need to display the full prompt text? If yes, add it. If no, update brief to reflect reality.

### 5. **No pagination / streaming for large payloads** (Severity: Medium)

Concern #1 mentions "100K+ events, 1-5MB payload" and suggests CONFIG mitigation. But the actual implementation does nothing:

```typescript
return c.json({
  ok: true,
  details: {
    agentStream: safeParseArray(row.agent_stream_json), // <-- no limits
    ...
  }
});
```

In production, a 1MB JSON response ties up SQLite connection, Hono's response buffer (may OOM), times out on slow networks. The proposal says this is "acceptable" but doesn't implement the mitigation.

**Recommendation:** Either (a) implement CONFIG option to warn/truncate, or (b) add pagination support (`?agent_stream_offset=1000&agent_stream_limit=100`).

### 6. **The trace assumes parallelized fetches for Alt 2 without costing it** (Severity: Low)

The trace says "Alt 2: 6 fetches in parallel (if dashboard uses Promise.all)." This sidesteps the fact that Alt 2 *requires* the dashboard to implement parallelization. If fetches are sequential or browser-constrained, Alt 2's latency degrades dramatically.

This architectural complexity is a **real cost** not made visible in the proposal.

## Re-examined Alternatives

### Alternative 2 Reconsidered: Multi-Endpoint

The proposal rejected Alt 2 on "waterfall latency" and "dashboard complexity." But:

**If dashboard uses Promise.all:**
- First load latency: 1 RTT + slowest query (negligible difference from Alt 1)
- Rapid tab switching: 95% payload savings for "Usage" click
- Re-polling: 60-70% savings by fetching only status + agentStream
- Future integrations: fetch only cost + model, no unused arrays

**Dashboard complexity in practice:**
- React is already managing 5 tabs; 6 endpoints = 6 more useState hooks
- Fetch errors: already handled by try/catch; one more per endpoint is linear
- Cache: browser HTTP cache + React state cache already designed for this

**Verdict on Alt 2:** Stronger than proposal suggests. Requires API proliferation if new consumers arrive, making Alt 3 preferable.

### Alternative 3 Reconsidered: Projection

The proposal dismisses Alt 3 as adding complexity. But implementation is trivial:

```typescript
const include = c.req.query("include")?.split(",") ?? [];
const fieldsToReturn = include.length
  ? ALLOWED_FIELDS.filter(f => include.includes(f))
  : ALLOWED_FIELDS;
const selectCols = fieldsToReturn.map(f => colMap[f]).join(", ");
const row = db.prepare(`SELECT ${selectCols} FROM agent_execution_details WHERE attempt_id = ?`).get(attemptId);
// Return Partial<AttemptDetailsPayload>
```

**Implementation cost:** ~40 lines. **No new dependencies. Backward-compatible.** The "unpredictable shape" risk is **manageable**—dashboard already defensive.

**Verdict on Alt 3:** Significantly lighter than proposal suggests. Straightforward, low-risk, high-upside for future consumers.

## Stress Test

### Scenario 1: CI/CD Integration

Future CI/CD queries endpoint for only cost + token breakdown:

- **Alt 1:** Fetches 200KB (unused tool calls, stream), extracts 3 fields. **Wasteful, slow on CI runners.**
- **Alt 2:** Hits `/details/usage`. 500 bytes. **Perfect but requires dedicated endpoint.**
- **Alt 3:** Hits `?include=costUsd,tokenInput,tokenOutput,model`. 500 bytes, one endpoint. **Elegant.**

**Verdict:** Alt 3 wins.

### Scenario 2: Remote Dashboard (Registry Federation)

Registry allows sharing pipelines across machines. Remote dashboard queries another machine's kernel-next:

- **Alt 1:** 200KB on WAN (50-100ms RTT). Every click costs 200KB × latency. **User experience degrades.**
- **Alt 2:** 6 parallel small fetches. 1 RTT, <10KB total. **Fast.**
- **Alt 3:** One fetch with `?include=toolCalls,agentStream`. 50KB, 1 RTT. **Acceptable.**

**Verdict:** Alt 2 wins; Alt 3 close. Alt 1 unusably slow.

**Critical insight:** Proposal assumes "local deployment" dismissing WAN. But Registry is stated feature—WAN access is inevitable. Alt 3's projection is **essential infrastructure** for product roadmap.

### Scenario 3: Extremely Large Attempt (100K events)

Multi-hour agent task: 100K events, 5MB stream:

- **Alt 1:** Returns 5MB JSON. Browser parses 5MB, freezes 1-2s. **Unacceptable UX.**
- **Alt 2:** Fetch `/details/usage` (500 bytes), lazy-load tool calls. **Works, requires pagination logic.**
- **Alt 3:** Fetch with `?include=usage,agentStream&agentStream_limit=1000`. **Works, requires pagination extension.**

**Verdict:** Alt 2/3 with pagination win. Alt 1 fails catastrophically.

**Critical insight:** This is not theoretical—multi-hour agent tasks generate large streams. Design should explicitly plan for pagination or document the limitation.

### Scenario 4: High-Frequency Re-polling (Attempt Running)

Dashboard 5-second refresh over 5 minutes (60 requests):

- **Alt 1:** 60 × 200KB = 12MB. **Wasteful but fine on localhost.**
- **Alt 2:** 60 × 20KB (status + messages) = 1.2MB. **5x savings.**
- **Alt 3:** 60 × 50KB (with `?include=agentStream,statusHistory`) = 3MB. **4x savings.**

**Verdict:** Alt 2/3 win significantly. Alt 1 inefficient but functional.

**Critical insight:** Re-polling is common in dashboards. Design doesn't support it explicitly; stress test shows significant bandwidth waste.

## Recommendations

### 1. **Choose Alternative 3 (Projection) as the baseline**

Support optional field inclusion/exclusion via query params. Implementation: ~40 lines. Upside:
- Backward-compatible (no params = full payload)
- Composable (future consumers specify what they need)
- Supports re-polling without waste
- Prepares for Registry federation (WAN efficiency)

**Proposed API:**
```
GET /api/kernel/attempts/:attemptId/details
GET /api/kernel/attempts/:attemptId/details?include=costUsd,model,sessionId
GET /api/kernel/attempts/:attemptId/details?include=agentStream&exclude=compactEvents
```

Dashboard works unchanged (no params, gets full payload). Future consumers bandwidth-efficient.

### 2. **Add pagination escape hatch for large streams**

For attempts with >10K events, support pagination:
```
GET /api/kernel/attempts/:attemptId/details?include=agentStream&agentStream_offset=0&agentStream_limit=1000
```

Design into response schema now (e.g., `metadata: { agentStreamTotal, agentStreamReturned }`). Concern #1 identifies this as real; design should plan for it rather than defer indefinitely.

### 3. **Clarify and include prompt content**

Brief asks for "prompt content." Current route omits it. Either:
- Add `prompt_content` to SELECT and response, OR
- Update brief to remove it from requirements

Do not leave this ambiguous.

### 4. **Document the WAN assumption**

Add comment documenting performance characteristics:

```typescript
// This endpoint returns full payload without filtering. Performance assumptions:
// - Local deployment: 200KB responses, 1-2ms SQL query, acceptable latency
// - WAN / Registry federation: use ?include= projection to reduce payload
// - Large attempts (100K+ events): pagination support (future work)
```

Makes implicit assumptions explicit for future maintainers.

### 5. **If Alternative 1 is kept, document re-polling inefficiency**

Add note in dashboard component:

```typescript
// TODO: This fetches full attempt details (including unused fields)
// on every tab click. For large attempts, use projection (?include=...)
// to reduce bandwidth/parsing. See kernel-attempt-details.ts.
```

Creates visible debt item for optimization.

## Summary

The chosen design (Alternative 1, monolithic endpoint) is **not wrong for the stated brief** (local single-user), but it makes assumptions that conflict with stated product direction (Registry, CI/CD integrations, high-frequency re-polling). The design will become a bottleneck once embedded in higher-latency contexts or supporting large attempts.

**The recommended choice is Alternative 3 (projection)** because:
1. Implementation cost is lower than acknowledged (~40 lines)
2. Upside is higher than acknowledged (Registry integration, WAN efficiency, composability)
3. Risk of "unpredictable shape" is lower than claimed (dashboard already defensive)
4. Backward-compatible with current dashboard (no breaking changes)

The monolithic endpoint can be kept as default behavior (no params), but adding projection support makes the API production-ready for future expansion without breaking changes.
