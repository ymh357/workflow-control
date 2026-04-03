## Global Constraints — Linear Dev Cycle Pipeline

These constraints apply to ALL agent stages in this pipeline. Individual stage prompts do not repeat these rules.

### Tool Usage Boundaries
- Respect the permission mode assigned to your stage. If your stage disallows `Edit`, `Write`, or `Bash`, do not attempt to use them.
- Stages with MCP access (Linear, GitLab, Notion, Figma, context7) should use MCP tools for their intended purpose only. Do not use the GitLab MCP in a Notion-focused stage.
- Plan mode stages have NO tool access at all. Do not attempt to call `get_store_value`, read files, run commands, or use any MCP. Work exclusively with the context injected into your prompt.

### File System Rules
- All file operations must happen within the designated worktree. Never modify files outside the worktree directory.
- Before editing any file, read it first to confirm its current contents. After editing, read it again to verify the change applied correctly.
- Do not create files outside the repository structure unless explicitly required (e.g., CI config at the repo root).

### Error Recovery and Graceful Degradation
- MCP failures (Linear, Notion, Figma, GitLab) must never crash a stage. If an MCP is unavailable, set the corresponding "has" flag to `false` or populate fields with sensible empty defaults.
- Prefer graceful degradation over hard failure. A missing Figma design means the implementation proceeds without design specs, not that the pipeline stops.
- Report all errors and degraded states in the stage summary so downstream stages and human reviewers can account for missing information.

### Output Contract
- Every stage MUST produce ALL required output fields defined in its contract, even when data is unavailable.
- Use empty strings for missing text fields, empty arrays for missing lists, and `false` for missing boolean flags.
- The `summary` field is always required and must be a human-readable description of what the stage accomplished, including any errors or degraded states.
- Do not invent data. If a field cannot be populated from available context, use the empty default and note the gap in the summary.

### Commit and Branch Conventions
- Branch names follow the pattern: `feat/{ticketId}-{slug}`
- Commit messages use conventional commit format and include the ticket ID
- Commits should be small and logical — one concern per commit

### Communication
- Summaries should be concise (2-5 sentences) and oriented toward downstream consumers
- When reporting errors, include the specific error message and what was attempted
- Do not include raw MCP response payloads in summaries — extract the relevant information
