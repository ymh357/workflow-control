import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWatcher, rawProjectDir, type WatcherEvent, type Watcher } from "../ingestion/watcher.js";

let dir: string;
let watcher: Watcher | undefined;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fw-")); });
afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("rawProjectDir", () => {
  // Returns the encoded dir name verbatim. We intentionally do NOT
  // decode "-" → "/" because Claude Code's encoding can't round-trip
  // names containing literal hyphens (e.g. workflow-control).
  it("passes through a typical Claude Code encoded path unchanged", () => {
    expect(rawProjectDir("-Users-minghao-foo")).toBe("-Users-minghao-foo");
  });

  it("preserves literal hyphens in the dir name", () => {
    expect(rawProjectDir("-Users-minghao-workflow-control")).toBe(
      "-Users-minghao-workflow-control",
    );
  });

  it("returns empty for empty input", () => {
    expect(rawProjectDir("")).toBe("");
  });
});

describe("startWatcher", () => {
  it("emits an event when a .jsonl file is written", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const events: WatcherEvent[] = [];
    watcher = startWatcher({
      projectsRoot: dir,
      onEvent: (e) => events.push(e),
      debounceMs: 50,
    });
    // Write the .jsonl file after the watcher started
    writeFileSync(join(projDir, "abc-123.jsonl"), '{"a":1}\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(events.length).toBeGreaterThan(0);
    const e = events[0]!;
    expect(e.sessionId).toBe("abc-123");
    expect(e.jsonlPath).toBe(join(projDir, "abc-123.jsonl"));
    expect(e.cwd).toBe("-tmp-fake");
  });

  it("debounces multiple rapid writes to the same file", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const events: WatcherEvent[] = [];
    watcher = startWatcher({
      projectsRoot: dir,
      onEvent: (e) => events.push(e),
      debounceMs: 100,
    });
    const p = join(projDir, "abc.jsonl");
    writeFileSync(p, '{"a":1}\n');
    appendFileSync(p, '{"a":2}\n');
    appendFileSync(p, '{"a":3}\n');
    await new Promise((r) => setTimeout(r, 250));
    // With debounce 100ms and 3 rapid appends, expect 1-2 events
    // (one for the burst, possibly one more if writes spaced beyond debounce)
    expect(events.length).toBeLessThanOrEqual(2);
    expect(events[0]!.sessionId).toBe("abc");
  });

  it("ignores non-.jsonl files", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const events: WatcherEvent[] = [];
    watcher = startWatcher({
      projectsRoot: dir,
      onEvent: (e) => events.push(e),
      debounceMs: 50,
    });
    writeFileSync(join(projDir, "readme.md"), "hello\n");
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toHaveLength(0);
  });

  it("stop cleans up timers and the underlying watcher", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const events: WatcherEvent[] = [];
    watcher = startWatcher({
      projectsRoot: dir,
      onEvent: (e) => events.push(e),
      debounceMs: 50,
    });
    watcher.stop();
    watcher = undefined;
    writeFileSync(join(projDir, "abc.jsonl"), '{"a":1}\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toHaveLength(0);
  });
});
