---
id: testing-anti-patterns
keywords: [test, testing, spec, jest, vitest, playwright]
stages: [implementing, testing, qaReview]
---

## Testing Anti-Patterns (DO NOT DO THESE)

### Mock Abuse
- NEVER test mock behavior instead of real behavior. `expect(mockFn).toHaveBeenCalled()` alone proves nothing — it tests that YOUR test called the mock, not that the component works.
- NEVER add test-only methods to production classes. If you need to inspect internal state, extract it to a testable unit or use integration tests.
- NEVER add mocks without understanding what the real dependency does. If you don't know the real API shape, read the source first.
- Mocks MUST mirror the real API's complete structure. A partial mock hides integration failures.

### False Confidence
- A test that passes immediately on first write is testing existing behavior or is wrong. New behavior tests MUST fail first (Red-Green cycle).
- "Manual testing confirmed it works" is not a substitute — it's temporary, non-repeatable, and incomplete.
- Linter passing != build passing != tests passing. Each requires independent verification.

### Completion Claims
- NEVER say "tests pass" without running them in this session and reading the output.
- NEVER say "should work" or "looks correct" — run the command and prove it.
- NEVER trust cached test results — re-run after every change.

### Structural
- One assertion per test behavior. A test with 10 assertions is 10 tests pretending to be one.
- Test names describe behavior, not implementation: "rejects expired tokens" not "tests validateToken function".
- Test the public API, not internal implementation. If refactoring breaks tests but behavior is unchanged, the tests were wrong.
