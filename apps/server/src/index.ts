import { loadEnv } from "./lib/env.js";
loadEnv();

import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import { kernelProposalsRoute } from "./routes/kernel-proposals.js";
import { kernelGatesRoute } from "./routes/kernel-gates.js";
import { kernelTasksRoute } from "./routes/kernel-tasks.js";
import { kernelNextStreamRoute } from "./routes/kernel-next-stream.js";
import { kernelRunRoute } from "./routes/kernel-run.js";
import { runPreflight, printPreflightResults } from "./lib/preflight.js";
import { logger } from "./lib/logger.js";
import { getFragmentRegistry, loadPipelineConfig, listAvailablePipelines, loadSystemSettings, isParallelGroup } from "./lib/config-loader.js";
import { getDb, cleanupOldData, startPeriodicCleanup } from "./lib/db.js";
import { errorResponse, ErrorCode } from "./lib/error-response.js";
import { mkdirSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

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
{
  const settings = loadSystemSettings();
  const dataDir = settings.paths?.data_dir || "/tmp/workflow-control-data";
  if (dataDir.startsWith("/tmp")) {
    logger.warn({ dataDir }, "data_dir is under /tmp - snapshots may be lost on reboot. Consider setting paths.data_dir in system-settings.yaml");
  }
  try { mkdirSync(join(dataDir, "tasks"), { recursive: true }); }
  catch (err) { logger.error({ err, dataDir }, "data_dir is not writable"); }
}

// --- Initialize SQLite database and clean up old data ---
getDb();
cleanupOldData(7);
startPeriodicCleanup();

// --- Install builtin pipelines ---
{
  const { installBuiltinPipelines } = await import("./lib/builtin-installer.js");
  installBuiltinPipelines();
}

// --- Fragment registry validation ---
{
  const allManifests = listAvailablePipelines();
  const allStageNames = new Set<string>();
  for (const m of allManifests) {
    const pipeline = loadPipelineConfig(m.id);
    if (pipeline) {
      for (const entry of pipeline.stages) {
        if (isParallelGroup(entry)) {
          allStageNames.add(entry.parallel.name);
          for (const s of entry.parallel.stages) allStageNames.add(s.name);
        } else {
          allStageNames.add(entry.name);
        }
      }
    }
  }
  const warnings = getFragmentRegistry().validate([...allStageNames]);
  for (const w of warnings) {
    logger.warn(`[FragmentRegistry] ${w}`);
  }
}

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
app.route("/api", kernelGatesRoute);
app.route("/api", kernelTasksRoute);
app.route("/api", kernelNextStreamRoute);
app.route("/api", kernelRunRoute);

const port = Number(process.env.PORT ?? 3001);

logger.info({ port }, "Server ready");

const server = serve({ fetch: app.fetch, port });

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`${signal} received — shutting down gracefully`);
  try { server.close(); } catch { /* best-effort */ }
  try {
    const { closeDb } = await import("./lib/db.js");
    closeDb();
  } catch { /* best-effort */ }
  try {
    const { closeKernelNextDb } = await import("./lib/kernel-next-db.js");
    closeKernelNextDb();
  } catch { /* best-effort */ }
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
