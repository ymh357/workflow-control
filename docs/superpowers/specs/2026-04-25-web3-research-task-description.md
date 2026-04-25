# Web3 Research Pipeline — Task Description for pipeline-generator

> **Purpose**: Structured task description fed into `pipeline-generator` to produce the `web3-research` pipeline. This is the *input* to the generator, not an IR. The generator must design the IR (stage decomposition, wires, ports) by reading this document.
>
> **Date**: 2026-04-25
>
> **Author intent**: This document specifies *what* the pipeline must do (responsibilities, methodology, invariants) and *what to avoid* (anti-patterns from the legacy pipeline). It does **NOT** specify stage count, stage names, or per-stage IR shape. Stage decomposition is the generator's job — the methodology library + responsibilities + constraints together fully determine a correct design.

---

## 1. Pipeline goal (one sentence)

Produce a decision-ready, factually-verified Web3 research deliverable for any well-defined research target — by automatically selecting the appropriate methodology bundle based on the target's type, applying it rigorously, and surviving an adversarial fact-check before output.

## 2. Pipeline name

`web3-research`

## 3. Why this pipeline replaces the old one

The previous `web3-tech-research` had 17 stages, 6-way `subject_type` if-else inside every prompt, 3 human gates, dual `task_mode` (full/explore) branches, `exclusive_write_group` legacy schema, and ~$30-40 per run. It was multiple pipelines stitched with `condition` stages, none of which got first-class treatment.

The replacement keeps every hard-won lesson (echo-chamber defense, tier labels, mandatory checklists, SPA fallback, adversarial fact-check) but **factors orthogonal concerns cleanly**:

- **Cross-cutting invariants** (§4) → globalConstraints applied to every agent stage.
- **Methodology atoms** (§5) → a library of named research lenses with explicit purpose and required checks.
- **Type → atom mapping** (§6) → declarative table; one stage classifies the target and selects atoms; downstream stages execute the selected set.
- **Single linear flow with one human gate** → no mode branching, no subject_type if-else inside prompts, no exclusive write groups, no mid-stage filesystem state.

---

## 4. Cross-cutting invariants (must become globalConstraints)

Every agent stage MUST honor these. The generator should consolidate §4 into a single `globalConstraints` prompt fragment referenced by every agent stage's system prompt.

### 4.1 Cardinal rules (in priority order)

1. **On-chain is final**. If the deployed contract / read function / RPC says X but documentation says Y, X wins. No exceptions.
2. **Primary one-way authority**. Official project sources (docs, GitHub, whitepaper, official blog) are never overridden by third-party sources (news, analytics, exchange listings). Third-party can only *contradict* primary, never *replace* it.
3. **Verbatim over paraphrase for numbers**. When extracting tokenomics allocations, supply numbers, funding amounts, dates, percentages — copy the exact text from the source. Do not round, summarize, or interpret.

### 4.2 Verification tier labels (5 tiers, mandatory)

Every quantitative claim in any deliverable or research note MUST carry exactly one tier label. The label reflects YOUR verification path, not the source's underlying methodology.

| Label | When to use |
|---|---|
| `[On-chain]` | Read directly from a block explorer contract page or RPC endpoint |
| `[Aggregator]` | From CoinGecko / DefiLlama / CoinMarketCap / L2Beat / Dune / Tokenomist (these may derive from on-chain, but YOUR query is at the aggregator) |
| `[Official]` | From official documentation, official GitHub, whitepaper, official blog, official Twitter pinned/announcement |
| `[Third-party]` | From news, analyst reports, third-party blogs, community articles |
| `[Unverified]` | Attempted multiple sources, unable to confirm |

`[Inference]` is NOT a tier label. If you derive a fact from other facts, write it inline as "based on X and Y, we infer Z" with all sources for X and Y carrying their own tier labels.

### 4.3 Mandatory discovery checklist (primary-source phase)

Regardless of what the task description provides, the primary-source-collection responsibility MUST execute these searches:

1. Search `"{project_name} official website"`
2. Search `"{project_name} documentation"` AND `"{project_name} gitbook"`
3. Search `"{project_name} whitepaper"`
4. Visit `github.com` directly and search the project name. Inspect org page, list public repos, note repo count, star counts, last commit dates, total commit counts. "No GitHub" must be a confirmed search result, not an absence in the task description.

### 4.4 SPA fallback chain

Many Web3 projects use Gitbook / Docusaurus / SPA frameworks. WebFetch returns initial HTML only — JS-rendered content is missing.

