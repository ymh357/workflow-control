import { loadEnv } from "./lib/env.js";
loadEnv();

import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import { kernelProposalsRoute } from "./routes/kernel-proposals.js";
import { kernelProposalsStreamRoute } from "./routes/kernel-proposals-stream.js";
import { kernelProposalPreviewRoute } from "./routes/kernel-proposal-preview.js";
import { kernelPipelinesRoute } from "./routes/kernel-pipelines.js";
import { kernelGatesRoute } from "./routes/kernel-gates.js";
import { kernelTasksRoute } from "./routes/kernel-tasks.js";
import { kernelAttemptsRoute } from "./routes/kernel-attempts.js";
import { kernelAttemptDetailsRoute } from "./routes/kernel-attempt-details.js";
import { kernelTaskIrRoute } from "./routes/kernel-task-ir.js";
import { kernelAuditRoute } from "./routes/kernel-audit.js";
import { kernelDiffRoute } from "./routes/kernel-diff.js";
import { kernelNextStreamRoute } from "./routes/kernel-next-stream.js";
import { kernelRunRoute } from "./routes/kernel-run.js";
import { kernelMcpRoute } from "./routes/kernel-mcp.js";
import { kernelTaskListRoute } from "./routes/kernel-task-list.js";
import { kernelTaskPortsRoute } from "./routes/kernel-task-ports.js";
import { createKernelMcpCatalogRoute } from "./routes/kernel-mcp-catalog.js";
import { runPreflight, printPreflightResults } from "./lib/preflight.js";
import { logger } from "./lib/logger.js";
import { loadSystemSettings } from "./lib/config-loader.js";
import { errorResponse, ErrorCode } from "./lib/error-response.js";
import { mkdirSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { acquireServerLock, releaseServerLock } from "./kernel-next/runtime/server-lock.js";
import { reconcileRunningAttempts } from "./kernel-next/runtime/graceful-shutdown.js";
import { getKernelNextDb } from "./lib/kernel-next-db.js";

// --- Global error handlers: prevent server crash from async/XState errors ---
process.on("uncaughtException", (err) => {
  const detail = err instanceof Error
    ? { message: err.message, stack: err.stack, name: err.name }
    : { raw: String(err), type: typeof err };
  logger.fatal({ err, detail }, "Uncaught exception — shutting down");
  // Give pending I/O a brief window to flush before exit
  setTimeout(() => process.exit(1), 1000).unref();
});
process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error
    ? { message: reason.message, stack: reason.stack, name: reason.name }
    : { raw: String(reason), type: typeof reason };
  logger.fatal({ reason, detail }, "Unhandled rejection — shutting down");
  setTimeout(() => process.exit(1), 1000).unref();
});

// --- Preflight: validate all config before accepting requests ---

const { passed, results } = runPreflight();
printPreflightResults(results);

if (!passed) {
  logger.error("Preflight failed. Fix the issues above before starting. Run: pnpm run setup");
  process.exit(1);
}

// --- Data directory validation ---
const dataDir = (() => {
  const settings = loadSystemSettings();
  const resolved = settings.paths?.data_dir || "/tmp/workflow-control-data";
  if (resolved.startsWith("/tmp")) {
    logger.warn({ dataDir: resolved }, "data_dir is under /tmp - snapshots may be lost on reboot. Consider setting paths.data_dir in system-settings.yaml");
  }
  try { mkdirSync(join(resolved, "tasks"), { recursive: true }); }
  catch (err) { logger.error({ err, dataDir: resolved }, "data_dir is not writable"); }
  return resolved;
})();

// --- Server instance mutex (PID file) ---
// Enforces single-server-per-DATA_DIR. DATA_DIR must live on local disk;
// flock is not used because of NFS unreliability. The lock file holds the
// server's pid; a subsequent boot that finds a dead pid inside will take
// over automatically.
const lockPath = join(dataDir, "kernel-next.lock");
const lockResult = acquireServerLock(lockPath);
if (!lockResult.ok) {
  if (lockResult.reason === "already_held_alive") {
    logger.error({ pid: lockResult.pid, lockPath }, "Another kernel-next server instance is already running. Exiting.");
  } else {
    logger.error({ detail: lockResult.detail, lockPath }, "Could not acquire server lock. Exiting.");
  }
  process.exit(1);
}
const lockHandle = lockResult.release;
process.on("exit", () => { releaseServerLock(lockHandle); });

