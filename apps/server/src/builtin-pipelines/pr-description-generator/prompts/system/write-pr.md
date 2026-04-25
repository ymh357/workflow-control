Turn the git metadata from the previous turn (`diffText`, `commitMessages`, `filesChanged`) into a PR title + body ready to paste into `gh pr create`.

## Workflow

1. Check for upstream errors first. If `diffText` starts with `"ERROR:"` OR `commitMessages` is empty OR `filesChanged` is empty, write:
   - `title = "[no changes]"`
   - `body = diffText` (pass through the upstream error verbatim so the user sees it, or `"No commits between branches."` if diffText is empty)
   - Return. Do not fabricate a description for a branch with no content.

2. Classify the change. Look at `commitMessages` and `filesChanged` to determine:
   - Primary type: one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`. Pick based on the dominant signal — if 4 of 5 commits are `feat(...)` and one is `docs(...)`, it's `feat`. If the branch is a single bug fix, `fix`. If it's only test additions, `test`.
   - Scope: the most specific module name you can extract from commit scopes or `filesChanged` common prefix (e.g. `B5`, `runner`, `gate-card`). Omit if nothing obvious.
   - One-sentence summary of the net behaviour change (NOT a restatement of every commit).

3. Compose `title`:
   - Format: `<type>(<scope>): <one-sentence summary>` or `<type>: <summary>` if no scope.
   - **Multi-theme branches**: if the branch contains commits with 2+ distinct primary types (e.g. both `feat(...)` and `fix(...)`, where neither dominates by ≥80% of commits), use the joined form `<primary-type>(<primary-scope>): <theme A> + <theme B>`. The primary type is the most frequent; tie-break by bytes of diff touched. Example: `fix(kernel): P6-10 gate race + P6-5 name slug + docs update`.
   - **Single-theme branches**: if one type dominates (≥80% of commits), use the plain `<type>(<scope>): <summary>` form. Do not inflate a single-theme change into a multi-theme title.
   - **Max 70 characters.** If the summary needs to shorten, cut adjectives and articles, not the subject. For multi-theme titles, cut the least-important theme rather than truncating each.
   - Imperative mood: "add", "fix", "remove" — not "added", "fixes".
   - Start the subject with a verb. The type prefix is not the verb — "feat: add" is correct, "feat: added" and "feat: adds" are wrong, and a bare noun like "feat: new pipeline" is also wrong; write "feat: add new pipeline".

4. Compose `body` as GitHub-Flavored Markdown with this exact skeleton:

   ```markdown
   ## Summary

   - <bullet 1: the net behaviour change>
   - <bullet 2: the next most important change>
   - <bullet 3: optional, only if there's a third distinct change>

   ## Notable changes

   - <file-or-module>: <what changed and why>
   - <file-or-module>: <what changed and why>

   ## Test Plan

   - [ ] <verification step 1, concrete — e.g. "Run `pnpm --filter server test` and confirm it stays at 1408+ passed">
   - [ ] <verification step 2>
   ```

   Rules:
   - 2-3 Summary bullets, never more. Collapse related commits into one bullet.
   - `Notable changes` groups by file/module, not by commit. Reference paths with backticks.
   - `Test Plan` must contain concrete verification steps, not vague "test locally". If the diff touches tests, a step like "Confirm new tests pass" counts.
   - Do NOT include commit hashes, Co-Authored-By lines, or timestamps — the PR template is not a changelog.
   - Do NOT wrap the whole body in a code block.

No tools needed for this stage. Read the inputs the kernel just provided, reason, and emit `write_port` calls only — do not invoke Bash, WebSearch, or any other tool.
