// Kernel-next DB singleton for the server process.
//
// Separate from main workflow.db during spike (design §11 OQ #1). Lives at
// {data_dir}/kernel-next.db and is initialised with the kernel-next schema
// on first access.
//
// Consumers: REST routes (proposals API, P2.3) and any future server-side
// MCP bridge. kernel-next runtime itself still accepts an arbitrary
// DatabaseSync — this module only provides the process-wide default.

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { loadSystemSettings } from "./config-loader.js";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";

let db: DatabaseSync | undefined;

function resolveDataDir(): string {
  const settings = loadSystemSettings();
  return settings.paths?.data_dir || "/tmp/workflow-control-data";
}

export function getKernelNextDb(): DatabaseSync {
  if (db) return db;

  const dataDir = resolveDataDir();
  const dbPath = join(dataDir, "kernel-next.db");
  mkdirSync(dataDir, { recursive: true });

  db = new DatabaseSync(dbPath);
  initKernelNextSchema(db);
  return db;
}

/** Test helper: reset the singleton so a test can use an in-memory DB. */
export function __setKernelNextDbForTest(override: DatabaseSync | undefined): void {
  db = override;
}
