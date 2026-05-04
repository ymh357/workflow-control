// Recursive directory watcher with per-file debounce. Watches for
// .jsonl writes under the projects root and emits decoded events.
//
// Decoding: Claude Code encodes /Users/minghao/foo as -Users-minghao-foo
// (replaces / with -). decodeProjectDir reverses that.

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface WatcherEvent {
  jsonlPath: string;
  cwd: string;
  sessionId: string;
}

export interface Watcher {
  stop(): void;
}

export interface WatcherOpts {
  projectsRoot: string;
  onEvent: (e: WatcherEvent) => void;
  debounceMs?: number;
}

export function startWatcher(opts: WatcherOpts): Watcher {
  const debounceMs = opts.debounceMs ?? 250;
  const timers = new Map<string, NodeJS.Timeout>();
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(opts.projectsRoot, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;
      const fullPath = join(opts.projectsRoot, filename);
      const existing = timers.get(fullPath);
      if (existing) clearTimeout(existing);
      timers.set(fullPath, setTimeout(() => {
        timers.delete(fullPath);
        const parts = filename.split(/[\\/]/);
        const dirName = parts[parts.length - 2] ?? "";
        const file = parts[parts.length - 1] ?? "";
        const sessionId = file.replace(/\.jsonl$/, "");
        const cwd = decodeProjectDir(dirName);
        opts.onEvent({ jsonlPath: fullPath, cwd, sessionId });
      }, debounceMs));
    });
  } catch (err) {
    // recursive watch may not be supported on some platforms; surface
    // a clear error rather than fail silently
    throw new Error(`watcher start failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    stop(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      watcher?.close();
    },
  };
}

// Claude Code encodes /Users/minghao/foo as -Users-minghao-foo.
// First leading dash → /, all other dashes → /. (We intentionally
// don't try to handle directory names that themselves contain dashes;
// Claude Code's encoding does not round-trip those, and the resulting
// "wrong" cwd is informational only.)
export function decodeProjectDir(dirName: string): string {
  if (!dirName) return "";
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}