// --- Graceful shutdown handler (SIGTERM/SIGINT) ---
// Sequence (2026-04-27 A3 — no longer a simple DB UPDATE):
//   1. Dispatch INTERRUPT to every live runner via taskRegistry.interruptAll
//      so each one runs the F22 abort path (kills its SDK subprocess) and
//      writes task_finals on its own.
//   2. Await termination per task with a shared deadline.
//   3. Run reconcileRunningAttempts as a safety net: any task that didn't
//      terminate inside the deadline still has its stage_attempts flipped
//      to 'superseded' + agent_execution_details.termination_reason set
//      to 'interrupted', so the next boot's orphan reconciler can pick it
//      up cleanly.
//   4. Close HTTP server + DBs.
//   5. process.exit(0).
//
// This also collapses the previously-duplicated SIGTERM/SIGINT handlers
// (one for reconcile, another for HTTP/DB cleanup, both racing process.exit).
const SHUTDOWN_DEADLINE_MS = 8_000;
let shuttingDown = false;
async function gracefulExit(signal: NodeJS.Signals | "manual"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const { taskRegistry } = await import("./kernel-next/runtime/task-registry.js");
  const live = taskRegistry.size();
  logger.info({ signal, live }, "graceful shutdown: dispatching INTERRUPT to live runners");
  try {
    const result = await taskRegistry.interruptAll(SHUTDOWN_DEADLINE_MS);
    logger.info({ signal, ...result }, "graceful shutdown: runners settled");
  } catch (err) {
    logger.error({ err }, "graceful shutdown: interruptAll failed");
  }
  try {
    const db = getKernelNextDb();
    const taskIds = (db.prepare(
      `SELECT DISTINCT task_id FROM stage_attempts
        WHERE status='running' AND task_id NOT IN (SELECT task_id FROM task_finals)`,
    ).all() as Array<{ task_id: string }>).map((r) => r.task_id);
    const n = reconcileRunningAttempts(db, taskIds);
    if (n > 0) logger.warn({ signal, reconciled: n }, "graceful shutdown: DB safety-net flipped attempts to superseded");
  } catch (err) {
    logger.error({ err }, "graceful shutdown: DB reconcile failed");
  }
  // Stop accepting new HTTP requests + close DBs. Best-effort — any
  // failure here is logged but does not block process.exit.
  try { clearInterval(gateTimeoutTimer); } catch { /* best-effort */ }
  try { server.close(); } catch { /* best-effort */ }
  try {
    const { closeKernelNextDb } = await import("./lib/kernel-next-db.js");
    closeKernelNextDb();
  } catch { /* best-effort */ }
  logger.info({ signal }, "graceful shutdown: complete");
  process.exit(0);
}
process.on("SIGTERM", () => { void gracefulExit("SIGTERM"); });
process.on("SIGINT", () => { void gracefulExit("SIGINT"); });


// --- Recover from encryption key loss (spec §6.3) ---
// MUST run before any crypto operation. If the key file is missing but
// inventory has stored secrets, mark all equipped/pending rows unhealthy
// before crypto.ts silently auto-generates a fresh key (which would make
// every stored ciphertext undecryptable without warning).
{
  const { runSecretKeyRecovery } = await import("./kernel-next/mcp-catalog/key-recovery.js");
  const r = runSecretKeyRecovery(getKernelNextDb());
  if (r.recovered) {
    logger.warn(
      { affectedRows: r.affectedRows },
      "[mcp-catalog] secret-key file missing — bulk-marked equipped inventory rows unhealthy. User must re-equip via /kernel-next/mcp-catalog.",
    );
  }
}

// --- Seed MCP catalog builtins ---
{
  const { seedBuiltinFromJson } = await import("./kernel-next/mcp-catalog/seed.js");
  const catalogJsonPath = join(
    import.meta.dirname ?? new URL(".", import.meta.url).pathname,
    "kernel-next/mcp-catalog/entries.json",
  );
  const seedResult = seedBuiltinFromJson(getKernelNextDb(), catalogJsonPath);
  if (!seedResult.ok) {
    logger.error({ error: seedResult.error }, "[mcp-catalog] seed failed");
  } else {
    logger.info(
      { inserted: seedResult.inserted, updated: seedResult.updated, deprecated: seedResult.deprecated },
      "[mcp-catalog] seed complete",
    );
  }
}

