# API Design Critique

## Verdict

**REVISE** — The tabbed sub-resource approach is sound and correctly prioritizes selective polling for the "dozens per minute" use case. However, three material gaps must be resolved before shipping: (1) hot-update cache invalidation is unspecified and exposes stale-data risks; (2) browser connection pool saturation is acknowledged but unaddressed; (3) error handling per tab is undefined. These are not hypothetical—they follow directly from the requirements and the kernel-next platform constraints.

## Issues

1. [CRITICAL] **Hot-update cache invalidation unspecified** — The design assumes stream/tools/cost are immutable after attempt completion and can be cached forever. But kernel-next supports hot updates and migrations (mentioned in apiBrief context). If a running or recently-completed attempt is superseded by a hot update, clients with cached responses will serve stale data indefinitely. The 410 Gone response for superseded attempts only helps if the client proactively refetches; it doesn't invalidate existing browser cache. The design must either: (a) include a version/generation hash in metadata so clients can detect invalidation; (b) use conditional cache headers (ETag) to force revalidation; or (c) clarify that "immutable" applies only to completed, non-superseded attempts and running attempts should never be cached.

2. [MAJOR] **Browser connection pool saturation unaddressed** — Modern browsers allow ~6–8 concurrent connections per domain. The initial load fires 5 parallel requests (metadata + 4 tabs). For "dozens of calls per minute," users clicking between different tasks would immediately hit saturation, causing tab clicks and metadata fetches to queue. The proposer identifies this as open concern #1 but offers no mitigation. Solution: specify an initial-load strategy (e.g., metadata + stream on first fetch, lazy-load tools/cost/transcript on tab click; or metadata-only, then lazy-load all tabs) to reduce concurrent requests.

3. [MAJOR] **Per-tab error handling undefined** — If `/tools` returns 500 while `/stream` succeeds, the design doesn't specify how the client behaves. Should it: show an error state in the tools tab? Hide the tab? Retry with backoff? Assume tools data is in the stream? This matters for production—a dashboard with 4/5 tabs working is worse than one that fails cleanly.

4. [MAJOR] **Stream polling bandwidth not optimized** — The design acknowledges concern #2 (stream polling at 2–5 sec intervals, 50–200 KB each) but doesn't solve it. For a 100-event trace, refetching all events every 2 sec just to see 2 new ones is inefficient. The brief allows Hono + node:sqlite (no new dependencies), so implementing delta/patch streaming (e.g., `/stream?since=<sequenceId>` returning only new events) is feasible. Without this, you're trading simplicity for bandwidth that may matter on slower connections.

5. [MAJOR] **Sub-agent transcript discovery mechanism missing** — The `/transcript` endpoint is optional (returns 204 No Content if no sub-agent). The client must either: (a) try the request blindly (wastes one request per attempt); (b) check a `has_transcript` boolean in metadata (adds schema complexity); or (c) try it and cache 204 (not semantic). The design doesn't specify which. This is a small scope but a real ambiguity.

6. [MINOR] **Metadata cache header strategy incomplete** — Design specifies 10-sec cache for metadata, which is correct for running attempts. But for completed attempts, metadata is immutable and should cache indefinitely (or for hours). The design doesn't mention conditional cache headers (`Cache-Control: max-age=10 for status=running` vs. `Cache-Control: max-age=31536000 for status=completed`). Without this, completed attempts refetch their metadata every 10 sec uselessly.

7. [MINOR] **Prompt content endpoint missing or unclear** — The brief explicitly requires fetching "prompt content," but none of the 5 endpoints are described as returning the full prompt. Presumably it's an event in the `/stream` response, but this should be called out. Consider: should there be a dedicated `/prompt` endpoint, or is embedding in stream acceptable? This is a small gap but the brief lists it explicitly.

8. [NIT] **Initial load parallelization strategy vague** — The design suggests "five parallel requests, each KB-scale" but doesn't specify whether all 4 tabs are fetched on initial load or only on tab click. Guidance needed: which tabs are critical (stream + metadata?), which are lazy-loaded? This affects both connection pool load and perceived latency.

## Re-examined Alternatives

**Single Unified Endpoint** — Proposer rejected it on grounds that "refetching 50–500 KB to switch tabs is wasteful" with dozens of calls per minute. The rejection is *partially* sound but overweights a specific use pattern. The traced use cases show:
- Case #2 (tab switching) favors tabbed design.
- Cases #1, #3, #4 don't require constant tab switching; they benefit from or are neutral on unified endpoint.

