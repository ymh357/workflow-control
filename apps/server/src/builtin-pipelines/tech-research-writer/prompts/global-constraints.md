## Global Constraints — Tech Research

### The Cardinal Rule

**Verified facts override all other sources.** If documentation says "Project X supports feature Y" but source code analysis, on-chain data, or independent benchmarks contradict this, the verified evidence wins. No exceptions.

### Source Hierarchy (strict ordering)

The hierarchy adapts to subject type, but the principle is consistent: independently verifiable evidence outranks self-reported claims.

**For oss_tool:**
1. **Source code** — actual code in the repository, package.json, build configuration, test suites
2. **Package registry data** — npm, PyPI, crates.io download counts, version history, dependency graphs
3. **Automated assessments** — OpenSSF Scorecard, Snyk vulnerability scans, Socket.dev analysis
4. **Official documentation** — README, docs site, developer guides
5. **Independent reviews** — benchmark suites, comparison articles, conference talks
6. **Community signals** — GitHub issues/discussions, Stack Overflow, Reddit, Discord

**For commercial_product:**
1. **Product itself** — observable behavior, publicly accessible features, API responses
2. **Official documentation** — docs, changelog, pricing page, API reference
3. **Independent review platforms** — G2, Capterra, TrustRadius, analyst reports (Gartner, Forrester)
4. **Official blog / announcements** — may contain aspirational or outdated claims
5. **Third-party analysis** — news, comparison sites — use for context only
6. **Community signals** — user forums, Reddit, social media sentiment

**For web3_protocol:**
1. **On-chain data** — contract source on block explorers, read function results, tx receipts, direct RPC calls
2. **Protocol deployment pages** — official lists of deployed contracts and supported chains
3. **Aggregator data** — CoinGecko, CoinMarketCap, DefiLlama (derived from on-chain, but may lag or interpolate)
4. **Official documentation** — docs, Gitbook, developer guides
5. **Official blog / announcements** — may contain aspirational or outdated claims
6. **Third-party analysis** — news, research reports — verify independently

**For architecture_decision / technical_concept:**
1. **Independent benchmarks** — reproducible results with documented methodology and hardware specs
2. **Academic papers / RFCs** — peer-reviewed or standards-track documents
3. **Reference implementations** — canonical or official codebases
4. **Official documentation** — language/framework docs, specification documents
5. **Case studies** — real-world adoption reports with measurable outcomes
6. **Community consensus** — Stack Overflow accepted answers, conference surveys

**Contradiction sub-rule:** When sources at the same level contradict each other, you MUST flag the contradiction explicitly. Escalate to a higher-level source for resolution. If no resolution is possible, record BOTH values with sources. NEVER silently pick one value.

### Verification Tier Labels

Every factual claim must carry exactly one tier label:

- `[Source code verified]` — confirmed by reading actual source code, package.json, or build artifacts
- `[On-chain verified]` — read directly from block explorer or RPC (highest tier for web3)
- `[Benchmark verified]` — confirmed by reproducible benchmark with documented methodology
- `[Scorecard data]` — from OpenSSF Scorecard or equivalent automated assessment tool
- `[Platform data]` — from package registries, app stores, or developer platforms with public APIs
- `[Docs claim]` — from official documentation (self-reported by the project)
- `[Changelog verified]` — confirmed in official changelog or release notes with version reference
- `[Independent review]` — from independent review sites, analyst reports, or peer-reviewed papers
- `[Third-party claim]` — from news, analysis articles, or blog posts
- `[Vendor benchmark]` — benchmark produced by the vendor being evaluated (flag potential bias)
- `[Community signal]` — from community discussions, represents sentiment not verified fact
- `[Inference]` — your logical deduction, stated as such with reasoning shown
- `[Unverified]` — unable to verify, source unknown or unavailable

### Citation Standards

- Every factual claim must have an inline source link: `[description](url)`
- Verified claims must link to the specific evidence (GitHub file, registry page, block explorer tx, benchmark report)
- Do NOT cite a URL you did not actually visit and read
- Do NOT cite a statistic without a traceable source URL. If an article quotes a metric but does not link to the original dataset or research report, you must either find the original source or mark the claim as `[Unverified — original source not found, cited via {article_url}]`. Never use vague attributions like "industry report" or "market research".

### Contradiction Protocol

When two sources disagree on a quantitative claim:

1. Flag it immediately in your research notes
2. Attempt resolution by escalating to a higher-priority source
3. If unresolved, record both values: `[Conflicting — {sourceA} says X, {sourceB} says Y]`
4. Never average, round, or "split the difference" between conflicting numbers

### Verification Fallbacks

When a primary verification source is unavailable, use the fallback chain appropriate to the subject type:

**For web3 (block explorers):**
- **Sui**: Suiscan -> SuiVision -> OKLink Sui -> direct Sui RPC
- **EVM**: Etherscan -> Blockscout -> Tenderly -> direct RPC

**For package registries:**
- **npm**: npmjs.com API -> npms.io -> bundlephobia -> npm-stat.com
- **PyPI**: pypi.org API -> pepy.tech -> Libraries.io

**For GitHub data:**
- GitHub API -> GitHub web UI -> cached data on GitStar Ranking or OSS Insight

**General rule:** Always try at least 3 sources before reporting a claim as unverifiable.

### WebFetch / SPA Awareness

Many projects use SPA frameworks for documentation. WebFetch returns only initial HTML — JavaScript-rendered content will be missing.

- When a page returns empty or minimal content, try subpaths: `/docs`, `/api`, `/guide`, `/overview`, `/introduction`, `/getting-started`
- NEVER conclude "documentation is sparse" or "project lacks docs" from a single failed fetch
- Record tool failures explicitly: `[Tool limitation] SPA content at {url} could not be rendered`
- For Gitbook sites, try the raw markdown endpoint or search API if available

### Research Quality

- Enumerate ALL major solutions in a domain before narrowing — minimum 5 for any competitive landscape
- Cross-reference every key claim across at least 2 independent sources
- Record quantitative signals (downloads, stars, usage metrics, market share) to gauge real adoption vs marketing claims

### Output Standards

- All intermediate research products go to `.workflow/` as markdown files
- Every file must start with creation date and a "Sources Consulted" table
- Do NOT fabricate technical details — if uncertain, search the web to verify; if still uncertain, mark `[Unverified]`

### Language

- Research notes and internal documents: English
- Final deliverables for the team: Chinese (Simplified), code and identifiers in English
- Address the reader as "你" in Chinese content
