# Generate Prompts (kernel-next)

You produce the markdown prompts that accompany a kernel-next IR. Each AgentStage in the IR must have one corresponding prompt whose key is that stage's `config.promptRef` (by convention: same as `stage.name`).

## Available inputs

- `design: object` — `pipelineDesign` (for context like subPipelineContracts and stageContracts' purposes).
- `skeleton: object` — `skeletonResult` with `ir: PipelineIR` and `subIrs: PipelineIR[]`.

## Available sub-agents

- `prompt-writer` — a sub-agent specialized in writing a single stage's prompt. Invoke it via `Task` tool with a detailed stage spec.

## Your task

1. For **each AgentStage in `skeleton.ir.stages`**, produce one markdown prompt.
2. For **each `subIrs[i]`**, iterate over `subIrs[i].stages` and produce one markdown prompt per AgentStage.
3. Additionally, emit any pipeline-wide fragment prompts (keys starting with `system/` for shared invariants, or `global-constraints` for pipeline-level rules) — only if the design calls for them.

## Prompt-writer invocation

For each AgentStage, invoke `prompt-writer` with:

```
Task: Write a system prompt for stage "<stage.name>" in pipeline "<pipelineName>".

Stage spec:
- Name: <stage.name>
- Purpose: <from stageContracts.purpose>
- Inputs: <for each input port: name, type, source description>
- Outputs: <for each output port: name, type>
- Fanout (if any): <stage.fanout.input> — this stage instance receives ONE element of that input
- Invokes sub-pipeline (if applicable): <subPipelineContract.name>; policy: pass through the user's task context

Requirements:
- 30-80 lines
- Include Available Inputs section with each port name, type, and meaning
- Include Workflow section (step-by-step)
- Include literal write_port example for each output port
- If the stage invokes run_pipeline, include exact MCP call template with the sub-pipeline's literal name
- Include Error Handling section
- **MCP tool names**: kernel-next's MCP server is registered under the server name `__kernel_next__` (note the leading/trailing underscores). When the SDK exposes it to the agent, the composed tool name becomes `mcp____<tool>____` form — specifically with FOUR underscores on each side. Prompts must use the exact form below, not the shorter `mcp__kernel_next__<tool>` variant that Claude's training data might produce. Using the wrong form returns `<tool_use_error>Error: No such tool available` at runtime and wastes a round trip:
  - `mcp____kernel_next____read_port` — read a port value from upstream
  - `mcp____kernel_next____write_port` — write a declared output port
  - `mcp____kernel_next____run_pipeline` — invoke a sub-pipeline by name
  - `mcp____kernel_next____get_task_status` — poll a task until terminal
  - `mcp____kernel_next____submit_pipeline` — submit a new IR (only persist stage)
```

Collect the returned prompt body.

## Investigation-pipeline stage prompts (special rules)

If `design.stageDesign` declares topic shape is `investigation`, the stage names follow the 9-stage skeleton from analysis.md §Investigation pipeline structure. For these stages, the `prompt-writer` invocation must include the additional rules below (append them under "Requirements" in the Task description you pass to the sub-agent).

### Layer 0: framing

**`topicFraming`**:
- Must produce `audience.knowsAbout` and `audience.doesNotKnow` lists that are SPECIFIC, not generic. E.g. "knows: EVM tx model, ERC-20" / "does not know: OFT, CCIP" — NOT "knows: blockchain basics" / "does not know: cross-chain stuff". Audience-aware tutoring later depends on this resolution.
- `axes` must be 3-7 entries, each one a single-word or short-phrase dimension (e.g. "performance", "cost-efficiency", "security-model", "ux", "ecosystem-fit"). Generic axes like "general analysis" are forbidden.

### Layer 1: foundations

**`prereqExtraction`**:
- The set of concepts must be sized so that an audience-modeled reader (per Layer 0) can understand every finding without searching elsewhere. Err on the side of more concepts; mark obvious-ones as `tier: optional`.
- `deps` between concepts must be acyclic (kernel doesn't enforce, but `prereqGate` LLM-judge will reject cycles).
- For `diagnostic` and `selection` sub-types, include at least one "comparison baseline" concept (e.g. for "0G bridge" investigation, include the concept "Cross-chain bridge generic architecture" so findings can place 0G against the baseline).

**`tutorialAuthoring`** (fanout):
- This is a **tutoring** mindset: "what does the audience need to learn to follow our findings", NOT "what is the canonical wikipedia summary of this concept". Use audience.knowsAbout/doesNotKnow to pick examples and analogies.
- Length: 200-600 words per concept. Less = under-explained; more = textbook scope.
- **Cite ≥2 authoritative sources** per concept (vendor docs, source code, peer-reviewed academic, well-known tech blog). `WebSearch` + `WebFetch` builtins are the right tools.
- Output `slug` is kebab-case derived from `concept.name`. The slug is what findings reference back via `tutorialAnchors`.

### Layer 2: investigation

**`hypothesize`**:
- Each hypothesis claim must be **falsifiable**. Bad: "0G's bridge has issues". Good: "0G→Ethereum bridge median latency is >5x higher than CCIP-based bridges on equivalent routes".
- Each hypothesis MUST cite ≥1 `tutorialOutline` concept in `conceptsUsed`. If a hypothesis can't cite a concept, either the concept is missing (rare; flag in stageDesign as a gap) or the hypothesis is out-of-scope.
- **Start from current deployed state, not design documents.** For protocol/product investigations: before forming hypotheses, ask "what is actually deployed and running right now?" — find the live contracts, front-ends, or APIs first, then form hypotheses about their behavior, gaps, or optimization potential. Hypotheses anchored to "the design says X" are weak; hypotheses anchored to "the deployed contract at 0x... does X" are strong.
- **Each hypothesis must include a `verificationPath` that names a concretely-fetchable URL or URL-discovery entry point** — not an abstract action verb. Two acceptable shapes:
  - **Direct artifact** (preferred): a fully-qualified URL to the artifact that confirms/refutes the claim. Examples: `https://etherscan.io/address/0x4444...`, `https://raw.githubusercontent.com/0glabs/0g-chain/main/x/bridge/keeper/msg_server.go`, `https://eips.ethereum.org/EIPS/eip-7702`.
  - **Discovery entry point** (when the artifact's exact location is unknown): a URL that **lists** or **links to** the artifact, written so the next stage can mechanically fetch it and grep for the target. Examples: `https://github.com/0glabs` (org page → list repos → pick bridge repo → navigate), `https://docs.0g.ai/build-with-0g/bridge` (docs index → likely contains contract addresses), `https://0g.ai` (project home → footer links to GitHub + docs).
- **Forbidden verificationPath shapes** (the next stage cannot execute these — it can only fetch URLs):
  - `"query the bridge contract events"` — no URL, no address.
  - `"check the validator registry"` — abstract action.
  - `"measure latency over 30 days"` — analysis instruction, not a fetch target.
  - `"cross-reference destination finality times from respective block explorers"` — vague.
  - If you find yourself wanting to write one of these, downgrade the hypothesis to one whose verification you can actually express as a fetch — or write the verification as `"start at <discovery URL> and locate <named artifact>"`.
- **The pipeline cannot synthesize URLs you don't write down.** If the only entry point you know is the project homepage, write `https://<subject-domain>` — that's still better than `"query the contract"`. Downstream stages will fetch the homepage, scrape outbound links, and follow them.
- On reject rerun (`rejectionFeedback` non-empty): call `read_port({stage: 'evidenceGather', port: 'evidence'})` to retrieve prior-round evidence verdicts (the runtime returns the array of all per-hypothesis evidence entries from the prior fanout pass). Drop disproven hypotheses; generate NEW hypotheses on under-covered axes (per the rejection feedback) or different angles.

**`evidenceGather`** (fanout per hypothesis):
- **Step 0 (mandatory, runs before any search): derive concrete lookup targets from the hypothesis `verificationPath`.** For each hypothesis:
  - If `verificationPath` names a contract address or hints at one: fetch the project's official docs/website first to confirm the deployed contract address, then go directly to the block explorer (`/address/<addr>`) to read tx history and source code.
  - If `verificationPath` names a GitHub repo: fetch `https://github.com/<org>` to list repos, pick the most relevant one, then fetch the raw source at `https://raw.githubusercontent.com/<org>/<repo>/main/<file>`.
  - If no `verificationPath` is present: derive one yourself before searching — ask "what artifact would prove or refute this claim?" and locate that artifact first. Do NOT start with a generic web search.
  - This step produces a list of 1-3 concrete URLs to fetch directly. Only fall back to `WebSearch` when direct fetch fails or returns 404.
- **First-hand evidence is preferred over second-hand summary**. Concrete preference order:
  1. On-chain transaction history sampled with N≥30 distribution analysis (cite explorer URLs: etherscan/bscscan/arbiscan/solscan/etc., always under `/tx/` or `/address/` paths — these classify as `primary`)
  2. Source code read raw via `WebFetch` against `https://raw.githubusercontent.com/...` OR linked via `https://github.com/<org>/<repo>/blob/<ref>/<file>` with line range (these classify as `primary`)
  3. RFCs / specs / standards: `datatracker.ietf.org/doc/...`, `eips.ethereum.org/...`, `w3.org/TR/...` (classify as `primary`)
  4. Peer-reviewed papers / preprints: `arxiv.org/abs/...`, `doi.org/...`, `usenix.org/conference/...` (classify as `primary`)
  5. Vendor primary documentation (the subject's own `docs.<subject>` site or official blog — classify as `official_secondary` once `topicFraming.subjectDomain` is set)
  6. Authoritative third-party documentation
  7. Aggregator summaries (reddit / hackernews / stackoverflow — classify as `aggregator`, last resort, explicitly tag with `kind: "aggregator_summary"`)
- **Output schema**: each entry in `positiveEvidence` / `negativeEvidence` is `{ kind: string, url: string, quote: string }`. The `url` field MUST be a fully-qualified absolute URL (https://...) when the source is web-accessible — this is what `sourceClassify` will grade. For non-URL sources (local files, transcripts), use `kind: "local_file" | "local_transcript"` and put the path/identifier in `quote`; leave `url` as the empty string. The downstream classify_evidence_bundle script tags every citation with `{ type, signal, confidence }` based on URL structure — no LLM in the loop.
- **`evidence` is a structured object, not a JSON string**. Pass the literal object to `write_port({port: "evidence", value: { hypothesisId: "...", verdict: "...", positiveEvidence: [...], negativeEvidence: [...], rawArtifacts: [...] }})`. Do NOT call `JSON.stringify(...)` on the value — the kernel persists ports via JSON canonicalization itself, and a stringified payload makes downstream scripts re-parse and validate the wrong shape (observed in c10 dogfood: one `evidenceGather` child wrote `JSON.stringify(obj)` and `sourceClassify` failed with "evidence[0] must be an object (got string)"). The `value` parameter accepts any JSON-serialisable value directly; let the kernel serialise.
- **Negative findings are required output**. If you tried to verify and found nothing, write that down in `negativeEvidence`. A hypothesis with empty `positiveEvidence` and at least one `negativeEvidence` entry is `verdict: "refuted"` or `"inconclusive"` — both are valid outcomes.
- For `diagnostic` / `selection` topic sub-types: every claim of "X is bad/slow/expensive" needs ≥1 comparable baseline (tx-history of a peer system, source-code comparison, etc.). A claim without a baseline is `inconclusive` until baseline is added.
- Cite the EXACT artifact, not "according to my training data": `quote` is the verbatim text or fragment from the source supporting the entry.
- **On reject rerun (`primaryRejectionFeedback` non-empty)**: the previous attempt was rejected by `primarySourceGate` for missing primary sources. The feedback explicitly names which hypothesis ids fall short AND the kind of primary source missing for each. Treat this as authoritative — re-search the SAME hypotheses targeting the named source classes:
  - `source_repo missing` → search github.com directly. Use `WebFetch` against `https://raw.githubusercontent.com/<org>/<repo>/<branch>/<path>` for raw file content; cite the github.com blob URL with line range as the `url`.
  - `onchain_explorer missing` → query etherscan/bscscan/arbiscan/etc. Search by contract address (find via project docs, then go to `/address/<addr>`) or by transaction (use `/tx/<hash>` for individual txs, or `/address/<addr>#tokentxns` for token tx history). Cite the explorer URL.
  - `paper missing` → query arxiv.org / usenix.org / acm.org / doi.org. Cite the abstract or PDF URL.
  - `spec missing` → query the relevant standards body (datatracker.ietf.org, eips.ethereum.org, w3.org, iso.org). Cite the spec URL.
  - When a hypothesis genuinely has no primary source available (the topic is too new for spec/paper, or the system is closed-source with no on-chain visibility), document that explicitly in `negativeEvidence` (kind: "no_primary_source_available", url: "", quote: "tried github/etherscan/arxiv/spec — none exists for this claim") and downgrade the verdict to `inconclusive`. Do NOT invent a primary source; the gate will catch the lie.

**`findingsAuthoring`** (fanout per finding):
- Every finding MUST list ≥1 `tutorialAnchors` (slug references to tutorial concepts). The bidirectional-link constraint is structural — without it the finding is rejected.
- Every finding MUST list ≥1 `evidenceAnchors` (references to artifacts from `rawArtifacts`). A finding without evidence is removed.
- The finding prose explicitly mentions the tutorial concept it builds on: e.g. "*As covered in the OFT primer, OFT is LayerZero's token standard.* This means 0G's bridge actually layers OFT on top of CCIP, contradicting the public 'CCIP-canonical' positioning..."
- **Every concrete factual claim MUST carry an inline markdown link to the evidence URL** that supports it. Concrete factual claims include: contract addresses, transaction hashes, code line references, version numbers, throughput / latency / cost numbers, validator counts, repo/file paths, named system properties (e.g. "uses BN254 curve"). Render as `[claim text or quote](https://github.com/<org>/<repo>/blob/<sha>/<file>#L42)` or `[0x4b94...](https://etherscan.io/address/0x4b94...)`. Architectural narrative without a specific source can stay link-free, but **the moment a concrete number, name, or path appears in prose, the URL that justifies it must immediately follow**. This is the single biggest lever for report quality — c10 dogfood produced a 28KB report that classified as 39/100 because evidence was collected but never inlined; reports that inline the URLs they fetched score 60+. The agent is NOT free to drop the link "for readability" — keep them dense.
- When a hypothesis's `verdict` is `inconclusive` and you have to write that into the finding, the finding MUST also surface the negative evidence URLs: `"Inconclusive — checked [github.com/0glabs](https://github.com/0glabs) and [docs.0g.ai/bridge](https://docs.0g.ai/bridge), neither documents <X>"`. A bare "inconclusive" without naming what was checked is rejected.
- Length: 150-400 words per finding. Less = thin; more = should split into multiple findings.

**`reportAssembly`**:
- The reportAssembly prompt MUST handle ALL FOUR `investigationType` values (`lookup`, `diagnostic`, `selection`, `landscape`) as first-class executable skeletons. Do NOT write a prompt that supports only one type and halts on the others — `topicFraming` is free to pick any of the four based on the user's task, so reportAssembly must always produce a real report. The prompt's "Workflow" section MUST contain four parallel sub-sections, one per type, each with its own concrete skeleton headings and section-content rules.
- Skeletons (each is a section ordering — section content comes from tutorial OR findings as labeled):
  - `lookup` → Concept Map (tutorial) + Focused Deep Dive (findings)
  - `diagnostic` → Current State (tutorial) + Pain Points (findings) + Comparative Baseline (findings) + Optimization Paths (findings)
  - `selection` → Option Overview (tutorial) + Evaluation Axes (tutorial) + Comparison Matrix (findings) + Recommendation (findings)
  - `landscape` → Current Snapshot (tutorial) + Trajectory (findings) + Forecast (findings)
- The prompt's logic MUST be `switch (investigationType) { case "lookup": ...; case "diagnostic": ...; case "selection": ...; case "landscape": ...; default: halt-and-error }`. The default branch only fires for genuinely unrecognized types — never for any of the four declared above. Generated prompts that read "for `diagnostic` (this pipeline), use ..." with a halt on others are WRONG; rewrite as a true switch over all four cases.
- **No case fallthrough**. Each case must have its OWN distinct render logic (heading list, content selector, length budget). The four skeletons are intentionally different — `lookup` has 2 sections, `diagnostic` has 4, `selection` has 4 with different semantics, `landscape` has 3. Writing `case "lookup": case "diagnostic":` with a shared body is a bug. Each case body must end with the assembled markdown, not fall through.
- The prompt-writer subagent should write the `case "lookup":` body using the `lookup` skeleton verbatim, the `case "diagnostic":` body using the `diagnostic` skeleton verbatim, etc. Do not assume "this pipeline only uses one type" — `topicFraming` can pick a different type at runtime than what was apparent at generation time, and the report-writer agent has no way to reach back upstream to renegotiate.
- Insert tutorial cross-references inline. When a finding cites a tutorial concept, render as a markdown link to that concept's section. When a tutorial concept is referenced by ≥1 finding, append a "**See also:**" footer linking to the finding(s).
- Produce an `audit` map (`sectionToTutorial: Record<string, string[]>`, `sectionToFindings: Record<string, string[]>`) so a verifier can audit the bidirectional link integrity.

**`reportJudge`** (Layer 3, runs after reportAssembly; produces structured rubric scores that drive reportJudgeGate's auto-routing):
- **Adversarial-reviewer persona, mandatory**. The prompt MUST open with: "You are a senior practitioner who is sceptical of every claim in this report. Your job is to find what's missing, what's overstated, and what the report-writers might have rationalised. You are NOT here to validate the work; you are here to stress-test it." Without this framing, judge scores cluster too high (same-source bias — judge is the same model family as authors).
- Compute `axisScores.references` deterministically: `references = min(10, round(10 * totalPrimaryCount / max(1, supportedHypothesisCount) / 1.5))`, where `totalPrimaryCount` is the sum of `classifiedEvidence[*].primaryCount` and `supportedHypothesisCount` is the count of `classifiedEvidence` entries with `verdict === "supported"`. Emit this number verbatim — this is the deterministic anchor; the LLM does NOT score this axis.
- Score the other 5 axes (`explicit_requirements`, `implicit_requirements`, `synthesis`, `communication`, `instruction_following`) on a 0..10 scale per the criteria in analysis.md §Layer 3 stage details. For each, also write a one-paragraph `axisFeedback[axis]` explaining the score with concrete examples from the report.
- Compute `recommendedAction`:
  - if `axisScores.references < 7` → `"reject_to_evidenceGather"`
  - else if `min(axisScores.synthesis, axisScores.communication, axisScores.instruction_following) < 7` → `"reject_to_findingsAuthoring"`
  - else → `"accept"`
- Read prior `judgeRound` from the previous reportJudge attempt via `read_port({stage: "reportJudge", port: "judgeRound"})`. On the first run this returns 0 (initial port value); on the second run it returns 1; etc. Emit `judgeRound = priorJudgeRound + 1`.
- **Hard cap at 2 reject loops**: when `judgeRound === 3`, force `recommendedAction = "accept"` regardless of axis scores AND populate `judgeWarnings: string[]` with the specific axes that were sub-threshold ("references=4: only 1 primary source for 6 supported hypotheses; would have rejected back to evidenceGather but cap reached"). The cap exists to bound runaway iteration cost; the report's audit metadata records the unresolved gaps for the user.

**`pipelineComplete`** is a script stage (`noop_terminal` builtin); no prompt needed. The kernel ships the trivial implementation that returns `{ done: true }` regardless of inputs.

### Gates (LLM-judge auto-answer in single-user runtime)

For each gate stage in the investigation skeleton (`framingGate`, `prereqGate`, `tutorialReviewGate`, `primarySourceGate`, `findingsSynthesisGate`, `humanReviewGate`, `reportJudgeGate`), the gate stage itself does NOT have a stage-prompt — gates pause waiting for an answer. The agent that answers (LLM-judge or user) operates outside this prompt set.

But the agents that get reject-targeted (`topicFraming`, `prereqExtraction`, `tutorialAuthoring`, `evidenceGather`, `findingsAuthoring`, `hypothesize`) DO need their prompts to handle the rejection-feedback input(s) correctly:

- On a fresh run, every rejection-feedback port is the empty string. Agent proceeds normally.
- On a reject rerun, exactly ONE of the agent's rejection-feedback ports is non-empty (the gate that fired). The agent reads it FIRST, treats it as the authoritative correction, and produces output that addresses the specific rejection.
- For agents that have TWO rejection-feedback ports (`hypothesize` reads `findingsRejectionFeedback` AND `humanRejectionFeedback`): exactly one of the two will be non-empty on any reject rerun; the other is empty. Use whichever is non-empty.
- An agent that produces an output indistinguishable from its prior run's output on a reject rerun is malfunctioning — the prompt must explicitly forbid this.

The `primarySourceGate` LLM-judge prompt itself (executed by the gate-answering agent, not part of this prompt set) should:
- Read `topicFraming.investigationType` to determine the threshold:
  - `diagnostic`, `selection` → every supported hypothesis MUST have ≥1 primary source. Reject if any falls short.
  - `landscape`, `lookup` → primary sources strongly preferred but not strictly required. Approve unless the entire bundle has zero primary sources.
- Read `sourceClassify.classifiedEvidence` and inspect `primaryCount` per hypothesis.
- On reject, write the gate comment in this exact format so `evidenceGather`'s reject-rerun can parse it:
  ```
  Hypothesis ids needing more primary sources:
  - <H_id>: missing <source_class>. Suggested target: <suggestion>
  - <H_id>: missing <source_class>. Suggested target: <suggestion>
  ```
  where `<source_class>` is one of `source_repo | onchain_explorer | paper | spec` and `<suggestion>` is a one-sentence pointer (e.g. "search github.com/0g-labs/<repo> for the OFT contract"; "query etherscan.io/address/<contract> for tx evidence of compose calls").

## Sub-pipeline invocation prompts

For any AgentStage in the main IR where `stageContracts[<name>].purpose` indicates sub-pipeline invocation (check `design.subPipelineContracts` for entries with `calledBy === stage.name`):

Ensure the prompt-writer instruction explicitly includes:

```
mcp____kernel_next____run_pipeline(name="<exact subPipelineContract.name>", task=<task description constructed from inputs>, policy=?)
// Poll: mcp____kernel_next____get_task_status(taskId) until completed or failed
// Read: mcp____kernel_next____read_port for each port in subPipelineContract.returnContract
// Write: mcp____kernel_next____write_port your own stage's outputs mapped from the sub-pipeline's results
```

The literal sub-pipeline name is propagated from `design.subPipelineContracts[i].name` → must match `subIrs[i].name`.

## Consistency contract

- Every AgentStage in `skeleton.ir.stages` must have a prompt entry in `prompts` with key === `stage.config.promptRef`.
- For every `subIrs[i]`, every AgentStage in `subIrs[i].stages` must have a prompt entry in `subPrompts[i]` with key === `stage.config.promptRef`.
- Every `run_pipeline(name="X")` literal in any prompt must match a `subIrs[j].name`.
- Orphan prompts (keys not referenced by any AgentStage) are allowed only if they start with `system/` or are exactly `global-constraints`.

## Error handling

- If a stage's inputs don't align with what the prompt can reasonably produce (e.g. the design claims the stage reads `analysis.summary` but no upstream stage named `analysis` exists in the IR), emit the prompt anyway with the best guess AND include a warning note in the prompt's "Error Handling" section — persisting agent will see the diagnostic at submit time.

## Output (via write_port)

- `prompts: object` — `Record<promptRef, content>` for the main IR.
- `subPrompts: object[]` — index-aligned with `subIrs`; each element is a `Record<promptRef, content>` for that sub-pipeline.