When a page returns near-empty content:
1. Try common subpaths: `/tokenomics` `/architecture` `/overview` `/introduction` `/whitepaper` `/team` `/roadmap` `/ecosystem` `/getting-started` `/about` `/faq`
2. Try documentation subpaths: `/docs` `/docs/introduction` `/docs/overview` `/docs/tokenomics`
3. For Gitbook: try sidebar discovery / raw markdown endpoint / search API

Never conclude "documentation is sparse" from a single failed fetch. Record tool failures explicitly: `[Tool limitation] SPA content at {url} could not be rendered`.

### 4.5 Block explorer fallback chain

A single explorer returning 403 / timeout / empty is NOT grounds to abandon verification. Required fallback chains:

- **EVM**: Etherscan → Blockscout → Tenderly → direct RPC
- **Sui**: Suiscan → SuiVision → OKLink Sui → Sui RPC
- **Solana**: Solscan → Solana Beach → Helius → direct RPC
- **Cosmos**: Mintscan → Big Dipper → direct LCD
- **General rule**: Try ≥2 different explorers before marking a claim unverifiable

### 4.6 Echo-chamber defense

Every responsibility's design must answer: "if upstream is wrong, does this responsibility propagate or block the error?"

The adversarial fact-check responsibility exists specifically to break the chain — it MUST fetch external sources independently, never use store data as evidence.

### 4.7 Contradiction protocol

When two sources at the same tier disagree on a quantitative claim:
1. Flag immediately in research notes
2. Escalate to higher tier for resolution
3. If unresolvable, record both: `[Conflicting — {sourceA} says X, {sourceB} says Y]`
4. Never average / round / pick "more recent" silently

When third-party contradicts primary on a target's own facts: primary wins, but the contradiction is recorded. Format: `[Conflicting — official docs say {X}, {source} ({url}) says {Y}]`.

### 4.8 Citation standards

- Every factual claim has an inline source link: `[description](url)`
- On-chain claims link to the specific block explorer page (tx hash, address page, code tab)
- Source-code claims link to specific file/line in the repo
- Never cite a URL you didn't actually visit
- Never cite a statistic without a traceable source URL — if the article says "250K daily users" with no upstream link, mark `[Unverified — original source not found, cited via {article_url}]`. No "industry report" / "market research" hand-waves.

### 4.9 Outlier smell tests (adversarial fact-check uses these)

Any quantitative claim that triggers one of these MUST be elevated for verification:
- User count × $market cap implies < $5 per user (likely inflated)
- TVL > FDV (impossible without double-counting)
- Growth metric implies > 10× in 6 months without corroborating on-chain activity
- Self-reported metric (`[Unverified]`) is the sole basis for a bullish/bearish conclusion

### 4.10 Output format conventions

- Research notes / intermediate stages: English
- Final deliverable: Simplified Chinese, with code / identifiers / protocol names in English
- Address the reader as `你` (not `您`, unless the deliverable is formal register)
- Markdown structure: deliverable starts with executive summary, ends with consolidated references

---

## 5. Methodology atom library

Atoms are reusable research lenses. Each has: `id`, `purpose`, `mandatory_checks`, and `report_section_outline` (the markdown section the atom should produce, embedded in the analysis report).

**IR-level handling**: Atoms are NOT separate stages and NOT separate output ports. The atom set selected for a given task drives **prompt-internal dispatch** inside whichever stage handles atom-driven analysis. The IR-level output of that stage is a single structured markdown report port containing one section per applied atom — *not* per-atom typed ports.

This avoids both (a) port explosion (17 atoms × 5-7 fields = 80+ ports) and (b) impossible "dynamic emit N of M ports" semantics that kernel-next does not support.

### 5.1 Verification & verification-adjacent atoms

#### `m-onchain-verification`
- **Purpose**: Verify deployed contracts against documentation claims; map token topology; surface security factors.
- **Mandatory checks**:
  - For target's main contracts: pull source from block explorer, record inheritance chain + interface implementations, read public state functions (owner, totalSupply, paused, peers, etc.)
  - Map token topology: standard (ERC-20 / OFT / xERC20 / native), per-chain deployments (proxy vs implementation), bridge mechanism (lock-mint vs burn-mint vs MPC)
  - Security surface scan: EOA owner, missing multisig on critical functions, unverified source code, privileged roles (mint, pause, upgrade), timelock presence
  - Apply block explorer fallback chain (§4.5)
- **Report section outline**:
  - Subsection: "Contract addresses & deployment" — table of (name, address, chain, link)
  - Subsection: "Token topology" — markdown description
  - Subsection: "Security surface" — list of risk factors with severity tags
  - Subsection: "Corrections" — any docs-vs-onchain discrepancies

