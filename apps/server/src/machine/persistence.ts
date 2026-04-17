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

// Per-taskId serialization so two rapid transitions don't race: the write+rename
// pair is atomic per call, but two concurrent calls can finish out-of-order
// (younger snapshot overwritten by older one that happens to rename later).
//
// No artificial size cap on this map: the earlier version evicted the oldest
// entry when it exceeded 500 keys, but that evicted entry's promise was still
// in flight, and the very next call for the same taskId would read back
// `Promise.resolve()` and race against the pending write — reintroducing the
// exact race the chain was supposed to prevent. Relying on the finally-delete
// below keeps the map bounded by the number of tasks with *unsettled* writes,
// which is naturally small (writes are fast, tasks complete).
const persistChains = new Map<string, Promise<void>>();

export async function persistSnapshot(taskId: string, actor: { getPersistedSnapshot(): unknown }): Promise<void> {
  const prev = persistChains.get(taskId) ?? Promise.resolve();
  // Capture the snapshot data at enqueue time, not at execution time — so the
  // serialized order reflects the state at each transition, not the last-seen
  // state when the chain finally runs. If capture itself throws, treat it
  // like any other persist failure: log internally, don't bubble.
  let snapshotData: unknown;
  try {
    snapshotData = actor.getPersistedSnapshot();
  } catch (err) {
    taskLogger(taskId).error({ err }, "persist snapshot: getPersistedSnapshot threw");
    return;
  }
  const next = prev.then(() => writeSnapshotInternal(taskId, snapshotData));
  persistChains.set(taskId, next);
  // Once this write settles, if it's still the latest chain entry for the
  // taskId, drop it so the map stays bounded.
  next.finally(() => {
    if (persistChains.get(taskId) === next) persistChains.delete(taskId);
  }).catch(() => {});
  await next;
}

async function writeSnapshotInternal(taskId: string, snapshotData: unknown): Promise<void> {
  const p = snapshotPath(taskId);
  const tmp = `${p}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(tmp, JSON.stringify({ version: SNAPSHOT_VERSION, snapshot: snapshotData }));
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
