# Workflow Control

A **local, single-user** workflow engine for running AI coding agents — primarily Claude — on tasks too large for a single CLI session. One engineer, one machine, one server process.

Pipelines are **YAML-free and AI-authored**: you describe a workflow in natural language, the built-in `pipeline-generator` drives Claude through design → review → registration, and the result is a reproducible, interruptible, observable pipeline stored in a local SQLite database.

> **Positioning.** Workflow Control runs entirely on your own machine. No shared server. No multi-tenant model. No team scheduling. Cross-user artefact sharing previously rode on a YAML-based public registry; that surface was retired 2026-05-04 because the YAML schema was incompatible with kernel-next's canonical IR. Until a successor sharing channel keyed on `pipeline.ir.json` ships, share by exporting/importing the IR JSON directly. See `docs/product-roadmap.md`.

## Why

Using Claude Code directly works great for small tasks. For larger efforts — multi-stage analysis, planning, implementation, review — a single chat session lacks:

- **Cost control** — per-stage budgets, automatic budget caps.
- **Failure recovery** — stage attempts persist; interrupted tasks resume from the last success, including mid-stage crash recovery via the SDK session-resume path.
- **Reproducibility** — every pipeline version is content-hashed; every stage attempt and port value is persisted.
- **Observability** — real-time SSE stream + dashboard with filtering, stage timeline, cost breakdown.
- **Hot-update** — iterate a live pipeline's prompts or structure via propose/approve/migrate; rollback if the change regresses.

Workflow Control delivers all five on top of a single-user SQLite store and a Hono + Next.js stack.

## Prerequisites

- **Node.js >= 22.5** (required for `node:sqlite`; setup.ts hard-fails below this)
- **pnpm** — `npm install -g pnpm`
- **Claude Code CLI** — the only supported agent engine. Install from [claude.com/claude-code](https://claude.com/claude-code) and run `claude login` before using Workflow Control.
- **gh CLI** (optional) — needed only if your pipelines use GitHub PR creation scripts.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/ymh357/workflow-control.git
cd workflow-control
pnpm install

# 2. Optional: configure runtime env
cp apps/server/.env.local.example apps/server/.env.local
# .env.local is for server-process variables. Per-task MCP secrets
# live in the encrypted catalog managed via the dashboard
# (/kernel-next/mcp-catalog) — do NOT put them here.

# 3. Start server + dashboard
pnpm dev
# Server:    http://localhost:3001
# Dashboard: http://localhost:3000
```

Open http://localhost:3000 — you'll land on the kernel-next dashboard. The system ships with six built-in pipelines:

| Pipeline | Purpose |
|---|---|
| `smoke-test` | Minimal 2-stage sanity run (<30s, <$0.01) |
| `Pipeline Generator` | **The primary authoring tool.** Natural-language → validated AI pipeline stored in the DB |
| `pipeline-modifier` | Hot-update authoring tool: produces an IR patch proposal targeting an existing pipeline |
| `pr-description-generator` | Generates a PR description from a branch + base; canary for `single-session` mode |
| `Tech Research Collector` | Crawl primary/domain sources, emit structured research facts |
| `Tech Research Writer` | Turn research facts into a Markdown deliverable with verification tiers |

## First Run

Verify everything works end-to-end with the smoke-test (<30s, negligible cost):

```bash
curl -X POST http://localhost:3001/api/kernel/tasks/run \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test","seedValues":{"task_text":"hello world"}}'
# => { "ok": true, "taskId": "smoke-test-...", "versionHash": "..." }
```

Open the returned `taskId` in the dashboard (http://localhost:3000/kernel-next/&lt;taskId&gt;) to watch the agent stream live.

### Authoring a new pipeline (AI-driven)

```bash
curl -X POST http://localhost:3001/api/kernel/tasks/run \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Pipeline Generator",
    "seedValues": { "taskDescription": "A pipeline that takes a GitHub PR number, fetches the diff, and produces a Markdown security review." }
  }'
```

The pipeline-generator goes through: `analyzing → gate → genSkeleton → genPrompts → persisting`. At the gate, approve via the dashboard's **Proposals** page or:

```bash
# List pending gates for this task
curl "http://localhost:3001/api/kernel/gates?taskId=<taskId>&answered=false" | jq
# Approve
curl -X POST http://localhost:3001/api/kernel/gates/<gateId>/answer \
  -H 'Content-Type: application/json' -d '{"answer":"approve"}'
```

When the task finishes, the newly generated pipeline is registered in `pipeline_versions` — you can run it by name just like the builtins.

## Architecture

```
apps/
  server/             # Hono API (:3001) + kernel-next runtime + Claude Agent SDK
    src/
      index.ts             # server entry, resumability boot scan, routes
      kernel-next/
        ir/                # pipeline IR schema + SQLite schema
        runtime/           # runner, real-executor, SSE, resumability
        mcp/               # in-process MCP server, submit/validate/propose
        hot-update/        # propose/approve/migrate/rollback engine
        validator/         # structural / DAG / store-schema / types (tsc)
      routes/              # Hono HTTP routes
      builtin-pipelines/   # 6 seeded pipelines (IR JSON; see Quick Start table)
  web/                # Next.js 16 dashboard (:3000), React 19 + Tailwind 4
    src/app/kernel-next/   # task view, pipelines list, proposals UI