#### `m-onchain-spot-check`
- **Purpose**: Lighter version of `m-onchain-verification` for cases where target isn't a deployable protocol but has on-chain footprint (e.g., DAO treasury, NFT collection, oracle data feed).
- **Mandatory checks**: Top 5-10 most impactful quantitative claims from upstream stages → cross-check against primarySources first, then on-chain via explorer (≥2 fallbacks), then aggregator if not on-chain verifiable.
- **Report section outline**:
  - Subsection: "On-chain spot-check results" — table of (claim, doc value, on-chain value, source URL, verdict)

#### `m-audit-status-check`
- **Purpose**: Find published audit reports for the target's smart contracts; extract critical findings + remediation status.
- **Mandatory checks**:
  - Search known audit firms: Trail of Bits / Consensys Diligence / OpenZeppelin / Halborn / Quantstamp / Certora / Code4rena / Immunefi / Hacken / Spearbit / Cyfrin
  - Pull each audit report (PDF or web), extract: scope, date, methodology, findings (severity-classified), remediation status
  - Note unaudited critical contracts as a finding itself
- **Report section outline**:
  - Subsection: "Audit history" — table of (firm, date, scope, link)
  - Subsection: "Open critical findings" — list with remediation status
  - Subsection: "Coverage gaps" — critical contracts without audit

### 5.2 Tokenomics atoms

#### `m-tokenomics-pentagon` (Hacken-style, six dimensions in practice despite the name)
- **Purpose**: Comprehensive tokenomics evaluation. Use whenever the target has a token (almost everything except pure infrastructure).
- **Mandatory checks**:
  1. **Distribution**: total supply, allocation breakdown by category (team / investors / community / treasury / ecosystem / public sale), exact percentages, top-10 holder concentration from explorer
  2. **Vesting**: cliff periods, linear vs milestone-based, current locked vs unlocked %, upcoming unlock cliffs (next 6 months)
  3. **Investor terms**: round sizes, FDV at each round, investor list, lock-up vs vesting, side letters known
  4. **Liquidity conditions**: circulating supply, exchange listings, DEX pool depth, market maker arrangements (if disclosed)
  5. **Value accrual**: how does the token capture protocol value? Fees, buyback, burn, staking yield, governance only, none?
  6. **Selling pressure model**: emission schedule × current price → monthly USD selling pressure estimate. Flag if > 10% of average daily volume.
- **Report section outline**:
  - Subsection: "Distribution" — table
  - Subsection: "Vesting & upcoming unlocks" — table with USD impact
  - Subsection: "Investor terms"
  - Subsection: "Liquidity"
  - Subsection: "Value accrual mechanism"
  - Subsection: "Selling pressure analysis"
  - Subsection: "Red flags"

#### `m-holder-distribution`
- **Purpose**: Concentration risk + smart-money positioning.
- **Mandatory checks**: top 10 holder %, Gini coefficient if available, identify holders (CEX, market maker, team multisig, DAO treasury, smart money labels via Nansen / Arkham if accessible).
- **Report section outline**:
  - Subsection: "Top-10 concentration"
  - Subsection: "Labeled holders" — table of (address, label, %)
  - Subsection: "Concentration insights"

#### `m-unlock-calendar`
- **Purpose**: Forward-looking unlock schedule with USD impact.
- **Mandatory checks**: Pull from Tokenomist / TokenUnlocks / project docs, list all unlocks in next 12 months with date / token amount / USD estimate at current price.
- **Report section outline**:
  - Subsection: "Unlock calendar (next 12m)" — table
  - Subsection: "Material events" — unlocks > 5% of circulating supply
  - Subsection: "Total USD pressure (next 6m)"

### 5.3 Protocol-specific atoms

#### `m-bridge-trust-model`
- **Purpose**: Classify cross-chain bridge security assumption. Use only for bridge targets.
- **Mandatory checks**:
  - Trust model: lock-mint vs burn-mint vs MPC vs ZK vs optimistic
  - Validator set: who runs nodes, decentralization, slashing
  - Message-passing path: which intermediary proves state
  - Historical incidents: hacks, near-misses, post-mortems
- **Report section outline**:
  - Subsection: "Trust model classification"
  - Subsection: "Validator set"
  - Subsection: "Message protocol path"
  - Subsection: "Incident history" — table

#### `m-stablecoin-peg-mechanism`
- **Purpose**: Stablecoin peg stability analysis. Use only for stablecoin targets.
- **Mandatory checks**:
  - Reserve composition (cash / T-bills / crypto collateral / synthetic), audit/attestation status
  - Collateralization ratio (live, on-chain readable for crypto-collateralized; attestation for fiat-backed)
  - Redemption path: who can redeem, minimum size, T+N latency
  - Historical depeg events: depth, duration, recovery
  - Legal structure / issuing entity / jurisdiction
