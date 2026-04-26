# API Design Critique

## Verdict

**REVISE** — The design is fundamentally sound and implementable, but the analysis under-justified the choice against rejected alternatives. Re-examination reveals that Alternative B (multiple tab-focused endpoints) may actually cache more efficiently for in-flight attempts, and Alternative D (summary + lazy-load) is more payload-efficient for multi-attempt browsing. The brief explicitly permits "one fetch per tab," so the proposer's confidence in single-endpoint superiority is not warranted. With revisions (especially transcript optionality and stream bounds), the design is viable; without them, reconsidering Alternative B is necessary.

## Issues

1. **[MAJOR]** Caching analysis incomplete. In-flight attempts with growing streams defeat HTTP caching on the monolithic endpoint because each new event changes the response. Alternative B's per-endpoint granularity allows immutable fields (tools, costs, prompt) to return 304 Not Modified while streams remain cacheable only by last-event-time. No evidence provided that Alt A caches better.

2. **[MAJOR]** Transcript always included despite brief marking it "optional." If sub-agent transcript is large (100KB+) and users rarely click the transcript tab, every click downloads it unconditionally. No mechanism to avoid this.

3. **[MAJOR]** Stream size unbounded. Brief does not specify maximum event count or payload size. An attempt with many logged events could produce a multi-megabyte response, defeating the efficiency assumption of "dozens of clicks/minute."

4. **[MINOR]** Error cases undefined. Response contract for missing attempts, in-flight vs. finished, and failed attempts not specified. Leaves implementation ambiguous and complicates client handling.

5. **[MINOR]** Server-side caching strategy absent. Node:sqlite has a single writer; dozens of queries/minute to the same endpoint means redundant SQLite queries for immutable in-flight data. No invalidation strategy proposed for when attempt state changes.

## Re-examined Alternatives

### Alternative B: Multiple Tab-Focused Endpoints

**Proposer's rejection:** "Each tab switch = new fetch... slower experience."

**Verdict: Rejection was unsound.** 

HTTP/2 multiplexing and caching undermine this reasoning:
- A cached endpoint returns 304 Not Modified in ~10ms, effectively instant.
- Proposer conflated "making a request" with "slow" without accounting for cache hits.
- Brief explicitly states "one fetch per tab is fine," indicating the requirement permits this.

**Critical advantage over Alt A:** In-flight attempts with growing streams naturally resist caching on a monolithic endpoint (stream changes → response changes → no 304). With Alt B, immutable fields like tools and costs CAN be cached (304 after first fetch), while streams—which inherently grow—remain separate. This is more cache-efficient.

**Stress test evidence:** Multi-attempt rapid switching reveals Alt B's payload efficiency. User views 5 attempts, clicking each once: Alt A fetches full payload per click (including always-included transcript); Alt B fetches only endpoints that haven't been cached. A single `/tools` endpoint might even be reused across attempts if tools are similar (unlikely but possible).

**Conclusion:** Alt B deserves reconsideration. It is at minimum equivalent to Alt A, and likely superior for in-flight streams.

### Alternative D: Summary + Lazy-Load Details

**Proposer's rejection:** "Two requests, but summary is lightweight... slower than A."

**Verdict: Rejection was premature.**

Latency argument is weak:
- Two SQLite queries on local hardware: ~5ms each. Negligible UX impact.
- Brief permits "one fetch per tab," which this pattern uses.

**Advantage in multi-attempt browsing:** If user views 5 attempts and clicks into 1–2 tabs per attempt:
- Alt A: 5 × (50KB stream + 5KB tools + 1KB prompt + 500KB transcript) = 2.8 MB.
- Alt D: 5 × (0.5KB summary) + selected tabs = ~2.5 KB + ~55KB = negligible.

Payload efficiency is 50× better for typical multi-attempt workflows.

**Conclusion:** Alt D was dismissed without payload analysis. For the stated use case ("clicks around," implying multiple attempts), it may be optimal.

## Stress Test: In-Flight Attempts with Growing Streams

**Scenario:** User opens attempt details while the attempt is still running. Stream starts with 10 events. User clicks to list and back repeatedly over 30 seconds as stream grows to 100 events.

**Alt A result:** Each click refetches the full response. Stream is growing, so response changes every second; no HTTP cache hits on the main endpoint. If transcript is unconditionally included (500KB), it's downloaded on every click. Payload: 5 clicks × 500KB+ = 2.5 MB+ wasted on transcript alone.

**Alt B result:** `/stream` endpoint grows, no cache hits (unavoidable). But `/tools`, `/costs`, `/prompt` endpoints are immutable once stream finishes and CAN return 304. Transcript endpoint only fetched if user clicks tab (optional). Per-endpoint granularity avoids forced re-downloading of immutable data.

**Verdict:** Alt A fails gracefully but inefficiently; Alt B is superior.

## Stress Test: Multi-Attempt Rapid Context Switching

**Scenario:** User has sidebar of 5 recent attempts. Clicks rapidly (A → B → A → C → B) over 1 minute, viewing each for 3 seconds.

**Alt A result:** Every click loads full attempt. If browser cache is limited, LRU eviction on repeated attempts causes re-downloads. Transcript always included. Total payload: potentially 5+ × 500KB+.

**Alt D result:** Summary endpoints are small (~500B each) and shared. Only fetch detailed tabs that user actually clicks. For this scenario, might fetch just 2–3 tab endpoints across 5 attempts. Payload: ~2.5KB summary + ~55KB details = vastly smaller.

**Verdict:** Alt D is strongest for this use case; Alt B competitive; Alt A weakest.

## Recommendations

If revising:

1. **Make transcript optional:** Add `?includeTranscript=true` querystring; default to false. (Addresses one of proposer's own concerns.)

2. **Bound stream size:** Truncate to last 1000 events; include a link to full stream if longer. Prevents unbounded responses and makes caching viable.

3. **Strongly reconsider Alternative B:**
   - Evidence: per-endpoint caching is superior for mixed-mutable data (streams + immutable tools/costs).
   - Brief permits multiple fetches; HTTP/2 makes this efficient.
   - Stress tests show it's competitive or superior for likely workflows.
   - Proposal: adopt Alt B unless latency testing proves 304 responses are too slow (unlikely).

4. **Define error cases:** Specify HTTP status and response shape for: missing attempt (404), in-flight attempt (200 with state), failed attempt (200 with error or 500?), finished attempt (200). Clarify whether in-flight responses include partial data or wait for completion.

5. **Server-side caching:** For in-flight attempts, cache responses for 10s with invalidation on state change. Reduces SQLite query load.

**Convergence:** If Alt A is adopted with these revisions (especially transcript optionality + stream bounds), it is viable. If these revisions are rejected, reconsidering Alt B is necessary before ship.
