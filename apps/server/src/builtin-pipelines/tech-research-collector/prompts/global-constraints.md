## Global Constraints — Tech Research

### The Cardinal Rule

**Independently verified facts override all other sources.** On-chain facts override docs for Web3. Source code overrides docs for open-source. Independent benchmarks override vendor claims. No exceptions.

### Source Hierarchy (subject-type-aware)

The source hierarchy varies by subject type. Higher-tier sources override lower-tier sources when they conflict.

**web3_protocol:**
1. On-chain data — contract source on block explorers, read function results, tx receipts, direct RPC calls
2. Official documentation — docs.project.xyz, developer guides, Gitbook sites, whitepapers
3. Aggregator data — CoinGecko, CoinMarketCap, DefiLlama (derived from on-chain, but may lag or interpolate)
4. Third-party analysis — news, research reports
5. Community signals — Reddit, Discord, Twitter sentiment

**oss_tool:**
1. Source code — direct inspection of repository code, build output, dependency manifests
2. GitHub metrics — stars, commit frequency, contributor count, issue response time (via GitHub API)
3. Community feedback — GitHub Issues, Discussions, Reddit, StackOverflow, Discord
4. Official documentation — README, docs site, CHANGELOG, release notes
5. Benchmarks — independent performance comparisons, user-published benchmarks

**commercial_product:**
1. Official product docs — product pages, pricing pages, API reference, changelogs
2. Independent reviews — G2, Capterra, TrustRadius, independent benchmark publications
3. Community feedback — Reddit, forums, StackOverflow, user-published case studies
4. Vendor marketing — blog posts, announcements, press releases
5. Analyst reports — Gartner, Forrester, IDC

**technical_concept:**
1. Academic papers — peer-reviewed publications, arXiv preprints with citations
2. Reference implementations — canonical or widely-adopted implementations
3. RFCs / standards — IETF, W3C, IEEE specifications
4. Official documentation — language/framework docs that describe the concept
5. Tutorials / courses — educational content from credible sources

**architecture_decision:**
1. Benchmark data — independently reproduced benchmarks with disclosed methodology
2. Source code (if OSS) — direct inspection of implementation
3. Community experience — production case studies, post-mortems, architecture decision records
4. Official documentation — per-product/technology official docs
5. Analyst reports — technology comparison reports with methodology

**Contradiction sub-rule:** When sources at the same level contradict each other, you MUST flag the contradiction explicitly. Escalate to a higher-level source for resolution. If no resolution is possible, record BOTH values with sources. NEVER silently pick one value.

### Verification Tier Labels

Every factual claim must carry exactly one tier label:

**Tier 1 — Direct verification:**
- `[Source code verified]` — confirmed by direct inspection of source code, build output, or binary analysis
- `[On-chain verified]` — read directly from block explorer or RPC
- `[Benchmark verified]` — independently reproduced benchmark with methodology disclosed

**Tier 2 — Platform data:**
- `[Scorecard data]` — OpenSSF Scorecard automated scan results
- `[Platform data]` — GitHub API metrics, npm download stats, CoinGecko, DefiLlama, G2 ratings

**Tier 3 — Official claims:**
- `[Docs claim]` — from official documentation, README, whitepaper
- `[Changelog verified]` — claim verified against published changelog or release notes

**Tier 4 — Third-party sources:**
- `[Independent review]` — from G2, Capterra, TrustRadius, or independent benchmark publications
- `[Third-party claim]` — from news articles, analyst reports, blog posts
- `[Vendor benchmark]` — performance data published by the vendor themselves (potential bias)

**Tier 5 — Community:**
- `[Community signal]` — Reddit, Discord, GitHub Issues/Discussions sentiment, StackOverflow answers

**Tier 6 — Inference:**
- `[Inference]` — your logical deduction, stated as such

**Tier 7 — Unverified:**
- `[Unverified]` — unable to verify from any source

### Citation Standards

- Every factual claim must have an inline source link: `[description](url)`
- On-chain facts must link to the specific block explorer page (tx, address, or code tab)
- Source code facts must link to the specific file or line in the repository
- Do NOT cite a URL you did not actually visit and read
- Do NOT cite a statistic without a traceable source URL. If an article quotes "250K daily active agents" but does not link to the original dataset or research report, you must either find the original source or mark the claim as `[Unverified — original source not found, cited via {article_url}]`. Never use vague attributions like "industry report" or "market research".

### Contradiction Protocol

When two sources disagree on a quantitative claim (TVL, supply, fee, date, price, benchmark result, etc.):

1. Flag it immediately in your research notes
2. Attempt resolution by escalating to a higher-priority source
3. If unresolved, record both values: `[Conflicting — {sourceA} says X, {sourceB} says Y]`
4. Never average, round, or "split the difference" between conflicting numbers

### Block Explorer Fallback

A single explorer returning 403/timeout is NOT grounds to abandon verification. Use the fallback chain:

- **Sui**: Suiscan -> SuiVision -> OKLink Sui -> direct Sui RPC
- **EVM**: Etherscan -> Blockscout -> Tenderly -> direct RPC
- **General**: Always try at least 3 sources before reporting a claim as unverifiable

### GitHub API Fallback

When GitHub API returns 403 (rate limited) or 429 (too many requests):

1. **Web-accessible repo page**: Fall back to scraping the repository's web page (github.com/{org}/{repo}) for star count, language breakdown, last commit date, and contributor count visible on the page.
2. **star-history.com**: Use `https://star-history.com/#org/repo&Date` to retrieve star history trends as a proxy for adoption trajectory.
3. **Alternative APIs**: Try the GitHub GraphQL API if REST API is blocked, or vice versa.
4. **Record the limitation**: Note `[GitHub API rate-limited — data from web fallback]` on any metrics obtained via fallback.
5. Never report "unable to determine GitHub metrics" without attempting all fallback methods.

### WebFetch / SPA Awareness

Many projects use Gitbook, Docusaurus, or SPA frameworks. WebFetch returns only initial HTML — JavaScript-rendered content will be missing.

- When a page returns empty or minimal content, try subpaths: `/tokenomics`, `/architecture`, `/overview`, `/introduction`, `/concepts`, `/getting-started`, `/pricing`, `/changelog`
- NEVER conclude "documentation is sparse" or "project lacks docs" from a single failed fetch
- Record tool failures explicitly: `[Tool limitation] SPA content at {url} could not be rendered`
- For Gitbook sites, try the raw markdown endpoint or search API if available

### Research Quality

- Enumerate ALL major solutions in a domain before narrowing — minimum 5 for any competitive landscape
- Cross-reference every key claim across at least 2 independent sources
- Record quantitative signals (supply, TVL, tx count, active addresses, GitHub stars, npm downloads, pricing tiers, benchmark results) to gauge real adoption vs marketing claims

### Output Standards

- All intermediate research products go to `.workflow/` as markdown files
- Every file must start with creation date and a "Sources Consulted" table
- Do NOT fabricate technical details — if uncertain, search the web to verify; if still uncertain, mark `[Unverified]`

### Language

- Research notes and internal documents: English
- Final deliverables for the team: Chinese (Simplified), code and identifiers in English
- Address the reader as "你" in Chinese content