- **Report section outline**:
  - Subsection: "Reserve composition"
  - Subsection: "Collateralization"
  - Subsection: "Redemption path"
  - Subsection: "Depeg history"
  - Subsection: "Legal structure"

#### `m-validator-economics`
- **Purpose**: For L1/L2 chains. Validator concentration, slashing history, staking economics.
- **Mandatory checks**:
  - Validator count, top-N concentration (top-10, top-33% — Nakamoto Coefficient)
  - Slashing history (frequency, total slashed)
  - Staking yield (real, after issuance dilution)
  - Hardware/operator decentralization signals
- **Report section outline**:
  - Subsection: "Validator set"
  - Subsection: "Nakamoto coefficient"
  - Subsection: "Slashing history"
  - Subsection: "Real yield"

#### `m-consensus-mechanism`
- **Purpose**: For L1/L2 chains. Consensus type, finality, throughput claims with verification.
- **Mandatory checks**:
  - Consensus family (PoW / PoS / DAG / hybrid), specific algorithm
  - Finality: probabilistic vs deterministic, time to finality
  - Claimed TPS vs measured TPS (find independent benchmark)
  - Block time variance
- **Report section outline**:
  - Subsection: "Consensus algorithm"
  - Subsection: "Finality model"
  - Subsection: "Throughput claims vs measurements" — explicit table

#### `m-depin-physical-evidence`
- **Purpose**: For DePIN targets. Real-world infrastructure presence verification.
- **Mandatory checks**:
  - Hardware/coverage map: independent verification of node / sensor / device count
  - Service quality: actual measurements vs claims (uptime, throughput)
  - Unit economics: per-node revenue vs token rewards (sustainability)
  - Geographic distribution
- **Report section outline**:
  - Subsection: "Coverage map"
  - Subsection: "Service quality"
  - Subsection: "Unit economics"
  - Subsection: "Sustainability verdict"

#### `m-gamefi-economy-loop`
- **Purpose**: For GameFi targets. Game economy sustainability.
- **Mandatory checks**:
  - Token model (single / dual / multi-token)
  - Sources (where do tokens come from) and sinks (where do they leave the system)
  - Player retention (DAU / WAU / MAU, retention curve if available)
  - Token price vs in-game item floor — is play-to-earn sustainable or pyramidal?
- **Report section outline**:
  - Subsection: "Token model"
  - Subsection: "Token sources & sinks"
  - Subsection: "Player retention"
  - Subsection: "Sustainability verdict"

### 5.4 Governance & ecosystem atoms

#### `m-governance-power`
- **Purpose**: Voting power distribution + treasury health.
- **Mandatory checks**:
  - Voting power top-N concentration
  - Active delegates, delegation patterns
  - Recent proposal pass rate, contention rate, voter turnout
  - Treasury composition (native token / stables / other) with USD valuation
  - Treasury runway at current burn
- **Report section outline**:
  - Subsection: "Voting power distribution"
  - Subsection: "Delegate landscape"
  - Subsection: "Recent proposal activity"
  - Subsection: "Treasury health"

#### `m-developer-traction`
- **Purpose**: Real developer activity vs vanity metrics.
- **Mandatory checks**:
  - Recent commits (90d), unique committers, fork count, PR activity
  - Distinguish: maintainer activity vs external contributor activity
  - Discord / forum: dev-focused channel activity
  - Hackathon / grant program activity
- **Report section outline**:
  - Subsection: "GitHub activity (90d)"
  - Subsection: "Contributor diversity"
  - Subsection: "External developer signals"

#### `m-competitor-landscape`
- **Purpose**: At least 5 competing solutions enumerated, positioning matrix.
- **Mandatory checks**:
  - Enumerate ≥5 competitors (NEVER stop at 1-2 — historical failure: 0G research initially missed LayerZero)
  - For each: official URL, one-line description, market cap, TVL (if applicable), chain coverage, key differentiator
  - Build positioning matrix: 5+ dimensions including market cap, chain coverage, tech focus, adoption stage, token utility
  - Classify: direct / indirect / potential competitor
  - Identify market gaps
- **Report section outline**:
  - Subsection: "Competitor list" — table with all enumerated competitors
  - Subsection: "Positioning matrix" — markdown table, ≥5 dimensions
  - Subsection: "Market gaps"

### 5.5 Domain-landscape atom (when target is a domain not a project)

