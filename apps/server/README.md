# Workflow Control Server

Hono HTTP server + kernel-next runtime + Claude Agent SDK integration. Exposes the REST API at `:3001` and drives pipeline execution on a per-task basis.

The **authoritative** onboarding/overview docs live in the [top-level README](../../README.md). This file only covers server-specific details useful while hacking inside `apps/server/`.

## Layout

```
src/
  index.ts                # server entry: lock, DB init, resumability boot, route wiring
  kernel-next/
    ir/                   # PipelineIR zod schema + SQLite DDL + sql helpers
    runtime/              # runner, real-executor, stream-pump, writer, resumability
    mcp/                  # in-process MCP server (createKernelMcp) + KernelService
    hot-update/           # propose / migrate / rollback engine
    validator/            # structural / DAG / store-schema / types (tsc)
    sse/                  # broadcaster + SSE HTTP format
    codegen/              # IR → pipeline.ts for type validation
  builtin-pipelines/      # seeded builtins (smoke-test + 3 research + pipeline-generator)
  routes/                 # Hono HTTP routes (kernel-run, proposals, pipelines, gates, tasks, stream)
  lib/                    # db singletons, logger, SystemSettings
```

## Running

```bash
pnpm dev             # tsx watch src/index.ts  — server on :3001
pnpm build           # tsc
pnpm test            # vitest (~1500 cases, ~40s)
```

## Environment

See `.env.local.example`. The minimum for a real pipeline run:

- `REPOS_BASE_PATH` — where your git repos live (used by script stages)
- `WORKTREES_BASE_PATH` — where per-task worktrees are created
- `CLAUDE_PATH` — auto-detected if `claude` is on PATH; override if needed

Optional (only when a pipeline uses the corresponding feature):
`SETTING_NOTION_TOKEN`, `SETTING_FIGMA_ACCESS_TOKEN`,
`VERCEL_PROJECT_ID` / `VERCEL_TEAM_ID` / `VERCEL_WEBHOOK_SECRET`,
`GITHUB_WEBHOOK_SECRET`.

Runtime data dir defaults to `/tmp/workflow-control-data/`. Override via `DATA_DIR` for persistent storage across macOS reboots.

## Routes

See [top-level README](../../README.md#selected-http-endpoints) for the curated list. The server also exposes:

- `GET  /health` — liveness
- `GET  /health/ready` — readiness (checks DB + data dir)

## Resumability

On boot, `bootResumability` (called from `index.ts`) scans `stage_attempts` for task IDs without a `task_finals` row, classifies each as `resume` / `terminal` / `unresolvable`, and dispatches `startPipelineRun` with `resumeFrom` + `resumeSessionId`. See `src/kernel-next/runtime/orphan-reconciler.ts` for the classifier.

PID-file lock at `{DATA_DIR}/kernel-next.lock` prevents concurrent server processes from sharing the same DB. Stale-pid takeover (via `process.kill(pid, 0)`) recovers from hard crashes.

## Tests

Server tests live next to their modules (`*.test.ts`). Critical modules also have `*.adversarial.test.ts`. The suite runs on in-memory SQLite via `DatabaseSync(":memory:")` — no external dependencies, runs fully offline. Run with `pnpm test` or `npx vitest run`.

## License

MIT
