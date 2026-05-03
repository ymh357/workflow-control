# Workflow Control Server

Hono HTTP server + kernel-next runtime + Claude Agent SDK integration. Exposes the REST API at `:3001` and drives pipeline execution on a per-task basis.

The **authoritative** onboarding/overview docs live in the [top-level README](../../README.md). This file only covers server-specific details useful while hacking inside `apps/server/`.

## Layout

```
src/
  index.ts                # server entry: lock, resumability boot, route wiring
  setup.ts                # interactive `pnpm setup` (Node/Claude/gh checks)
  kernel-next/
    ir/                   # PipelineIR zod schema + SQLite DDL + sql helpers
    runtime/              # runner, real-executor, stream-pump, writer, resumability
                          #   + worktree allocator (B9 / Phase 5C)
    mcp/                  # in-process MCP server (createKernelMcp) + KernelService
    hot-update/           # propose / migrate / rollback engine
    validator/            # structural / DAG / store-schema / types (tsc)
    sse/                  # broadcaster + SSE HTTP format
    codegen/              # IR → pipeline.ts for type validation
    debug/                # replay-stage / dry-run-stage / propose-pipeline-fix tools
    mcp-catalog/          # encrypted MCP secret store
  builtin-pipelines/      # 6 seeded builtins: smoke-test, pipeline-generator,
                          #   pipeline-modifier, pr-description-generator,
                          #   tech-research-collector, tech-research-writer
  routes/                 # Hono HTTP routes (kernel-run, proposals, pipelines,
                          #   gates, tasks, stream)
  lib/                    # logger, error-response, env loader, preflight,
                          #   spawn-utils, kernel-next-db singleton, SystemSettings
```

## Running

```bash
pnpm dev             # tsx watch src/index.ts  — server on :3001
pnpm build           # tsc
pnpm test            # vitest (~2150 cases, ~55s)
```

## Environment

See `.env.local.example`. There are no required server-process env
vars — Claude CLI is auto-detected from `$PATH`. Optional overrides:

- `CLAUDE_PATH` — pin a specific `claude` binary (otherwise PATH-resolved).
- `DATA_DIR` — persistent SQLite location (default `/tmp/workflow-control-data/`,
  volatile on macOS reboot — set this for any non-throwaway use).
- `LOG_LEVEL` — `info` (default) or `debug` for verbose runtime traces.

Per-task MCP secrets (API tokens) live in the encrypted MCP catalog
managed via the dashboard `/kernel-next/mcp-catalog` page or the
`add_mcp_catalog_entry` MCP tool — **not** in `.env.local`.

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