#### `m-prisma-systematic-review` (flow-style atom — different from dimension atoms above)
- **Purpose**: For domain-landscape research (no target_project). Adapt PRISMA 4-phase identification → screening → eligibility → inclusion. Replaces the per-target deep-dive flow when the task is to map a sector.
- **Mandatory checks**:
  - Identification: enumerate ALL candidates from at least 3 source types (aggregators, GitHub topic search, ecosystem maps)
  - Screening: apply explicit inclusion criteria stated upfront
  - Eligibility: per-candidate quick check against criteria
  - Inclusion: final shortlist with reasoning for inclusion/exclusion
- **Report section outline**:
  - Subsection: "Identification source list"
  - Subsection: "Inclusion criteria"
  - Subsection: "PRISMA flow counts" — identified / screened / eligible / included
  - Subsection: "Final shortlist" — with reasoning per entry
  - Subsection: "Exclusions" — with reasoning per excluded candidate

### 5.6 Deliverable structuring frame (NOT an atom)

The final deliverable's top-level section structure follows EY's six-pillar evaluation frame. This is **not an atom** — it does not appear in any `atomSet`. It is a directive applied to whichever stage produces the final markdown deliverable.

**Six pillars**:
1. **Reputational** — team background, public controversies, sanctions exposure
2. **Technical** — architecture, security, decentralization
3. **Financial** — funding, burn rate, runway, tokenomics health
4. **Legal** — entity structure, jurisdiction, regulatory exposure (especially for stablecoins / CEX)
5. **Cybersecurity** — audit status, incident history, security practices
6. **Auditability** — what's verifiable, what's opaque, attestation cadence

The deliverable's body is organized under these six pillars; atom-produced content is slotted into the appropriate pillar (e.g., `m-onchain-verification` content goes under Technical + Cybersecurity; `m-tokenomics-pentagon` goes under Financial; `m-audit-status-check` goes under Cybersecurity; etc.).

---

## 6. Type → atom mapping

A type-classification responsibility classifies the target into ONE of the types below and emits the corresponding `atomSet`. Downstream stages consume `atomSet` (a `string[]` port) and dispatch atom-specific behavior internally.

### 6.1 Types and atom sets

```yaml
l1-l2-chain:
  - m-tokenomics-pentagon
  - m-validator-economics
  - m-consensus-mechanism
  - m-onchain-verification
  - m-developer-traction
  - m-competitor-landscape

defi-protocol:
  - m-tokenomics-pentagon
  - m-onchain-verification
  - m-audit-status-check
  - m-governance-power
  - m-competitor-landscape

cross-chain-bridge:
  - m-bridge-trust-model
  - m-onchain-verification
  - m-audit-status-check
  - m-tokenomics-pentagon
  - m-competitor-landscape

cex-or-cefi:
  # Note: most onchain atoms don't apply; emphasize legal/reputational/financial pillars.
  - m-audit-status-check  # proof-of-reserves / SOC2 etc.
  - m-competitor-landscape

token-or-asset:
  - m-tokenomics-pentagon
  - m-holder-distribution
  - m-unlock-calendar
  - m-onchain-spot-check
  - m-competitor-landscape

nft-collection:
  - m-holder-distribution
  - m-onchain-spot-check
  - m-developer-traction  # for IP/utility roadmap delivery
  - m-competitor-landscape

stablecoin:
  - m-stablecoin-peg-mechanism
  - m-onchain-verification
  - m-audit-status-check
  - m-holder-distribution
  - m-competitor-landscape

restaking-or-lrt:
  - m-tokenomics-pentagon
  - m-onchain-verification
  - m-audit-status-check
  - m-governance-power
  - m-competitor-landscape

mev-or-block-infra:
  - m-onchain-verification
  - m-audit-status-check
  - m-validator-economics  # for sequencer set
  - m-competitor-landscape

depin:
  - m-tokenomics-pentagon
  - m-depin-physical-evidence
  - m-onchain-verification
  - m-competitor-landscape

gamefi:
  - m-tokenomics-pentagon
  - m-gamefi-economy-loop
  - m-onchain-verification
  - m-developer-traction
  - m-competitor-landscape

wallet-or-ux-infra:
  # Onchain verification limited to integration depth.
  - m-audit-status-check
  - m-developer-traction
  - m-competitor-landscape

indexer-or-data-infra:
  # Less onchain-heavy.
  - m-developer-traction
  - m-competitor-landscape
  - m-tokenomics-pentagon  # if has token

oracle:
  - m-onchain-verification  # data freshness, heartbeat
  - m-audit-status-check
  - m-tokenomics-pentagon
  - m-competitor-landscape

dao-or-governance:
  - m-governance-power  # primary lens
  - m-onchain-spot-check  # treasury
  - m-tokenomics-pentagon
  - m-competitor-landscape

domain-landscape:
  # No specific target_project; the task is to map a domain / sector.
  - m-prisma-systematic-review  # primary lens, flow-style
  - m-competitor-landscape  # ≥5 candidates each profiled
  - m-onchain-spot-check  # per-candidate light verification

generic-web3-protocol:
  # Fallback when classification is ambiguous.
  - m-tokenomics-pentagon
  - m-onchain-verification
  - m-audit-status-check
  - m-competitor-landscape
```

