import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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
});
