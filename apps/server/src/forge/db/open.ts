import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { initForgeSchema } from "./schema.js";

let _db: DatabaseSync | undefined;

export function openForgeDb(dataDir: string): DatabaseSync {
  if (_db) return _db;
  const path = join(dataDir, "forge.db");
  const db = new DatabaseSync(path);
  db.prepare("PRAGMA journal_mode = WAL").run();
  db.prepare("PRAGMA foreign_keys = ON").run();
  initForgeSchema(db);
  _db = db;
  return db;
}

export function getForgeDb(): DatabaseSync {
  if (!_db) throw new Error("forge db not initialized; call openForgeDb first");
  return _db;
}

export function closeForgeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}

// Test-only override.
export function __setForgeDbForTest(db: DatabaseSync | undefined): void {
  _db = db;
}