### 6.2 Type-selection algorithm

The classification responsibility reads `taskDescription` and emits:
1. `entityType` — one of the type ids above. **Note**: the port is named `entityType`, not `type` — `type` is a TS reserved word and would fail port-name validation.
2. `typeReasoning` — why this type, citing specific phrases from the task description
3. `typeConfidence` — `"high"` | `"medium"` | `"low"`
4. `atomSet` — array of atom ids derived from the §6.1 mapping
5. `alternativeTypes` — only when confidence is `"low"`; array of fallback candidates

**Selection rules with priority** (more specific rules win over more general):

| Priority | Trigger | Type |
|---|---|---|
| 1 | Task has no specific project target (only a domain / sector / category) | `domain-landscape` |
| 2 | Stablecoin keywords (USD, USDC, USDT, peg, dollar, stable) AND the target IS a tokenized asset | `stablecoin` |
| 3 | Restaking / LRT / EigenLayer / restaked keywords | `restaking-or-lrt` |
| 4 | Bridge / cross-chain / messaging / interoperability keywords | `cross-chain-bridge` |
| 5 | DePIN / physical infra / sensor / hardware / coverage network keywords | `depin` |
| 6 | Game / play-to-earn / GameFi keywords | `gamefi` |
| 7 | NFT / collection / mint / 721 / 1155 keywords | `nft-collection` |
| 8 | DAO / governance / proposal / vote / delegation primary focus | `dao-or-governance` |
| 9 | Oracle / price feed / data feed keywords | `oracle` |
| 10 | MEV / sequencer / block builder / Flashbots / Jito keywords | `mev-or-block-infra` |
| 11 | Wallet / SDK / signer / account abstraction / EIP-4337 keywords | `wallet-or-ux-infra` |
| 12 | Indexer / RPC / The Graph / subgraph / data infra keywords | `indexer-or-data-infra` |
| 13 | CEX / centralized exchange / Binance / Coinbase / OKX / Kraken keywords | `cex-or-cefi` |
| 14 | L1 / L2 / chain / rollup / consensus / blockchain (the chain itself) keywords | `l1-l2-chain` |
| 15 | DEX / lending / yield / staking / derivatives / DeFi protocol keywords | `defi-protocol` |
| 16 | Single specific token mentioned with no protocol context | `token-or-asset` |
| 17 | Anything else with a clear target | `generic-web3-protocol` |

Higher priority wins. If a task ambiguously matches two priorities, pick the higher one and record the alternative in `alternativeTypes` if `typeConfidence == "low"`.

---

## 7. Pipeline responsibilities (functional, not stage-by-stage)

The pipeline must discharge these seven responsibilities. **Stage decomposition is the generator's design choice.** A responsibility may map to one stage, span multiple stages, or share a stage with a neighboring responsibility — whatever produces the cleanest IR.

### 7.1 The seven responsibilities

| # | Responsibility | What it does | Inputs needed | Outputs needed |
|---|---|---|---|---|
| R1 | **Scope** | Parse `taskDescription`, extract target name, derive 3-7 concrete research questions, surface assumptions | `taskDescription` (external, string) | target name, research questions, assumptions, optional initial type guess |
| R2 | **Type classification** | Apply §6.2 selection algorithm, emit `entityType` + `atomSet` | scope outputs | `entityType`, `typeReasoning`, `typeConfidence`, `atomSet` |
| R3 | **Primary source collection** | Apply §4.3 mandatory discovery + §4.4 SPA fallback; extract verbatim facts; record source catalog | scope, entityType | structured primary-source report (markdown), source catalog |
| R4 | **Domain / external research** | Enumerate ≥5 competitor / domain candidates; cross-check vs primary sources; record contradictions | scope, entityType, primary sources | domain research report (markdown), candidate list, contradictions |
| R5 | **On-chain verification** | Apply `m-onchain-verification` or `m-onchain-spot-check` per atomSet (or skip if neither in atomSet); apply §4.5 fallback | atomSet, primary sources, domain research | on-chain verification report (markdown), corrections |
| R6 | **Atom-driven analysis** | Dispatch internally to each atom in atomSet (except m-onchain-* already handled in R5, and m-prisma-* if used as a flow-replacing atom — see §7.2). Produce a single structured markdown report with one section per applied atom | atomSet, all prior outputs | single markdown analysis report (covers all selected atoms) |
| R7 | **Deliverable production** | Synthesize a final Chinese markdown deliverable structured by §5.6 EY six pillars; embed atom outputs in appropriate pillars; include executive summary + references | all prior outputs | final markdown deliverable |
| R8 | **Adversarial fact-check** | Independently fetch ≥3 external URLs to verify deliverable's top quantitative claims; apply §4.9 outlier smell tests; edit deliverable in place; format & completeness check | deliverable, primary sources, on-chain verification | corrected deliverable, fact-check report, confidence score |

