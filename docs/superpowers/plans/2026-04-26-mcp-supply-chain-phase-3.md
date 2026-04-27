# MCP Supply Chain — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the `pipeline-generator` from PulseMCP-based MCP discovery to the local catalog, so generated pipelines reach for tools the user can actually install via Phase 2's inventory.

**Architecture:** Mostly prompt + IR edits. The `analyzing` stage's prompt directs Claude to call `recommend_mcp_servers` (Phase 1 MCP tool); `genSkeleton` directs Claude to call `get_mcp_catalog_entry(id)` for each recommendation and emit the `mcpServers` block from the catalog entry. The `recommendedMcps` port shape gains an `entryId` + `reason` field per recommendation. The `awaitingConfirm` gate UI (`gate-card.tsx`) gains a "Recommended Tools" section that maps the gate's upstream `recommendedMcps` value to inventory status (via Phase 2's `lookup-by-envkey` + `InventoryBanner`-style rendering) so the user can click "前往装备" before approving.

**Tech Stack:** Same as Phase 2 — TypeScript, vitest, React, Next.js, Tailwind, Hono.

**Spec reference:** `docs/superpowers/specs/2026-04-26-mcp-supply-chain-design.md` §§ 7.1, 7.2, 7.3, 7.4 (backwards compatibility).

---

## Important pre-flight finding (from inspection)

When writing this plan I read the current state of `apps/server/src/builtin-pipelines/pipeline-generator/`. Three things diverge from the spec's assumptions:

1. **`recommendedMcps` port type is already `object[]` and the analysis.md prompt already emits structured `{ name; command; args; env?; envKeys }` per entry** — not loose strings. The spec said "loose strings → structured", but the current shape is *already* structured; what's missing is `entryId` + `reason`.

2. **The `analyzing` stage has NO `mcpServers` config block today.** The prompt instructs the model to call PulseMCP, but PulseMCP is never wired in. The model has been hallucinating MCP server definitions from training data. Recommend: drop PulseMCP language; use `recommend_mcp_servers` (already accessible via `__kernel_next__`, the auto-injected kernel MCP).

3. **`__kernel_next__` is auto-injected into every agent stage by `real-executor.ts:494`** — Phase 1's `recommend_mcp_servers` and `get_mcp_catalog_entry` are already callable from any agent stage. No `mcpServers` config addition needed for prompt access; only prompt text changes.

So Phase 3 is **prompt + port-shape + UI**, not a runtime/IR-config rewrite.

---

## Out of scope for Phase 3

These belong to later iterations and **must NOT be built here**:

- Embedding-based recommendation (§10)
- Real secret-validity verification by calling the MCP (§10)
- Background periodic health check (§10)
- Encryption key rotation (§10)
- "Remote HTTP MCP via mcp-remote bridge" auto-classification (current prompt already covers this; the catalog only stores stdio/npx for v1 entries — recommend_mcp_servers will simply not return remote-HTTP servers; keep the prompt's existing fallback language for those cases unchanged)
- New catalog entries authored as part of this plan (catalog already seeds 12 entries; Phase 3 changes only how the model uses them)

If a task below seems to imply any of these, it's mis-scoped and should be deferred.

---

## File map

**Modified files (server, 4):**

```
apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json
  # Add `entryId` + `reason` to the `recommendedMcps` port type signature in 4 stages
  # (analyzing.outputs, awaitingConfirm.inputs—wait, that stage has no inputs—skip;
  #  genSkeleton.inputs, genPrompts.inputs, persisting.inputs)

apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md
  # Replace PulseMCP-based discovery with recommend_mcp_servers MCP tool
  # Update mcpServers format docs to include entryId + reason

apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md
  # Update "Wiring recommendedMcps into agent stages" section so it explains
  # using get_mcp_catalog_entry to fetch authoritative server defs

apps/server/src/__regression__/                  # — none; pipeline-generator has no test
                                                 #   suite that asserts prompt content; we
                                                 #   add a fresh one in Task 4
```

**New files (server, 1):**

```
apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.test.ts
  # Verifies the IR's `recommendedMcps` port type signature contains `entryId`
  # and `reason`, so any future spec drift is caught.
```

**Modified files (web, 2):**

```
apps/web/src/components/gate-card.tsx
  # When a port named `recommendedMcps` appears in the upstream outputs,
  # render a "Recommended Tools" sub-section that fetches inventory for
  # each entryId and shows an "前往装备" deep link when not equipped.

apps/web/src/components/recommended-mcps-card.tsx  (NEW)
  # The new sub-component for the gate; isolates the inventory-aware
  # rendering so gate-card.tsx stays a thin layout shell.
```

---

## Conventions to mirror

- **Prompt edits**: keep total length within ±20% of current. Don't add new sections; replace existing PulseMCP language in place.
- **IR edits**: 4 places repeat the same `recommendedMcps` port type. They MUST stay synchronized — search-and-replace, then verify all 4 hits still parse.
- **Port type literal**: use the TS-style literal `Array<{ entryId: string; name: string; command: string; args: string[]; env?: Record<string, string>; envKeys: string[]; reason: string }>` (the existing `name/command/args/env/envKeys` set carries forward; we add `entryId` and `reason`).
- **Tests**: vitest. Component tests for gate-card extension follow existing patterns under `apps/web/src/components/*.test.tsx`.
- **No regression on Phase 2 tests**.

---

## Branch + setup

This plan is to be executed on branch `feature/mcp-supply-chain-phase-3` (already created off `main` after the Phase 2 merge). Each task ends with a single commit. After Task 5 the branch is merged to `main` via `superpowers:finishing-a-development-branch`.

Commit messages follow `feat(mcp-supply-chain-3): <one-line>` / `fix(mcp-supply-chain-3): T<N> review followups`.

---

### Task 1: Update `recommendedMcps` port type in pipeline.ir.json

**Why first:** every prompt edit in Tasks 2-3 references this shape. Lock the structure first.

**Files:**
- Modify: `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json`
- Create: `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.test.ts`

The IR has `recommendedMcps` declared in 4 places (line 53, 168, 259, 354 — verify with `grep -n '"name": "recommendedMcps"' pipeline.ir.json`). All four currently say `"type": "object[]"`. Replace each with the structured literal so the IR carries the same contract its prompts demand.

- [ ] **Step 1: Write failing test**

Create `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("pipeline-generator IR", () => {
  const irPath = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "pipeline.ir.json");
  const ir = JSON.parse(readFileSync(irPath, "utf8")) as {
    stages: Array<{
      name: string;
      inputs?: Array<{ name: string; type: string }>;
      outputs?: Array<{ name: string; type: string }>;
    }>;
  };

  const expectedType =
    "Array<{ entryId: string; name: string; command: string; args: string[]; env?: Record<string, string>; envKeys: string[]; reason: string }>";

  it("analyzing.outputs.recommendedMcps has structured type", () => {
    const stage = ir.stages.find((s) => s.name === "analyzing");
    const port = stage?.outputs?.find((p) => p.name === "recommendedMcps");
    expect(port?.type).toBe(expectedType);
  });

  it("genSkeleton.inputs.recommendedMcps has structured type", () => {
    const stage = ir.stages.find((s) => s.name === "genSkeleton");
    const port = stage?.inputs?.find((p) => p.name === "recommendedMcps");
    expect(port?.type).toBe(expectedType);
  });

  it("all 4 recommendedMcps ports across the pipeline share the same type", () => {
    const ports: Array<{ stage: string; type: string }> = [];
    for (const stage of ir.stages) {
      for (const p of [...(stage.inputs ?? []), ...(stage.outputs ?? [])]) {
        if (p.name === "recommendedMcps") ports.push({ stage: stage.name, type: p.type });
      }
    }
    expect(ports.length).toBe(4);
    const distinctTypes = new Set(ports.map((p) => p.type));
    expect(distinctTypes.size).toBe(1);
    expect([...distinctTypes][0]).toBe(expectedType);
  });
});
```

Run: `cd apps/server && pnpm vitest run src/builtin-pipelines/pipeline-generator/pipeline.ir.test.ts`
Expected: FAIL — current type is `object[]`.

- [ ] **Step 2: Update pipeline.ir.json**

Find each occurrence of `"type": "object[]"` directly under a `"name": "recommendedMcps"` key (4 occurrences) and replace with:

```
"type": "Array<{ entryId: string; name: string; command: string; args: string[]; env?: Record<string, string>; envKeys: string[]; reason: string }>"
```

- [ ] **Step 3: Run test → 3 pass**

`cd apps/server && pnpm vitest run src/builtin-pipelines/pipeline-generator/pipeline.ir.test.ts`
Expected: 3 passed.

- [ ] **Step 4: Run pipeline-generator regression tests**

`cd apps/server && pnpm vitest run src/builtin-pipelines/pipeline-generator`
Expected: PASS — any other tests that load the IR continue to validate.

Also run a full submit-time regression on the IR:

`cd apps/server && pnpm vitest run src/__regression__ 2>&1 | tail -10` (if such a test directory exists; if not, skip)

- [ ] **Step 5: tsc**

`cd apps/server && pnpm exec tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json \
        apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.test.ts
git commit -m "feat(mcp-supply-chain-3): structure recommendedMcps port type with entryId+reason"
```

---

### Task 2: Update `analysis.md` prompt — drop PulseMCP, use recommend_mcp_servers

**Why now:** Task 1 locked the data shape; this task wires the analyzing stage to populate it from the catalog instead of imagining server definitions.

**Files:**
- Modify: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md`

The current `analysis.md` references PulseMCP in §Available tools (line 138-141), §Workflow step 7 (line 128 "Search PulseMCP..."), §Error handling (line 184), §Output recommendedMcps (line 199), §Verification discipline (line 257-263). Each of these lines must change so the model uses `recommend_mcp_servers` against the local catalog.

- [ ] **Step 1: Read the current analysis.md**

`cd apps/server && cat src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md`

(You should see ~263 lines. Note the line numbers cited in the plan are approximate; use grep to locate.)

- [ ] **Step 2: Edit lines around §Available tools**

Find:

```markdown
- PulseMCP (`mcps: [pulsemcp]`) — discover MCP servers relevant to the task. **Use this whenever the pipeline needs any external integration**. Your training data does not include MCP servers released or documented after your cutoff, and many vendors (Linear, Atlassian, Notion, Stripe, etc.) ship *remote HTTP* MCPs, not stdio packages. Do not fabricate server definitions from an imagined `@modelcontextprotocol/<service>` convention — that scope is narrow and does not auto-contain every third-party integration.
- npm registry — when a candidate stdio MCP is identified via search, verify the package actually exists before emitting it in `recommendedMcps`. A `404 Not Found` on `npm view <pkg>` means you are hallucinating; drop it and fall back to a verified alternative or PulseMCP's remote-URL entry.
- User interaction (`interactive: true`) — you may ask clarifying questions via `AskUserQuestion` when the description is ambiguous. Record your assumptions in `assumptions` for later user review at `awaitingConfirm` gate.
```

Replace with:

```markdown
- `recommend_mcp_servers(topic, withLLM?, maxResults?)` — discover MCP servers from the **local Flow catalog** (kernel MCP tool, exposed under `__kernel_next__`). Use this whenever the pipeline needs any external integration. The catalog is curated and pre-validated; entries returned here are guaranteed installable on the user's machine via Flow's inventory page. Pass `withLLM: true` for natural-language reranking when the topic is ambiguous; default to `withLLM: false` for deterministic results. Do NOT fabricate server definitions — emit only entries the catalog returns. If the catalog has nothing for a capability, record the gap in `assumptions` and move on.
- `get_mcp_catalog_entry(id)` — fetch the full catalog entry for a recommended id (used by downstream `genSkeleton` stage; rarely needed in this stage but available for verification). Returns the authoritative `command`, `args`, `envKeys`, etc.
- User interaction (`interactive: true`) — you may ask clarifying questions via `AskUserQuestion` when the description is ambiguous. Record your assumptions in `assumptions` for later user review at `awaitingConfirm` gate.
```

- [ ] **Step 3: Edit §Workflow step 7**

Find:

```markdown
7. (Optional) Search PulseMCP for relevant tools if the task benefits from specific MCPs.
```

Replace with:

```markdown
7. **Call `recommend_mcp_servers(topic=<a one-sentence keyword summary of the user's task>)` once.** Read the recommendations and decide which entries materially help this pipeline (an entry returned by the recommender is a candidate, not a mandate). For each accepted entry, write one row into `recommendedMcps` with the entry's id, name, command, args, env, envKeys verbatim from the recommender's response (or a follow-up `get_mcp_catalog_entry(id)` call if you need the full envKeys list — the recommender's response may omit some entry fields). Add a `reason` string explaining in one sentence why this entry helps the pipeline.
```

- [ ] **Step 4: Edit §Output `recommendedMcps` line**

Find:

```markdown
- `recommendedMcps: Array<{ name: string; command: string; args: string[]; env?: Record<string, string>; envKeys: string[] }>` — structured MCP server definitions discovered via PulseMCP search (see §mcpServers format below).
```

Replace with:

```markdown
- `recommendedMcps: Array<{ entryId: string; name: string; command: string; args: string[]; env?: Record<string, string>; envKeys: string[]; reason: string }>` — structured MCP server definitions sourced from the Flow catalog via `recommend_mcp_servers` (see §mcpServers format below). `entryId` is the catalog id (kebab-case, used by `genSkeleton` to fetch the full entry). `reason` is a one-sentence rationale shown to the user at `awaitingConfirm` for review.
```

- [ ] **Step 5: Replace §mcpServers format section**

Find the section header:

```markdown
### mcpServers format (for `recommendedMcps` port)
```

…and the entire section through the end of the file (it has subsections "Sample A", "Sample B", "Field rules", "Verification discipline"). Replace it ALL with:

```markdown
### mcpServers format (for `recommendedMcps` port)

Each entry in `recommendedMcps` describes ONE MCP server from the Flow catalog. The fields you populate come straight from `recommend_mcp_servers`'s output — do not invent or alter them.

```json
{
  "entryId": "etherscan",
  "name": "etherscan",
  "command": "npx",
  "args": ["-y", "@scope/etherscan-mcp"],
  "env": { "ETHERSCAN_API_KEY": "${ETHERSCAN_API_KEY}" },
  "envKeys": ["ETHERSCAN_API_KEY"],
  "reason": "Verifies on-chain transaction hashes and contract source against Ethereum mainnet — needed for the Web3 due-diligence stage."
}
```

#### Field rules

- `entryId`: catalog id (kebab-case). Must equal what `recommend_mcp_servers` returned. `genSkeleton` will call `get_mcp_catalog_entry(entryId)` to fetch the full entry and place a `mcpServers` block on the appropriate downstream stage.
- `name`, `command`, `args`, `env`, `envKeys`: verbatim from the catalog. The `recommend_mcp_servers` response may include only `id` + `score` + `evidence` — if so, follow up with `get_mcp_catalog_entry(id)` to get these fields.
- `reason`: ONE sentence (60-200 chars) explaining why this MCP is in the recommendation. The user reviews this at `awaitingConfirm` and decides whether to accept the recommendation.

#### Discovery discipline

1. **Call once.** `recommend_mcp_servers` is local + deterministic. One invocation per analyzing pass is enough.
2. **Trust the catalog.** Entries returned by the recommender are pre-validated. Don't second-guess the package name or args. Don't run `npm view`.
3. **Reject irrelevance.** A returned entry isn't always relevant — read its `evidence.matchedUseCases` to decide whether the match is real. Drop entries whose match is weak (the score reflects keyword overlap; a cosine-1.0 match on "fetch" doesn't mean the user wants HTTP fetching).
4. **Never invent entries.** If the catalog has nothing relevant, the pipeline simply won't have MCPs for that capability. Record the gap in `assumptions`. Do not guess at server definitions from training data — Flow does not run servers that aren't equipped via the inventory.
5. **The user can add custom catalog entries.** If `assumptions` notes a missing capability, the user has the option to add a custom entry (via the catalog's web UI) and re-run; this loop is the expected escape hatch, not a fallback to imagination.
```

- [ ] **Step 6: Edit §Error handling**

Find:

```markdown
- If required MCPs/skills are not discoverable via PulseMCP, write what's found in `recommendedMcps` and explain the gap in `assumptions`.
```

Replace with:

```markdown
- If `recommend_mcp_servers` returns nothing relevant, leave `recommendedMcps` empty and record the gap in `assumptions` (e.g. "No on-chain verification MCP in the catalog; pipeline currently relies on free-text claims. User may add a custom catalog entry."). The user can then either add a custom entry via the catalog UI and re-run, or accept the gap.
```

- [ ] **Step 7: Verify the prompt parses + length is reasonable**

`wc -l apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md`
Expected: total length within ±20% of the original 263 lines.

- [ ] **Step 8: tsc**

`cd apps/server && pnpm exec tsc --noEmit` → clean.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md
git commit -m "feat(mcp-supply-chain-3): analyzing prompt — use recommend_mcp_servers, drop PulseMCP"
```

---

### Task 3: Update `gen-skeleton.md` prompt — fetch full entries via get_mcp_catalog_entry

**Why now:** with analyzing emitting `entryId` + `reason`, gen-skeleton needs to know how to consume those fields and place the right `mcpServers` block on the right stage.

**Files:**
- Modify: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md`

- [ ] **Step 1: Read the current §Wiring recommendedMcps section**

`grep -n "Wiring \`recommendedMcps\`\|recommendedMcps is \*\*authoritative\*\*\|Re-use the exact object shape" apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md`

The relevant section is around line 241-298 (use grep to find current line range).

- [ ] **Step 2: Replace the section**

Find the heading `## Wiring \`recommendedMcps\` into agent stages` and replace the entire section through the next top-level heading with:

```markdown
## Wiring `recommendedMcps` into agent stages

The `analyzing` stage produced `recommendedMcps` — an array of `{ entryId, name, command, args, env?, envKeys, reason }` entries from the Flow catalog. For each agent stage you emit, decide whether the stage needs any of these MCPs (read the stage's purpose / inputs / outputs against each entry's `reason` and capability). Attach the matching subset to the stage's `config.mcpServers`.

`recommendedMcps` is **authoritative for capability**. The user already approved these entries at the `awaitingConfirm` gate; you are merely deciding which stage uses which.

### Procedure

For each entry you decide to use:

1. Call `get_mcp_catalog_entry(entryId)` once. The full catalog entry has `command`, `args`, `envKeys[].name` etc.; the version inside `recommendedMcps` may be a slim copy.
2. Construct the IR `McpServerEntry` block:
   ```json
   {
     "name": "<entry.name>",
     "command": "<entry.command>",
     "args": [<...entry.args...>],
     "env": { "<envKey>": "${<envKey>}" },
     "envKeys": ["<envKey>", "..."]
   }
   ```
   The `env` field maps each declared envKey to the runtime `${VAR}` placeholder pattern. The kernel's expander (with the user's inventory layer, Phase 2) will resolve these at run time.
3. Attach the block to the agent stage's `config.mcpServers`. If two stages need the same entry, attach the SAME object to both.

### Rules

- **`entryId` is internal** to the analyzing-design path. Do NOT include `entryId` or `reason` in the IR's `McpServerEntry` — those are pipeline-design metadata only.
- **Do not invent entries.** If a stage needs a capability that is not in `recommendedMcps`, that's a gap — note it in `warnings` (a downstream port if your IR carries one; otherwise just leave the stage without `mcpServers`). Do not fabricate a server definition.
- **Omit `mcpServers` entirely** when a stage needs no external MCPs — do not emit an empty array.
- **Do not mutate `command` / `args` / `envKeys`** per-stage. The catalog entry is the source of truth.
- **Reserved names**: `name` matching `__*__` is reserved. The catalog enforces kebab-case ids that don't collide; verify by inspection if you're unsure.
- **No PulseMCP, no npm view, no scope-guessing.** Phase 2 deprecated those paths.

### Example

If `recommendedMcps` contains `{ entryId: "etherscan", reason: "verify on-chain claims" }` and your design has a stage `verifyOnchain` whose purpose is "validate transaction hashes against Ethereum mainnet", you'd attach:

```json
{
  "name": "verifyOnchain",
  "type": "agent",
  "config": {
    "promptRef": "system/verifyOnchain",
    "mcpServers": [
      {
        "name": "etherscan",
        "command": "npx",
        "args": ["-y", "@flow/mcp-etherscan"],
        "env": { "ETHERSCAN_API_KEY": "${ETHERSCAN_API_KEY}" },
        "envKeys": ["ETHERSCAN_API_KEY"]
      }
    ]
  },
  ...
}
```
```

- [ ] **Step 3: Verify length**

`wc -l apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md`
Expected: original was 314 lines; new total within ±15%.

- [ ] **Step 4: tsc**

`cd apps/server && pnpm exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md
git commit -m "feat(mcp-supply-chain-3): genSkeleton prompt — call get_mcp_catalog_entry for entry materialization"
```

---

### Task 4: gate-card "Recommended Tools" section — read `recommendedMcps` from the awaitingConfirm gate

**Why now:** the user needs to see which MCPs the pipeline is recommending, with their inventory status, BEFORE approving the gate. Spec §7.3.

**Files:**
- Create: `apps/web/src/components/recommended-mcps-card.tsx`
- Modify: `apps/web/src/components/gate-card.tsx`

The current `GateContextResponse.upstreams[].outputs[]` already carries the value of every output port written by upstream stages (gate-card.tsx:30-35). When the upstream is `analyzing` and one of its ports is named `recommendedMcps`, we render a special section.

- [ ] **Step 1: Create recommended-mcps-card.tsx**

```typescript
"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api-client";

export interface RecommendedMcpEntry {
  entryId: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  envKeys: string[];
  reason: string;
}

interface Props {
  recommendedMcps: RecommendedMcpEntry[];
}

const STATUS_COLOR: Record<string, string> = {
  "equipped":        "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  "pending-secret":  "border-amber-500/40 bg-amber-500/10 text-amber-300",
  "unhealthy":       "border-red-500/40 bg-red-500/10 text-red-300",
  "not-equipped":    "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
};

export const RecommendedMcpsCard = ({ recommendedMcps }: Props) => {
  const [statuses, setStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    if (recommendedMcps.length === 0) return;
    const allKeys = new Set<string>();
    for (const r of recommendedMcps) for (const k of r.envKeys) allKeys.add(k);
    if (allKeys.size === 0) {
      // No envKeys means we still want to show the list, but inventory lookup
      // isn't applicable. Mark each as "not-equipped" by default.
      const fallback: Record<string, string> = {};
      for (const r of recommendedMcps) fallback[r.entryId] = "not-equipped";
      setStatuses(fallback);
      return;
    }
    void apiFetch<{ mapping: Record<string, string | null>; statuses: Record<string, string> }>(
      `/api/kernel/mcp-catalog/lookup-by-envkey?names=${[...allKeys].map(encodeURIComponent).join(",")}`,
    ).then((r) => { if (r.ok) setStatuses(r.data.statuses); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendedMcps.map((r) => r.entryId).sort().join("|")]);

  if (recommendedMcps.length === 0) return null;

  return (
    <section className="rounded-lg border border-sky-700/40 bg-sky-700/5 p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-sky-300">
        Recommended Tools ({recommendedMcps.length})
      </h4>
      <p className="mt-1 text-[0.7rem] text-zinc-400">
        Approving will commit these MCP servers to the generated pipeline. You can equip them now or after approval.
      </p>
      <ul className="mt-2 space-y-2">
        {recommendedMcps.map((r) => {
          const status = statuses[r.entryId] ?? "not-equipped";
          const color = STATUS_COLOR[status] ?? STATUS_COLOR["not-equipped"];
          return (
            <li key={r.entryId} className="rounded border border-zinc-700 bg-zinc-900/80 p-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-sky-300">{r.entryId}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[0.55rem] uppercase tracking-wide ${color}`}>
                  {status}
                </span>
                {status !== "equipped" && (
                  <a
                    href={`/kernel-next/mcp-catalog`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto text-[0.65rem] text-sky-400 underline"
                  >
                    前往装备 ↗
                  </a>
                )}
              </div>
              <p className="mt-1 text-[0.7rem] text-zinc-300">{r.reason}</p>
              {r.envKeys.length > 0 && (
                <p className="mt-1 font-mono text-[0.6rem] text-zinc-500">
                  envKeys: {r.envKeys.join(", ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
```

- [ ] **Step 2: Wire into gate-card.tsx**

Edit `apps/web/src/components/gate-card.tsx`. At the top with other imports, add:

```typescript
import { RecommendedMcpsCard, type RecommendedMcpEntry } from "./recommended-mcps-card";
```

Find the section that renders `context.upstreams[]` (likely a `.map((u) => ...)` somewhere in the JSX). The structure varies; locate it via:

```bash
grep -n "upstreams\." apps/web/src/components/gate-card.tsx
```

Just before the upstreams render block (or at the top of the gate body), add a derivation + conditional render:

```typescript
  // Phase 3: surface recommendedMcps for the awaitingConfirm gate before
  // the user approves. Find the port across all upstream stages — the analyzing
  // stage in pipeline-generator emits it; the field is plumbed through every
  // gate's upstream context.
  const recommendedMcps: RecommendedMcpEntry[] = (() => {
    for (const u of context.upstreams) {
      for (const out of u.outputs) {
        if (out.port === "recommendedMcps" && Array.isArray(out.value)) {
          return out.value as RecommendedMcpEntry[];
        }
      }
    }
    return [];
  })();
```

Then in the JSX, render `<RecommendedMcpsCard recommendedMcps={recommendedMcps} />` somewhere before the answer buttons. The exact placement depends on the gate-card layout; pick a location after the upstreams display but before the action buttons. The `<RecommendedMcpsCard />` component returns `null` when the list is empty, so adding it unconditionally is safe.

- [ ] **Step 3: Verify the web app type-checks**

`cd apps/web && pnpm exec tsc --noEmit` → clean.

- [ ] **Step 4: Run any existing gate-card tests**

`cd apps/web && pnpm vitest run src/components/gate-card 2>&1 | tail -10`

If a test exists and breaks because of structural changes, the fix is to update the snapshot or add a new assertion that the card section renders. The `<RecommendedMcpsCard />` component returns null on empty, so existing tests that don't supply `recommendedMcps` should remain unchanged.

If no test file exists, that's fine — Phase 3 doesn't mandate one for this component (it's a thin layout shell over Phase 2's already-tested catalog API).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/recommended-mcps-card.tsx \
        apps/web/src/components/gate-card.tsx
git commit -m "feat(mcp-supply-chain-3): gate-card surfaces recommendedMcps with inventory status"
```

---

### Task 5: End-to-end smoke + finishing

**Why last:** verify Phase 3 lands as a coherent improvement to the generator + UI without breaking anything.

**Files:**
- Modify (lightly): existing tests if regression breakage is found
- (No new files; smoke is via existing test suite + manual review)

- [ ] **Step 1: Run full apps/server test suite**

`cd apps/server && pnpm vitest run 2>&1 | tail -10`

Expected: count = Phase 2 baseline (2016 passed / 4 skipped) + Task 1's 3 new tests = ~2019 passed. tsc clean.

If any test broke, investigate. Common breakage points:
- Pipeline-generator regression tests that load the IR and validate port shapes — fix any zod schema enforcement
- Any test that checks specific PulseMCP language in prompts — these need updating to mention `recommend_mcp_servers`

- [ ] **Step 2: Run full apps/web tsc**

`cd apps/web && pnpm exec tsc --noEmit` → clean.

- [ ] **Step 3: Manual prompt sanity check**

`cat apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md | grep -i "pulsemcp"`
Expected: no matches.

`cat apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md | grep -i "recommend_mcp_servers"`
Expected: at least 2 matches (in §Available tools and §Workflow).

`cat apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/gen-skeleton.md | grep -i "get_mcp_catalog_entry"`
Expected: at least 1 match.

- [ ] **Step 4: Use finishing-a-development-branch**

Announce: "I'm using the finishing-a-development-branch skill to complete Phase 3."

Verify tests pass. Default to option 1 (merge to main locally), per the autonomous-progression directive.

After merge:

```bash
git checkout main
git merge feature/mcp-supply-chain-phase-3 --no-ff -m "Merge branch 'feature/mcp-supply-chain-phase-3'

Phase 3 of MCP Supply Chain — pipeline-generator integration.

Switches the generator's MCP discovery from PulseMCP to the local Flow
catalog. The analyzing stage now calls recommend_mcp_servers (via the
auto-injected __kernel_next__ MCP); genSkeleton calls get_mcp_catalog_entry
to materialize each pick. The recommendedMcps port grows entryId + reason
fields. The awaitingConfirm gate renders inventory status alongside each
recommendation, with deep links to /kernel-next/mcp-catalog for equip.
"
cd apps/server && pnpm vitest run    # PASS on merged main
git branch -d feature/mcp-supply-chain-phase-3
```

---

## Self-review

**Spec coverage check (§7.1, §7.2, §7.3, §7.4):**

| Spec section | Phase 3 task |
|---|---|
| §7.1 analyzing stage gains recommend_mcp_servers prompt language | T2 |
| §7.1 recommendedMcps schema gains `entryId` + `reason` | T1, T2 |
| §7.2 genSkeleton calls get_mcp_catalog_entry | T3 |
| §7.2 mcpServers block uses only `name`/`command`/`args`/`envKeys` (not metadata like entryId/reason) | T3 (explicit rule in revised section) |
| §7.3 awaitingConfirm gate UI shows recommended tools + inventory status + 前往装备 button | T4 |
| §7.4 backwards compatibility — existing user pipelines still launch via inventory secret resolution from Phase 2 | (no work needed; Phase 2 is additive; existing pipelines have empty `recommendedMcps` and behave as before) |

**Placeholder scan:** No "TBD" / "TODO" / "implement later" in any task body.

**Type consistency:** `RecommendedMcpEntry` interface (T4) matches the IR port type literal (T1) verbatim — both have `entryId, name, command, args, env?, envKeys, reason`.

**Gap acknowledged:** the 12-entry seeded catalog (Phase 1) covers etherscan/bscscan/github/fetch/filesystem/arxiv/playwright/brave-search/puppeteer/linear/slack/postgres. If a generated pipeline needs an MCP outside this set (e.g. notion, atlassian, stripe), the analyzing stage will record the gap in `assumptions` and the pipeline ships without that MCP — the user adds a custom catalog entry via the web UI and re-runs. This is the intended escape hatch (spec §10's "marketplace / signed manifests" is out of scope; custom entries are the v1 substitute). The `assumptions` array surfaces in the awaitingConfirm gate so the user can react before approval.
