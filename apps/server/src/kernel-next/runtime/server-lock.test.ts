import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireServerLock, releaseServerLock } from "./server-lock.js";

describe("server-lock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wfc-lock-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires lock when no prior lock exists", () => {
    const path = join(dir, "kernel-next.lock");
    const handle = acquireServerLock(path);
    expect(handle.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(String(process.pid));
    if (handle.ok) releaseServerLock(handle.release);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects acquire when existing lock holder is alive", () => {
    const path = join(dir, "kernel-next.lock");
    const first = acquireServerLock(path);
    expect(first.ok).toBe(true);
    const second = acquireServerLock(path);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("already_held_alive");
      if (second.reason === "already_held_alive") {
        expect(second.pid).toBe(process.pid);
      }
    }
    if (first.ok) releaseServerLock(first.release);
  });

  it("takes over the lock when the prior pid is dead", () => {
    const path = join(dir, "kernel-next.lock");
    // Find a pid that is not live. Scan downward from a high value;
    // stop at the first ESRCH. Falls back to self-pid+999999 which is
    // essentially guaranteed to be unused.
    let deadPid = 999_990;
    while (deadPid > 2) {
      try {
        process.kill(deadPid, 0);
        deadPid -= 1;
      } catch {
        break;
      }
    }
    writeFileSync(path, String(deadPid), "utf-8");
    const res = acquireServerLock(path);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(readFileSync(path, "utf-8")).toBe(String(process.pid));
      releaseServerLock(res.release);
    }
  });
});