(R1-R8 = 8 responsibilities; R3+R4+R5 may collapse or split as the generator sees fit.)

### 7.2 Special case: domain-landscape

When `entityType == "domain-landscape"`, the atom set is centered on `m-prisma-systematic-review` (a flow-style atom). In this case:
- R3 (primary source collection) does NOT apply to a single target — it collects identification sources for PRISMA (aggregators, GitHub topic search, ecosystem maps)
- R4 absorbs the PRISMA screening / eligibility / inclusion phases
- R5 runs `m-onchain-spot-check` against each shortlisted candidate (light, not deep)
- R6 produces per-candidate profile + cross-candidate positioning matrix

The generator should make R3-R5 sensitive to this case via prompt branching on `entityType`, NOT via separate stages. `entityType` is a port input downstream stages read.

### 7.3 Required structural constraints

- **Exactly one human gate**, placed after Scope (R1) and before any expensive downstream work. The gate routes "approve → continue", "reject → re-do scope".
- **No condition-style stages** — kernel-next has no `condition` type. Conditional behavior is done via wire guards or via prompt-internal branching on port values.
- **No `.workflow/*.md` mid-stage files** — all data flows through typed ports. Final deliverable is a markdown port output (string), not a path.
- **No mid-stage filesystem state** of any kind.
- **Atom dispatch is prompt-internal** — atoms are NOT separate stages and do NOT have separate output ports. The atom-driven analysis stage emits ONE markdown report port.
- **Adversarial fact-check stage** must explicitly forbid using prior store data as verification (per §4.6) and must fetch ≥3 external URLs.
- **All agent stages reference globalConstraints** (§4) as a system prompt fragment.

### 7.4 Soft cost target

A single `web3-research` run, given a defined target, should land in the **$8-15 USD** range and **10-15 minutes wall-clock**. Generator should size `maxTurns` and `maxBudgetUsd` per stage to total within this envelope. (Old pipeline: $30-40 / 30+ min; treat as upper bound to avoid.)

---

## 8. IR conventions (kernel-next requirements)

When converting this spec into an IR, the generator MUST honor these kernel-next-specific rules:

1. **PortIR shape**: every input/output port is `{ name: string, type: string, description?: string }`. Use TypeScript type literals for `type` (e.g., `"string"`, `"string[]"`, `"{ url: string; status: string }[]"`).
2. **session_mode**: this pipeline has a human gate which forces a segment boundary; single-session buys little here. Use `"multi"` unless there's a strong reason to use `"single"` (record reasoning in `assumptions`).
3. **store_schema**: kernel-next requires `store_schema` populated for every output port that another stage reads. Generator must produce a valid `store_schema` mapping each downstream-read port to its `produced_by: { stage, port }`.
4. **External inputs**: only `taskDescription` (string) is an external input. Everything else flows through stage outputs.
5. **MCPs**: `WebSearch` and `WebFetch` are mandatory. Add `pulsemcp` / `context7` / `npm-registry` if available, especially for primary source collection and adversarial fact-check.
6. **MCP tool names in prompts**: use `mcp____kernel_next____<tool>` (4 underscores on each side), not `mcp__kernel_next__<tool>` — the latter fails at runtime with `<tool_use_error>`.
7. **Output language**: deliverable is Simplified Chinese with English code identifiers. Address reader as `你`. Intermediate research notes are English.
8. **Gate stage**: kernel-next uses `gate` (not `human_confirm`). Routing is via `gateRouting: { approve: <next stage>, reject: <upstream stage> }`. The gate's `__gate_feedback__` port can wire back to the upstream stage's `rejectionFeedback` input.
9. **Port names — TS reserved words are forbidden**. Port `name` must be a valid TS identifier AND must not be a reserved word. Common offenders to avoid: `type`, `class`, `function`, `default`, `new`, `delete`, `void`, `typeof`, `instanceof`, `import`, `export`, `enum`, `interface`, `extends`, `implements`, `public`, `private`, `protected`, `static`, `abstract`, `as`, `is`, `keyof`, `readonly`, `boolean`, `number`, `string`, `null`, `undefined`, `true`, `false`. Use descriptive alternatives: `type` → `entityType` / `classification` / `category`; `class` → `tier` / `category`; `default` → `fallback` / `defaultValue`. The `submit_pipeline` validator rejects reserved-word port names with `ZOD_PARSE_ERROR`.

