# Workflow Control

Config-driven autonomous agent workflow engine. Orchestrates multi-step software engineering tasks through YAML-defined pipelines, AI agent execution (Claude / Gemini), automation scripts, human checkpoints, conditional routing, sub-pipeline calls, and foreach iteration — with real-time observability, cost tracking, and failure recovery.

## Why

Using AI coding agents directly (Claude Code, Gemini CLI) works for small tasks. For larger efforts — analysis, implementation, review, PR creation — a single unstructured session lacks cost control, failure recovery, and reproducibility.

Workflow Control wraps these agents in a structured pipeline:

- **Pipeline stages** enforce execution order. Each stage has a defined goal, inputs, outputs, and budget.
- **Per-stage cost caps** and **human confirmation gates** prevent runaway spending.
- **Persistent snapshots** enable retry from any failure point without losing prior work.
- **Real-time SSE dashboard** streams every agent message with filtering, stage timeline, and cost breakdown.
- **YAML pipelines + versioned prompts** make workflows reproducible and shareable across teams.
- **Layered prompt system** — global constraints, project rules, knowledge fragments — guarantees consistent agent behavior.

## Architecture

```
apps/
  server/           Hono API (:3001) + XState v5 workflow engine + Agent SDK
    config/
      pipelines/    Pipeline YAML definitions + per-stage prompts
      mcps/         MCP server registry
      prompts/      Reusable knowledge fragments
  web/              Next.js 16 dashboard (:3000) — task management, monitoring, config editing
packages/
  shared/           TypeScript type contracts (Task, SSEMessage, API interfaces)
```

**Server**: Hono REST API. XState v5 state machine dynamically generated from pipeline YAML. Claude Agent SDK and Gemini CLI as execution backends. SQLite for SSE message history, JSON files for task snapshots.

**Dashboard**: Next.js + React 19 + Tailwind v4. SSE-driven real-time message stream with virtual scrolling. Monaco editor for pipeline config. Mermaid for pipeline visualization.

## Prerequisites

