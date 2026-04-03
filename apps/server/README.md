# Workflow Control Server

Pipeline-driven task automation server built on XState state machines. Executes multi-stage workflows with agent (Claude/Gemini) stages, script stages, human confirmation gates, condition routing, sub-pipeline calls, foreach iteration, and persistent snapshots.

## Setup

```bash
pnpm install
cp config/system-settings.example.yaml config/system-settings.yaml  # edit paths & tokens
pnpm run setup      # preflight checks
pnpm run dev        # start dev server (default :3001)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3001` |
| `ANTHROPIC_API_KEY` | Claude API key | — |
| `NOTION_TOKEN` | Notion integration token (optional) | — |
| `SLACK_BOT_TOKEN` | Slack bot token (optional) | — |
| `SLACK_NOTIFY_CHANNEL_ID` | Slack channel for notifications | — |
| `EXTRA_PATH` | Additional PATH entries for git/shell commands | `/opt/homebrew/bin:/usr/local/bin` |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe (checks data dir + config) |
| `POST` | `/api/tasks` | Create a task draft |
| `POST` | `/api/tasks/:id/launch` | Launch a draft task |
| `GET` | `/api/tasks` | List all tasks |
| `GET` | `/api/tasks/:id` | Get task detail |
| `GET` | `/api/tasks/:id/config` | Get task config snapshot |
| `PUT` | `/api/tasks/:id/config` | Update task config |
| `POST` | `/api/tasks/:id/confirm` | Confirm human gate |
| `POST` | `/api/tasks/:id/reject` | Reject human gate |
| `POST` | `/api/tasks/:id/answer` | Answer agent question |
| `POST` | `/api/tasks/:id/retry` | Retry blocked/stale task |
| `POST` | `/api/tasks/:id/cancel` | Cancel running task |
| `POST` | `/api/tasks/:id/resume` | Resume cancelled task |
| `POST` | `/api/tasks/:id/interrupt` | Interrupt running agent |
| `DELETE` | `/api/tasks/:id` | Delete task and cleanup |
| `GET` | `/api/stream/:id` | SSE event stream |
| `GET/PUT` | `/api/config/*` | Configuration management |

## Architecture

```
src/
  index.ts              # Hono server, routes, health checks
  machine/
    types.ts            # WorkflowContext, WorkflowEvent
    machine.ts          # XState machine setup
    actor-registry.ts   # Task lifecycle (create, restore, delete)
    persistence.ts      # Snapshot save/load (async write, sync read)
    helpers.ts          # SSE helpers, error handlers, Notion sync
    pipeline-builder.ts # Dynamic state generation from pipeline YAML
    state-builders.ts   # Per-stage-type state node builders
    workflow.ts         # Barrel re-exports
  agent/
    executor.ts         # Claude agent execution
    pipeline-executor.ts # Sub-pipeline call execution
    foreach-executor.ts  # Foreach iteration execution
    query-tracker.ts    # Active query + cost tracking
    prompt-builder.ts   # System prompt assembly
  lib/
    config-loader.ts    # YAML config loading + caching
    safe-fire.ts        # Fire-and-forget promise helper
    error-response.ts   # Unified API error format
    question-manager.ts # Human Q&A with timeout
    slack.ts            # Slack notifications
    notion.ts           # Notion page status sync
    git.ts              # Worktree management
    artifacts.ts        # File artifact persistence
  routes/               # Hono route handlers
  middleware/            # Validation middleware
  sse/                  # Server-Sent Events manager
```