// --- Resume orphan tasks ---
// Scans for tasks without a task_finals row (runner crashed, graceful
// shutdown, etc.). Each orphan is either resumed via startPipelineRun
// or finalized (terminal-but-lost-finals) or failed (unresolvable).
// Runs AFTER builtin seeding so the latest pipeline versions are in DB.
{
  const { bootResumability } = await import("./kernel-next/runtime/orphan-reconciler.js");
  const { startPipelineRun } = await import("./kernel-next/runtime/start-pipeline-run.js");
  const { kernelNextBroadcaster } = await import("./kernel-next/sse/singleton.js");
  const { MONOREPO_TSC_PATH } = await import("./routes/kernel-run.js");
  const res = await bootResumability({
    db: getKernelNextDb(),
    tscPath: MONOREPO_TSC_PATH,
    startPipelineRun: (inp) => startPipelineRun({
      db: getKernelNextDb(),
      broadcaster: kernelNextBroadcaster,
      taskId: inp.taskId,
      versionHash: inp.versionHash,
      resumeFrom: inp.resumeFrom,
      resumeSessionId: inp.resumeSessionId,
      tscPath: inp.tscPath,
    }),
  });
  logger.info(res, "resumability: boot scan complete");
}

// --- P5.2 (D6) — periodic gate-timeout sweeper ---
// Scans gate_queue every 60s for unanswered gates whose deadline
// (created_at + config.timeout_minutes * 60_000) has elapsed and
// cancels the owning task via KernelService.cancelTask. Opt-in only —
// gates without timeout_minutes are never swept.
const { sweepTimedOutGates } = await import("./kernel-next/runtime/gate-timeout-sweeper.js");
const gateTimeoutTimer = setInterval(() => {
  try {
    const result = sweepTimedOutGates(getKernelNextDb());
    if (result.swept > 0) {
      logger.info({ swept: result.swept, cancelled: result.cancelled }, "gate-timeout-sweeper: swept timed-out gates");
    }
  } catch (err) {
    logger.error({ err }, "gate-timeout-sweeper: sweep failed");
  }
}, 60_000);
gateTimeoutTimer.unref();

// --- Middleware & Routes ---

const app = new Hono();

app.onError((err, c) => {
  logger.error({ err, path: c.req.path, method: c.req.method }, "Unhandled error");
  return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, "Internal server error");
});

app.use("*", honoLogger());
app.use("*", cors({ origin: ["http://localhost:3004", "http://localhost:3000"] }));
app.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 })); // 2MB

app.get("/health", (c) => c.json({ ok: true }));

app.get("/health/ready", async (c) => {
  const checks: Record<string, boolean> = { dataDir: false, config: false };

  // Check data directory is writable
  try {
    const settings = loadSystemSettings();
    const dataDir = settings.paths?.data_dir || "/tmp/workflow-control-data";
    const probe = join(dataDir, ".health-probe");
    await writeFile(probe, "ok");
    await unlink(probe);
    checks.dataDir = true;
  } catch { /* not writable */ }

  // Check config is loadable
  try {
    loadSystemSettings();
    checks.config = true;
  } catch { /* config broken */ }

  const ok = Object.values(checks).every(Boolean);
  return c.json({ ok, checks }, ok ? 200 : 503);
});

app.route("/api", kernelProposalsRoute);
app.route("/api", kernelProposalsStreamRoute);
app.route("/api", kernelProposalPreviewRoute);
app.route("/api", kernelPipelinesRoute);
app.route("/api", kernelGatesRoute);
app.route("/api", kernelTasksRoute);
app.route("/api", kernelAttemptsRoute);
app.route("/api", kernelAttemptDetailsRoute);
app.route("/api", kernelTaskIrRoute);
app.route("/api", kernelAuditRoute);
app.route("/api", kernelDiffRoute);
app.route("/api", kernelNextStreamRoute);
app.route("/api", kernelRunRoute);
app.route("/api", kernelMcpRoute);
app.route("/api", kernelTaskListRoute);
app.route("/api", kernelTaskPortsRoute);
app.route("/api", createKernelMcpCatalogRoute(getKernelNextDb));

const port = Number(process.env.PORT ?? 3001);

logger.info({ port }, "Server ready");

const server = serve({ fetch: app.fetch, port });
// SIGTERM/SIGINT handlers are already registered above (see gracefulExit).
// HTTP/DB shutdown happens inside that handler; do not register a second
// pair here — duplicate handlers race process.exit and can cause partial
// shutdowns.