The proposer's efficiency argument assumes users constantly switch tabs; the use-case analysis doesn't validate this as the dominant pattern. **Unified endpoint might actually be better** because it: eliminates connection pool risk entirely, simplifies cache logic (one response, one cache key), avoids transcript discovery ambiguity, and removes per-tab error handling complexity. The trade-off is bandwidth on tab switches—real, but not necessarily dominant. **Verdict: Rejection is reasonable but not definitive. This deserved deeper analysis.**

**Query-Parameter Selection** — Proposer rejected it for "adding complexity (parsing, conditional serialization) without benefit." This is dismissive. Query params would: avoid connection pool saturation, simplify caching (one cache key per query set), sidestep transcript discovery (metadata can include which fields are available), and enable flexible client strategies (?include=metadata,stream for initial load, ?include=tools for cost tab click). Parsing `?include=stream,tools` is one `.split(',')` call in Hono—not a new dependency. **Verdict: Rejection is weak. Query params are a viable alternative and might be better.**

**HAL/HATEOAS** — Rejection is sound (extra request hop adds latency on initial load).

**WebSocket** — Rejection is sound (overkill for single-user local deployment, harder to reason about).

## Stress Tests

**Scenario 1: Hot update during polling** — User opens dashboard, polled stream tab. Attempt is running. After 10 sec, a hot update migrates the task; the attempt is now marked superseded. Browser cache still holds the stream endpoint cached (immutable, cache forever). On next poll, browser serves 304 Not Modified from cache instead of fetching fresh data. Client never sees 410 Gone. User's dashboard shows data from a superseded attempt indefinitely. **Revealed gap: cache invalidation strategy for hot updates.**

**Scenario 2: Multiple browser tabs, each with dashboard** — User has 3 Claude Code sessions open, each running the kernel-next dashboard on the same task. Each dashboard polls metadata every 10 sec + one active tab every 2–5 sec. Three metadata + three tab requests per poll cycle = 6 requests / 10 sec = 0.6 req/sec baseline. Add rapid tab switching (3 clicks/sec × 5 requests/click = 15 req/sec) and browser hits 8-connection limit, queuing requests. **Revealed gap: connection pool strategy unspecified.**

**Scenario 3: Server error on `/tools` endpoint** — Metadata, stream, cost all succeed; `/tools` returns 500 due to database lock. Client UI now shows 4/5 tabs with data, tools tab blank or errored. No guidance on graceful degradation. **Revealed gap: per-tab error handling undefined.**

**Scenario 4: Attempt with 500 KB stream, slow network** — Client on 2G (20 KB/sec) opens dashboard. Stream tab takes 25 sec to load while metadata (0.5 sec) populates other tabs. User sees full tab headers but can't view stream for 25 sec. Design doesn't specify sequential vs. parallel fallback strategy. **Revealed gap: no degradation strategy for saturated connections.**

**Scenario 5: Transcript discovery ambiguity** — Client has no way to know if `/transcript` endpoint will return 204 or 200. It can: (a) try and handle 204 (adds request); (b) assume every attempt has one and show error if missing (bad UX); (c) check metadata for hint (adds schema). **Revealed gap: transcript discovery mechanism missing.**

## Recommendations

1. **Add hot-update invalidation strategy**: Include a `versionHash` or `supersededAt` field in metadata endpoint. Clients should use ETags or check if versionHash changed before trusting cached sub-resources. Document that immutability applies only to non-superseded completed attempts.

2. **Specify initial-load strategy**: Define which endpoints are critical on first load (e.g., metadata + stream) and which are lazy-loaded on tab click. This reduces concurrent requests and avoids connection pool saturation.

3. **Define per-tab error handling**: Specify behavior for 500/503/network errors per tab: retry strategy, timeout, degradation mode, error messaging.

4. **Pick transcript discovery mechanism**: Add `has_transcript` boolean to metadata endpoint, or document that 204 No Content is the discovery signal.

5. **Add conditional cache headers**: Specify different `Cache-Control` headers for running (short TTL) vs. completed attempts (long TTL or immutable).

6. **Consider delta/patch streaming for `/stream`**: Optional but worth evaluating. Implement `/stream?since=<lastEventId>` to fetch only new events. Requires one additional query parameter but dramatically reduces bandwidth on repeated polls.

7. **Clarify prompt endpoint**: Document whether prompt content is embedded in `/stream` as an event, or if a dedicated `/api/tasks/:taskId/attempts/:attemptId/prompt` endpoint is needed.
