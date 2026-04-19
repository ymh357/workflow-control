## Global Constraints — Web3 Tech Research

### The Cardinal Rule

**On-chain facts override all other sources.** If documentation says "Project X uses Protocol Y" but the deployed contract inherits from Protocol Z, the on-chain fact wins. No exceptions.

### Source Hierarchy (strict ordering)

1. **On-chain data** — contract source on block explorers, read function results, tx receipts, direct RPC calls
2. **Protocol deployment pages** — official lists of deployed contracts and supported chains
3. **Aggregator data** — CoinGecko, CoinMarketCap, DefiLlama (derived from on-chain, but may lag or interpolate). Preferred over docs for live market metrics (price, supply, volume, TVL).
4. **Official documentation** — docs.project.xyz, developer guides, Gitbook sites. Preferred over aggregators for design parameters (token allocation, vesting schedules, governance rules, architecture specs).
5. **Official blog posts / announcements** — may contain aspirational or outdated claims
6. **Third-party analysis** — news, research reports — use for context only, verify independently

**Contradiction sub-rule:** When sources at the same level contradict each other, you MUST flag the contradiction explicitly. Escalate to a higher-level source for resolution. If no resolution is possible, record BOTH values with sources. NEVER silently pick one value.

### Verification Tier Labels

Every factual claim must carry exactly one tier label:

- `[On-chain verified]` — read directly from block explorer or RPC (Tier 1)
- `[Aggregator data]` — from CoinGecko, CoinMarketCap, DefiLlama (Tier 2) — NOT equivalent to on-chain
- `[Docs claim]` — from official documentation (Tier 3)
- `[Third-party claim]` — from news or analysis articles (Tier 4)
- `[Inference]` — your logical deduction, stated as such
- `[Unverified]` — unable to verify, source unknown or unavailable

### Citation Standards

- Every factual claim must have an inline source link: `[description](url)`
- On-chain facts must link to the specific block explorer page (tx, address, or code tab)
- Do NOT cite a URL you did not actually visit and read
- Do NOT cite a statistic without a traceable source URL. If an article quotes "250K daily active agents" but does not link to the original dataset or research report, you must either find the original source or mark the claim as `[Unverified — original source not found, cited via {article_url}]`. Never use vague attributions like "industry report" or "market research".

### Contradiction Protocol

When two sources disagree on a quantitative claim (TVL, supply, fee, date, etc.):

1. Flag it immediately in your research notes
2. Attempt resolution by escalating to a higher-priority source
3. If unresolved, record both values: `[Conflicting — {sourceA} says X, {sourceB} says Y]`
4. Never average, round, or "split the difference" between conflicting numbers

### Block Explorer Fallback

A single explorer returning 403/timeout is NOT grounds to abandon verification. Use the fallback chain:

- **Sui**: Suiscan -> SuiVision -> OKLink Sui -> direct Sui RPC
- **EVM**: Etherscan -> Blockscout -> Tenderly -> direct RPC
- **General**: Always try at least 3 sources before reporting a claim as unverifiable

### WebFetch / SPA Awareness

Many Web3 projects use Gitbook or SPA frameworks. WebFetch returns only initial HTML — JavaScript-rendered content will be missing.

- When a page returns empty or minimal content, try subpaths: `/tokenomics`, `/architecture`, `/overview`, `/introduction`, `/concepts`
- NEVER conclude "documentation is sparse" or "project lacks docs" from a single failed fetch
- Record tool failures explicitly: `[Tool limitation] SPA content at {url} could not be rendered`
- For Gitbook sites, try the raw markdown endpoint or search API if available

### Research Quality

- Enumerate ALL major solutions in a domain before narrowing — minimum 5 for any competitive landscape
- Cross-reference every key claim across at least 2 independent sources
- Record quantitative signals (supply, TVL, tx count, active addresses) to gauge real adoption vs marketing claims

### Output Standards

- All intermediate research products go to `.workflow/` as markdown files
- Every file must start with creation date and a "Sources Consulted" table
- Do NOT fabricate technical details — if uncertain, search the web to verify; if still uncertain, mark `[Unverified]`

### Language

- Research notes and internal documents: English
- Final deliverables for the team: Chinese (Simplified), code and identifiers in English
- Address the reader as "你" in Chinese content