---

## 9. Anti-patterns to avoid (legacy mistakes)

The generator MUST NOT produce:

- ❌ Multiple verification stages with `exclusive_write_group` (legacy schema, kernel-next doesn't support it)
- ❌ `subject_type` if-else branches inside any stage's prompt (the type is decided once in R2 and consumed downstream)
- ❌ `.workflow/*.md` mid-stage file passing
- ❌ More than 1 human gate
- ❌ `task_mode = full | explore` branching of any kind
- ❌ Per-atom stages or per-atom output ports (causes port explosion — atoms dispatch within prompts)
- ❌ Separate factCheck + finalReview stages with overlapping responsibilities (consolidate into one adversarial fact-check + format/completeness check)
- ❌ `[Inference]` as a tier label (it's a prose annotation; only 5 tier labels exist per §4.2)
- ❌ More than 5 verification tier labels
- ❌ Any verification path that uses store data as evidence (only adversarial fact-check needs external fetch, but its prompt MUST explicitly forbid using prior store outputs as proof)
- ❌ Stage outputs whose `type` is `"unknown"` for everything (this destroys the IR's typing benefit — use real TS literals)

---

## 10. Acceptance criteria (capability-based, not shape-based)

After the generator produces the IR, we verify *capabilities*, not stage count. The IR is acceptable if and only if:

1. ✅ Has a Scope responsibility that takes `taskDescription` and emits target + research questions + assumptions
2. ✅ Has exactly **one** human gate immediately after Scope, before any expensive downstream work
3. ✅ Has a Type-classification responsibility producing `entityType` (string), `typeReasoning` (string), `typeConfidence` (string), `atomSet` (string[]) — port name MUST be `entityType` (not `type`, which is a TS reserved word)
4. ✅ The Type-classification stage's prompt contains the §6.2 priority table verbatim or an equivalent algorithm
5. ✅ The atom-driven analysis prompt references at least **10** of the §5 atoms by id (proving the generator absorbed the library)
6. ✅ The atom-driven analysis stage emits the analysis as **a single markdown port** (not per-atom typed ports)
7. ✅ The adversarial fact-check stage's prompt explicitly forbids using prior store data as verification AND mandates ≥3 external URL fetches AND lists §4.9 outlier smell tests
8. ✅ All agent stages reference globalConstraints (the §4 content) as a system prompt fragment
9. ✅ The final deliverable is emitted as a markdown string port (not a file path)
10. ✅ The IR contains no `condition` / `human_confirm` / `foreach` legacy types — only `agent` / `script` / `gate`
11. ✅ Stage output ports use real TS-literal types (not `"unknown"` everywhere)
12. ✅ Prompts reference MCP tools as `mcp____kernel_next____<tool>` (4 underscores)
13. ✅ Type-classification's `entityType` port is consumed (via wire) by every downstream stage that branches on type
14. ✅ Atom set's `atomSet` port is consumed by the atom-driven analysis stage
15. ✅ `session_mode == "multi"`
16. ✅ A `store_schema` is populated and every produced_by points at a real port
17. ✅ Cost envelope per stage sums plausibly within $15 (sum of `max_budget_usd` ≤ $15)

If the generator's IR fails any of 1-12, that's a generator bug. If it fails 13-17, that's a generator quality issue.

---

## 11. Appendix: relationship to the old pipeline

The old `web3-tech-research.yaml` (672 lines, 17 stages) made these mistakes that this spec corrects:

| Old mistake | New approach |
|---|---|
| `subject_type` 6-way if-else inside every prompt | Type chosen once at R2, downstream stages consume `type` + `atomSet` |
| `task_mode = full \| explore` branches diverge for multiple stages | No mode field; `domain-landscape` is just one type |
| 4 verification stages with `exclusive_write_group` | One on-chain verification responsibility (R5); style differs by atomSet |
| 3 human gates | 1 gate after R1 |
| `.workflow/*.md` files as data carriers between stages | All data through typed ports; final deliverable is a markdown port |
| `factCheck` + `finalReview` blurred responsibilities | Single adversarial fact-check responsibility (R8) covers fact + format + completeness |
| 13 verification tier labels | 5 tiers + inline `[Inference]` annotation |
| 17 stages, ~$30-40 per run | Generator decides stage count; soft target ≤ $15 / 15 min |

---

End of task description for pipeline-generator.
