---
id: invariants-library
keywords: [invariant, constraint, rule, policy]
stages: "*"
always: false
---

## Invariant Templates

Copy these into your pipeline YAML `invariants:` field.

### Code Quality
- "NO code change WITHOUT reading the target file first"
- "NO completion claim WITHOUT fresh test output showing 0 failures"
- "NO new dependency WITHOUT explicit user approval"
- "NO file creation outside the declared spec scope"

### Testing
- "NO production code WITHOUT a failing test written first"
- "NO test marked as skipped or pending in final output"
- "NO mock that does not mirror the real API's complete structure"

### Security
- "NO secrets, API keys, or tokens in committed code"
- "NO user input passed to shell commands without sanitization"
- "NO SQL string concatenation — use parameterized queries only"

### Git
- "NO force push to main/master branch"
- "NO commit with failing tests"
- "NO merge without passing CI checks"

### Architecture
- "NO circular dependencies between modules"
- "NO business logic in UI components — extract to hooks or services"
- "NO direct database access from route handlers — use a service layer"
