import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync, statSync } from "node:fs";
import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { taskLogger } from "../lib/logger.js";
import { loadSystemSettings, type PipelineConfig, isParallelGroup } from "../lib/config-loader.js";

const SNAPSHOT_VERSION = 1;

export function snapshotPath(taskId: string): string {
  const settings = loadSystemSettings();
  const dataDir = settings.paths?.data_dir || "/tmp/workflow-control-data";
  return join(dataDir, "tasks", `${taskId}.json`);
}

export function pipelineFingerprint(pipeline: PipelineConfig): string {
  return pipeline.stages.map(entry => {
    if (isParallelGroup(entry)) {
      const inner = entry.parallel.stages.map(s => `${s.name}:${s.type}`).join(",");
      return `P[${entry.parallel.name}:${inner}]`;
    }
    return `${entry.name}:${(entry as any).type}`;
  }).join("|");
}

export async function persistSnapshot(taskId: string, actor: { getPersistedSnapshot(): unknown }): Promise<void> {
  const p = snapshotPath(taskId);
  const tmp = `${p}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(tmp, JSON.stringify({ version: SNAPSHOT_VERSION, snapshot: actor.getPersistedSnapshot() }));
    await rename(tmp, p);
  } catch (err) {
    taskLogger(taskId).error({ err }, "persist snapshot failed");
    try { await unlink(tmp); } catch { /* best effort */ }
  }
}

export function flushSnapshotSync(taskId: string, actor: { getPersistedSnapshot(): unknown }): void {
  const p = snapshotPath(taskId);
  const tmp = `${p}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: SNAPSHOT_VERSION, snapshot: actor.getPersistedSnapshot() }));
    renameSync(tmp, p);
  } catch (err) {
    taskLogger(taskId).error({ err }, "flush snapshot sync failed");
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

export function loadSnapshot(taskId: string): unknown | undefined {
  const p = snapshotPath(taskId);
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (raw && typeof raw === "object" && "version" in raw) {
      if (raw.version === SNAPSHOT_VERSION) return raw.snapshot;
      taskLogger(taskId).warn({ expected: SNAPSHOT_VERSION, got: raw.version }, "snapshot version mismatch, skipping");
      return undefined;
    }
    // Legacy snapshot without version wrapper
    taskLogger(taskId).warn("loading legacy snapshot without version wrapper");
    return raw;
  } catch (err) {
    taskLogger(taskId).error({ err, path: p }, "load snapshot failed (corrupted?)");
    return undefined;
  }
}

export function loadAllPersistedTaskIds(limit?: number): string[] {
  const settings = loadSystemSettings();
  const dataDir = settings.paths?.data_dir || "/tmp/workflow-control-data";
  const dir = join(dataDir, "tasks");
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const withMtime = files.map((f) => {
      try {
        const mtime = statSync(join(dir, f)).mtimeMs;
        return { name: f, mtime };
      } catch {
        return { name: f, mtime: 0 };
      }
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const sorted = withMtime.map((f) => f.name.replace(".json", ""));
    return limit ? sorted.slice(0, limit) : sorted;
  } catch { return []; }
}