- **Node.js >= 20** (required for `node:sqlite`)
- **pnpm** — `npm install -g pnpm`
- **gh CLI** — [cli.github.com](https://cli.github.com) (authenticated via `gh auth login`)
- **Claude Code CLI** or **Gemini CLI** — at least one on PATH
- **Slack App** (optional) — Bot Token + App Token for interactive Slack notifications via Socket Mode

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/ymh357/workflow-control.git
cd workflow-control
pnpm install

# 2. Configure
cp apps/server/config/system-settings.yaml.example apps/server/config/system-settings.yaml
cp apps/server/.env.local.example apps/server/.env.local
# Edit .env.local — at minimum set REPOS_BASE_PATH to your projects directory

# 3. Install registry packages (pipelines, skills, hooks, fragments)
pnpm --filter server registry:build      # Build local registry index
pnpm --filter server registry:bootstrap  # Install default config packages from remote registry

# 4. Run interactive setup (validates config, checks CLI tools on PATH)
pnpm setup

# 5. Start
pnpm dev          # Server (:3001) + Dashboard (:3000)
```

Open `http://localhost:3000`. The **Config** page has a health panel to verify all services are reachable.

> **Minimal setup**: Only `claude` or `gemini` on PATH is required to run pipelines. Slack, Notion, Figma, and GitHub integrations are all optional — leave them blank in the config and the system works without them.

> `system-settings.yaml` supports `${ENV_VAR}` interpolation. Keep secrets in `.env.local`, not in the YAML file.

## Key Concepts

### Pipelines

A pipeline is a YAML file defining a sequence of stages:

| Stage Type | Engine | Purpose |
|---|---|---|
| `agent` | `llm` | AI agent execution (Claude or Gemini) with system prompt, MCP access, sub-agents |
| `script` | `script` | Deterministic automation (git branch, worktree, PR creation, build gate) |
| `human_confirm` | `human_gate` | Pause for human review with approve/reject/feedback routing |

Stages declare explicit data flow via `reads` (inputs from store) and `writes` (outputs to store). No implicit state access.

Pipelines support **mixed engines** — each stage independently specifies `claude` or `gemini`, so a single pipeline can leverage both models where each excels.

The Config page provides an **AI Generate** button: describe your workflow in natural language, select an engine, and the system generates a complete pipeline YAML via local CLI (`claude -p` or `gemini`). No additional API keys needed.

### Task Lifecycle

```
idle → drafting → [stage 1] → [stage 2] → ... → [stage N] → completed
                      ↓                              ↓
                   blocked (error) ←─────────────────┘
                      ↓ retry
                   [resume stage]

                   cancelled (user) → resume → [last stage]
```

Tasks snapshot their full pipeline config at creation. Global config changes never affect running tasks.

### Prompt System

Agent prompts are assembled from 6 layers (broadest → narrowest scope):

1. **Global constraints** — behavioral rules across all stages
2. **Project rules** — CLAUDE.md / GEMINI.md repository conventions
3. **Stage system prompt** — stage-specific instructions
4. **Knowledge fragments** — reusable domain knowledge, matched by keywords and stage
5. **Output schema** — auto-generated JSON format instructions
6. **Step prompts** — conditional instructions from enabled capabilities

### Data Flow

```
Stage A writes: [analysis]     →  store.analysis
Stage B reads: {plan: analysis.plan}  →  Tier 1 context (injected) + Tier 2 files (on-demand)
Stage C (script) reads: {title: analysis.title}  →  inputs parameter
```

### Registry / Store

The project includes a config package manager for sharing and installing reusable workflow components. Packages live in `registry/` and cover five types: **pipeline**, **skill**, **hook**, **fragment**, and **script**.

- `pnpm --filter server registry:build` — generates manifests and builds the registry index from `registry/`
- `pnpm --filter server registry:bootstrap` — installs the default package set (run once after fresh clone)

The dashboard **Store** page (`/registry`) provides a web UI for browsing, installing, publishing, and managing packages. Local config packages appear with a "local" badge and can be published to the remote registry directly from the Store page.

### Slack Integration

All `human_confirm` gates automatically send Slack notifications. With Socket Mode (`app_token` configured), notifications include interactive buttons — approve/reject gates, answer agent questions, and send messages to blocked tasks directly in Slack. Without `app_token`, notifications are text-only.

Config page Health tab shows Slack connection status (Bot Token / Socket Mode / Channel).

### Claude Code MCP Integration

The project includes a built-in MCP server that allows Claude Code to interact with the workflow engine directly — trigger tasks, confirm gates, check status, and more.

The project-level `.claude/settings.json` auto-configures the MCP connection. After starting the server (`pnpm dev`), Claude Code will automatically discover the `workflow-control` MCP server when opened in this directory.

If you need to configure it manually, add the following to your Claude Code settings:

```json
{
  "mcpServers": {
    "workflow-control": {
      "type": "url",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

### Edge Runner

For terminal-based execution without the dashboard, the edge runner executes a pipeline directly in your shell:

```bash
pnpm edge -- --trigger "Your task description" --pipeline pipeline-generator
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm setup` | Interactive first-time setup (MCP, env, preflight) |
| `pnpm dev` | Start server + dashboard in parallel |
| `pnpm dev:server` | Start server only |
| `pnpm dev:web` | Start dashboard only |
| `pnpm build` | Build all packages |
| `pnpm --filter server preflight` | Run environment preflight checks |
| `pnpm --filter server registry:build` | Build registry package index |
| `pnpm --filter server registry:bootstrap` | Install default config packages |
| `pnpm edge -- --trigger "..." --pipeline <name>` | Run a pipeline via edge runner |

## Documentation

The dashboard includes a comprehensive **Help** section (`/help`) covering:

- Overview & comparison with direct CLI usage
- Task creation, lifecycle, monitoring, and human interaction
- Pipeline configuration, stage types, data flow, routing
- Prompt hierarchy, knowledge fragments, context tiers
- Architecture internals (state machine, agent execution pipeline, persistence, SSE)
- Engine integration (Claude SDK, Gemini CLI), script library, MCP setup

See [`apps/server/README.md`](apps/server/README.md) for API endpoint reference and server architecture.

## Configuration

Two config files control the system (both gitignored):

- **`.env.local`** — local paths and secrets (per-developer)
- **`system-settings.yaml`** — system behavior, integrations, agent defaults

| Variable | Required | Description |
|----------|----------|-------------|
| `REPOS_BASE_PATH` | Yes | Base directory where your git repos live |
| `CLAUDE_PATH` / `GEMINI_PATH` | No | Override CLI executable paths (auto-detected if on PATH) |
| `SLACK_BOT_TOKEN` | No | Slack bot token for task notifications |
| `SLACK_APP_TOKEN` | No | Slack app token for Socket Mode (interactive buttons) |
| `SLACK_NOTIFY_CHANNEL_ID` | No | Slack channel/user for notifications |
| `GITHUB_ORG` | No | GitHub org for PR creation |
| `FIGMA_ACCESS_TOKEN` | No | Figma API access (for design pipelines) |

`system-settings.yaml` supports `${ENV_VAR}` interpolation — keep secrets in `.env.local`, reference them in YAML via `${VAR_NAME}`.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes (`git commit -m 'feat: add my feature'`)
4. Push to the branch (`git push origin feat/my-feature`)
5. Open a Pull Request

## License

MIT
