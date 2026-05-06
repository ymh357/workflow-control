# Forge Quickstart

How to make Forge's MCP tools callable from any Claude Code session.

---

## What you get

After this 3-step setup, finishing a Claude Code session and saying

> Use `forge_analyze_start` + `forge_analyze_result` to find pipelines I should make from this session.

…lets the agent invoke Forge's MCP tools, which read the session
JSONL, distill it into episodes, match each against existing
workflow-control pipelines, and reply with one recommendation per
pipeline-able episode — either "run existing pipeline X" or "create a
new one (here's the paste-ready prompt)".

The 2026-05-05 update split the original single `forge_analyze`
tool into a sub-second async pair (`forge_analyze_start` returns
an `analysisId` immediately; `forge_analyze_result` polls for
completion with a `waitMs` block) — distillation typically takes
60–180 s, exceeding the ~60 s MCP tool-call timeout. A third tool
`forge_analyze_recent` kicks off N (default 3, max 10) analyses on
the most recent sessions in parallel for "summarise my recent work"
queries.

---

## Step 1 — Start the server

In one terminal, leave this running:

```bash
cd /Users/minghao/workflow-control
pnpm --filter @workflow-control/server dev
```

Server listens on `http://localhost:3001`. Health check:

```bash
curl -s http://localhost:3001/api/forge/health
# {"ok":true,"mode":"manual",...}
```

## Step 2 — Register the MCP server with Claude Code

Add the workflow-control MCP server to the Claude Code config. The
canonical location is `~/.claude.json` (project-local override at
`<project>/.claude.json`). Add or merge into the `mcpServers` block:

```json
{
  "mcpServers": {
    "workflow-control": {
      "type": "http",
      "url": "http://localhost:3001/api/mcp"
    }
  }
}
```

After this, Claude Code's next-launched session will discover **37
tools** under the `workflow-control` server, including
`forge_analyze_start` / `forge_analyze_result` / `forge_analyze_recent`,
`run_pipeline`, `submit_pipeline`, etc.

To verify from inside a Claude Code session, ask the agent to list
its tools — it should report `forge_analyze_start` among them.

## Step 3 — Use it

Two equivalent invocation paths:

### From inside Claude Code

After finishing real work in a session, ask the agent:

> Run Forge on this session. Tell me which existing pipelines I could
> re-run for this kind of work, and which parts I should turn into a
> new pipeline.

The agent calls `forge_analyze_start` with no args (auto-detects the
most recent session JSONL under `~/.claude-personal/projects/`),
then `forge_analyze_result` with `waitMs: 50000` — that single poll
typically returns the final result. The response carries
`recommendations: [...]` and a `humanSummary` line the agent reads to
you.

For "summarise my recent work" instead of one specific session, ask:

> Use `forge_analyze_recent` with default count to scan my last 3
> sessions in parallel.

That returns 3 analysisIds immediately; the agent polls each via
`forge_analyze_result`.

### From the web UI

Open `http://localhost:3001` (or wherever your web app is configured),
click **Forge** in the nav, click **Forge Now**. Same backend, same
result.

---

## What "good output" looks like

For a session where you fixed a bug, added a test, and wrote a doc,
expect roughly:

```
3 episodes detected: 1 use-existing, 2 create-new.

Recommendations:
  1. [USE EXISTING] "Add a test case to an existing test file" →
     run pipeline 'add-test-case' (cosine 0.81).
  2. [CREATE NEW] "Fix the FK violation in session_loader" →
     propose pipeline 'fix-fk-violation-in-session_loader'.
     Paste the included pipelineGeneratorPrompt into pipeline-generator.
  3. [CREATE NEW] "Update whitepaper §1.4 to reflect Forge" →
     propose pipeline 'update-whitepaper-1-4'.
```

The "create new" branches each carry a `pipelineGeneratorPrompt`
you (or the agent) paste verbatim into `pipeline-generator` to
generate the IR.

---

## Troubleshooting

### "Tool not found: forge_analyze_start" inside Claude Code

The MCP config didn't take effect, or the server isn't running.
Check:

1. `curl -s http://localhost:3001/api/forge/health` returns `{"ok":true,...}`.
2. `~/.claude.json` has the `workflow-control` entry under `mcpServers`.
3. You **opened a new Claude Code session** after editing the config.
   In-flight sessions don't pick up new MCP servers.

### Analyze returns `LOAD_FAILED` or `NO_SESSION_FOUND`

- `LOAD_FAILED`: the JSONL path doesn't exist. If you passed an
  explicit `jsonlPath`, check it. If you passed nothing, Forge tried
  to auto-detect under `~/.claude-personal/projects/<encoded-cwd>/`
  and found nothing — happens for fresh installs with no prior
  Claude Code activity.
- `NO_SESSION_FOUND`: same root cause, different code path.

### Analyze is slow (60+ seconds)

Expected. The distillation step calls Claude SDK with the session
events as input; for a multi-hour session it may need 30–90 seconds
of agent thinking. If it's >5 minutes, check server logs for
`forge-distill` task errors.

### All my recommendations come back as `create-new`

Means none of your existing pipelines match the work in this session
(cosine < 0.78 against every cached pipeline descriptor). Either:

- **Genuinely new work** — fine, that's exactly what create-new is for.
- **Sessions with very generic intents** — the local-hash embedder
  has limited semantic depth. If you have a `VOYAGE_API_KEY` or
  `OPENAI_API_KEY`, set `forge.embedding.provider` in
  `system-settings.yaml` to `voyage` or `openai` for substantially
  better matching.

---

## Privacy note

Session JSONL contents are persisted to a local `forge.db` (next to
kernel-next.db under `data_dir`) for indexing. Before any text is
written there *or* sent to any external API (embedding provider, if
configured), it passes through `redactor.ts` which masks GitHub PATs,
OpenAI/Anthropic-style API keys, Slack tokens, AWS access keys, and
Bearer-prefixed tokens. The default embedder runs fully locally with
no network access.

If you're paranoid, leave the embedding provider on the default
(`local-hash`) and Forge never makes any outbound network call beyond
the Claude SDK calls that the `forge-distill` builtin makes (those
inherit your existing Claude Code auth).
