# Workflow Control

Config-driven autonomous agent workflow engine.
It breaks complex engineering tasks into orchestrated, observable,
recoverable pipeline stages — executed by AI agents, automation scripts,
and human checkpoints.

> **Config-driven**
> Pipelines are YAML files. Add stages, adjust models, set budgets,
> rewire routing — no code changes. Ship a new workflow by editing a file.

> **Observable**
> Every agent thought, tool call, and cost tick streams to the dashboard
> in real time via SSE. You know what the agent is doing and what it costs.

> **Recoverable**
> Tasks persist across server restarts. On failure, the task enters
> `blocked` — inspect, fix, retry without losing prior work.

## Two Execution Modes

> **Web Mode (Dashboard)**
> The server runs agent stages in-process via the Claude Agent SDK or Gemini CLI subprocess.
> - Full SSE streaming to dashboard
> - All pipeline options supported (model, effort, thinking, max_turns, budget, sub-agents)
> - Best for: hands-off orchestration, team visibility

> **Edge Mode (Terminal)**
> The Edge Runner spawns Claude/Gemini CLI processes locally via PTY. Interactive terminal access.
> - Direct keyboard interaction with the agent
> - Command mode: cancel, pause, send messages
> - Pipeline options: model, effort, permission_mode, debug, disallowed_tools, agents
> - Best for: debugging, interactive sessions, local development

Both modes share the same pipeline definitions, state machine, and data store.
You can start a task from the dashboard and re-attach from the terminal, or
trigger via CLI and monitor on the web.

## Why not just use Claude Code / Gemini CLI directly?

| | Direct CLI | Workflow Control |
|---|---|---|
| Structure | Single session, free-form. | Pipeline stages enforce execution order with defined inputs and outputs. |
| Cost control | Global budget, hope for the best. | Per-stage budget caps. Human gates before expensive stages. Real-time cost tracking. |
| Failure recovery | Session dies, start over. | State persists. Retry from the exact failure point with full prior context. |
| Visibility | Terminal output scrolls past. | SSE-streamed dashboard with message filtering, stage timeline, and cost breakdown. |
| Reproducibility | Depends on what you typed. | YAML pipeline + versioned prompts = same process every time. |
| Tool integration | Manual MCP setup per session. | MCP registry configured once, selectively enabled per stage. |

## Quick Start

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | >= 20 | Required for node:sqlite |
| pnpm | any | npm install -g pnpm |
| gh CLI | any | Authenticated via gh auth login |
| Claude Code or Gemini CLI | any | At least one on PATH |
| Slack App | optional | Bot Token + App Token for interactive Slack notifications |

### Installation

```bash
# terminal
git clone <repo-url> && cd workflow-control
pnpm install
pnpm setup        # Interactive: MCPs, .env.local, preflight
pnpm dev          # Server (:3001) + Dashboard (:3000)
```

### First task

> **Via Dashboard**
> Open `http://localhost:3000`, type a task description,
> select a pipeline, and click Create. The task starts automatically.

> **Via Edge Runner**
> ```
> pnpm edge -- --trigger "Your task" \
>   --pipeline pipeline-generator
> ```