packages/
  shared/             # TypeScript types shared between server and web
```

### Key concepts

- **Pipeline IR**: a JSON document describing stages, wires, external inputs, and an optional `store_schema`. AI-authored via `pipeline-generator`; stored verbatim in SQLite under a content-hash `versionHash`.
- **Stage**: an `agent` (Claude, MCP tools + system prompt), a `script` (deterministic automation), or a `gate` (human approval). Both `agent` and `script` may be marked `fanout` to iterate over an array input concurrently.
- **Port**: typed value produced or consumed by a stage. Writes go through the MCP `write_port` tool; reads go through `read_port`. Type compatibility is validated at submit-time by running `tsc` over a generated pipeline.ts.
- **Run**: a task bound to a specific `versionHash`. Each stage attempt is persisted; if the server crashes mid-run, `bootResumability` picks it back up on restart (including SDK session resume on the in-flight agent stage).
- **Hot update**: propose a patch against an existing `versionHash`, dry-run its impact, approve/reject, and optionally migrate running tasks to the new version (with `rerunFrom` controlling which stages get superseded). Rollback via `POST /api/kernel/tasks/:taskId/rollback`.

### Selected HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/kernel/tasks/run` | Start a new task (by pipeline `name` or `versionHash`) |
| `GET`  | `/api/kernel-next/tasks/:taskId/stream` | SSE stream of stage/agent/port events |
| `GET`  | `/api/kernel/tasks/:taskId/status` | Task snapshot (current stage, gate state, attempts) |
| `POST` | `/api/kernel/tasks/:taskId/migrate` | Apply an approved proposal to this running task |
| `POST` | `/api/kernel/tasks/:taskId/rollback` | Rollback to an earlier version from this task's migration history |
| `POST` | `/api/kernel/gates/:gateId/answer` | Answer a pending human-confirm gate |
| `GET`  | `/api/kernel/pipelines` | List registered pipelines |
| `GET`  | `/api/kernel/pipelines/:versionHash` | IR + prompts for a specific version |
| `POST` | `/api/kernel/proposals` | Create a propose (IR patch and/or prompt replacement) |
| `POST` | `/api/kernel/proposals/:id/approve` | Approve a pending proposal |
| `POST` | `/api/kernel/proposals/:id/reject` | Reject a pending proposal |

The in-process MCP server exposes the same surface to agents via `mcp____kernel_next____<tool>` for agents running inside a pipeline's agent stage.

## Development

```bash
pnpm --filter server test       # server tests (~2150 cases, ~55s)
pnpm --filter server build      # tsc check
pnpm --filter web test          # web tests
pnpm --filter web test:e2e      # playwright E2E (requires server running)
```

Data lives in `/tmp/workflow-control-data/` by default (the entire `kernel-next.db` SQLite file). Override via `DATA_DIR` env. On macOS `/tmp` is volatile across reboots — set `DATA_DIR` to a persistent path for real use. SSE history is in-process only (broadcaster ring buffer); no SSE persistence on disk.

## Configuration

- **`apps/server/.env.local`** (gitignored) — server-process variables only (e.g. `DATA_DIR`, log level, `CLAUDE_PATH` override). Per-task MCP secrets do NOT belong here; they live in the encrypted MCP catalog (manage via the dashboard `/kernel-next/mcp-catalog` page or the `add_mcp_catalog_entry` MCP tool).
- **CLI paths** — `CLAUDE_PATH` is auto-detected from `$PATH`; override only if needed.

## Docker

One-command, production-shape local deployment via `docker compose`:

```bash
cp apps/server/.env.local.example apps/server/.env.local  # adjust paths if needed
docker compose up -d --build
```

Ports:

- Server API: `http://localhost:3001`
- Dashboard:  `http://localhost:3000`

Volumes (see `docker-compose.yml` for exact mounts):

- `./data` → `/data` — persistent SQLite store (`DATA_DIR`).

The `claude` CLI is **not** bundled in the image. Script stages that invoke it will fail unless you either mount a host `claude` binary into the container at `/usr/local/bin/claude` or extend the server image to install it. The Dockerfile gives you a runnable server + dashboard; agent-driven pipelines that shell out to `claude` require that extra wiring.

Rebuild after code changes:

```bash
docker compose build && docker compose up -d
```

Tear down:

```bash
docker compose down
```

## What this project is not

- Not a multi-tenant SaaS. No auth. No cross-user RBAC.
- Not a team workflow / approval platform. Gates serve the individual user.
- Not a general-purpose orchestrator (Temporal, Airflow, Prefect) — scope is AI-agent workflows only.
- Not a chat wrapper — the engine is the product; the dashboard is just the primary UI.

## Contributing

Single-maintainer project; open an issue before sending a PR for non-trivial changes. Conventional commits (`fix:`, `feat:`, `docs:`, `refactor:`) are enforced in reviews.

## License

MIT
