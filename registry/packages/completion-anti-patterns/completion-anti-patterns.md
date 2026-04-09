---
id: completion-anti-patterns
keywords: [complete, done, finish, final, ship, deploy, merge]
stages: "*"
---

## Completion Verification Protocol

### The Iron Rule
NO completion claim WITHOUT fresh verification evidence from THIS session.

### Verification Gate (run before EVERY completion claim)
1. IDENTIFY — what command proves this claim?
2. RUN — execute the full command (fresh, complete)
3. READ — read the entire output, check exit code, count failures
4. VERIFY — does the output confirm the claim?
5. ONLY THEN — make the claim

### Red Flags (if you catch yourself doing these, STOP)
- Using "should", "probably", "seems to", "looks like" in a completion claim
- Expressing satisfaction ("Great!", "Done!", "Fixed!") before running verification
- Trusting a previous run's output after making changes
- Claiming "all tests pass" without the test runner output in this message
- Saying "no changes needed" without reading the current file state

### The Anti-Pattern Table
| What you want to say | What you must do first |
|---|---|
| "The build passes" | Run `npm run build` and show exit code 0 |
| "All tests pass" | Run the test suite, show 0 failures in output |
| "The type errors are fixed" | Run `tsc --noEmit` and show clean output |
| "The linter is clean" | Run the linter and show 0 errors/warnings |
| "This is backwards compatible" | Show the old API still works with a test |
