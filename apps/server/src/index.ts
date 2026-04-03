import { loadEnv } from "./lib/env.js";
loadEnv();

import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import { triggerRoute } from "./routes/trigger.js";
import { streamRoute } from "./routes/stream.js";
import { tasksRoute } from "./routes/tasks.js";
import { confirmRoute } from "./routes/confirm.js";
import { answerRoute } from "./routes/answer.js";
import { retryRoute } from "./routes/retry.js";
import { cancelRoute } from "./routes/cancel.js";
import { configRoute } from "./routes/config.js";
import { registryRoute } from "./routes/registry.js";
import { edgeMcpRoute } from "./edge/route.js";
import { buildWrapperRoute } from "./edge/wrapper-api.js";
import { runPreflight, printPreflightResults } from "./lib/preflight.js";
import { logger } from "./lib/logger.js";
import { getFragmentRegistry, loadPipelineConfig, listAvailablePipelines, loadSystemSettings, isParallelGroup } from "./lib/config-loader.js";
import { getDb, cleanupOldData, startPeriodicCleanup } from "./lib/db.js";
import { validateTaskId } from "./middleware/validate.js";
import { errorResponse, ErrorCode } from "./lib/error-response.js";
import { initSlackApp, stopSlackApp } from "./services/slack-app.js";
import { mkdirSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

// --- Global error handlers: prevent server crash from async/XState errors ---
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — server will continue running");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection — server will continue running");
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

const UUID_REGEX = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
app.use(`/api/tasks/:taskId{${UUID_REGEX}}/*`, validateTaskId);
app.use(`/api/tasks/:taskId{${UUID_REGEX}}`, validateTaskId);
app.use(`/api/stream/:taskId{${UUID_REGEX}}`, validateTaskId);

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

app.route("/api", triggerRoute);
app.route("/api", streamRoute);
app.route("/api", tasksRoute);
app.route("/api", confirmRoute);
app.route("/api", answerRoute);
app.route("/api", retryRoute);
app.route("/api", cancelRoute);
app.route("/api", configRoute);
app.route("/api", registryRoute);
app.route("/mcp", edgeMcpRoute);
app.route("/api/edge", buildWrapperRoute());

const port = Number(process.env.PORT ?? 3001);

logger.info({ port }, "Server ready");

initSlackApp().catch((err) => logger.warn({ err }, "slack: Socket Mode init failed (non-blocking)"));

serve({ fetch: app.fetch, port });

process.on("SIGTERM", async () => {
  await stopSlackApp();
  process.exit(0);
});
