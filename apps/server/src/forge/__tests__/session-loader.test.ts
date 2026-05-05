import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";
import {
  loadSession, findMostRecentSessionFile, resolveSessionPath, listRecentSessionFiles,
} from "../ingestion/session-loader.js";
import { listEventsBySession, getSession } from "../db/sessions.js";

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fl-"));
  db = new DatabaseSync(":memory:");
  initForgeSchema(db);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(path: string, events: object[]): void {
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, lines);
}

describe("loadSession", () => {
  it("ingests events from a fresh JSONL into forge.db", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const p = join(projDir, "abc.jsonl");
    writeJsonl(p, [
      { sessionId: "abc", message: { role: "user", content: "hi" } },
      { sessionId: "abc", message: { role: "assistant", content: "hello" } },
    ]);
    const r = await loadSession(db, p);
    expect(r.sessionId).toBe("abc");
    expect(r.cwd).toBe("-tmp-fake");
    expect(r.newEventCount).toBe(2);
    const events = listEventsBySession(db, "abc");
    expect(events).toHaveLength(2);
    expect(events[0]!.role).toBe("user");
  });

  it("is idempotent across runs (no double-ingestion via byte_offset)", async () => {
    const p = join(dir, "abc.jsonl");
    writeJsonl(p, [{ sessionId: "abc", message: { role: "user", content: "hi" } }]);
    const r1 = await loadSession(db, p);
    expect(r1.newEventCount).toBe(1);
    const r2 = await loadSession(db, p);
    expect(r2.newEventCount).toBe(0);
    expect(r2.totalEventCount).toBe(1);
  });

  it("ingests appended events on a second call", async () => {
    const p = join(dir, "abc.jsonl");
    writeJsonl(p, [{ sessionId: "abc", message: { role: "user", content: "hi" } }]);
    await loadSession(db, p);
    appendFileSync(p, JSON.stringify({ sessionId: "abc", message: { role: "user", content: "more" } }) + "\n");
    const r2 = await loadSession(db, p);
    expect(r2.newEventCount).toBe(1);
    expect(listEventsBySession(db, "abc")).toHaveLength(2);
  });

  it("detects truncation and re-reads from 0", async () => {
    const p = join(dir, "abc.jsonl");
    writeJsonl(p, [
      { sessionId: "abc", message: { role: "user", content: "first" } },
      { sessionId: "abc", message: { role: "user", content: "second" } },
    ]);
    await loadSession(db, p);
    // Truncate the file
    writeJsonl(p, [{ sessionId: "abc", message: { role: "user", content: "fresh" } }]);
    const r = await loadSession(db, p);
    expect(r.truncatedFromOffset).toBe(true);
    // After truncation reset + re-read, only the new event is parsed.
    // (Existing rows persist; INSERT OR IGNORE on (session, seq) means the
    // new events get a new seq starting after old max.)
    const ev = listEventsBySession(db, "abc");
    expect(ev.length).toBeGreaterThan(0);
  });

  it("throws SESSION_NOT_FOUND for missing path", async () => {
    await expect(loadSession(db, "/nope/does/not/exist.jsonl")).rejects.toThrow(/SESSION_NOT_FOUND/);
  });

  it("redacts secrets during ingestion", async () => {
    const p = join(dir, "abc.jsonl");
    writeJsonl(p, [{
      sessionId: "abc",
      message: { role: "user", content: "use ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa for the api" },
    }]);
    await loadSession(db, p);
    const events = listEventsBySession(db, "abc");
    expect(events[0]!.textExcerpt).toContain("<REDACTED:github-token>");
    expect(events[0]!.textExcerpt).not.toContain("ghp_aaaa");
  });

  it("stores the raw encoded parent dir name as cwd (no lossy decode)", async () => {
    const projDir = join(dir, "-Users-foo-bar-project");
    mkdirSync(projDir, { recursive: true });
    const p = join(projDir, "x.jsonl");
    writeJsonl(p, [{ sessionId: "x", message: { role: "user", content: "hi" } }]);
    const r = await loadSession(db, p);
    expect(r.cwd).toBe("-Users-foo-bar-project");
  });

  it("preserves literal hyphens in the project dir name (regression for workflow-control)", async () => {
    const projDir = join(dir, "-private-tmp-workflow-control-data");
    mkdirSync(projDir, { recursive: true });
    const p = join(projDir, "y.jsonl");
    writeJsonl(p, [{ sessionId: "y", message: { role: "user", content: "hi" } }]);
    const r = await loadSession(db, p);
    expect(r.cwd).toBe("-private-tmp-workflow-control-data");
  });
});

describe("resolveSessionPath", () => {
  it("returns the path of a previously-loaded session", async () => {
    const p = join(dir, "abc.jsonl");
    writeJsonl(p, [{ sessionId: "abc", message: { role: "user", content: "hi" } }]);
    await loadSession(db, p);
    expect(resolveSessionPath(db, "abc")).toBe(p);
  });

  it("returns null for unknown sessionId", () => {
    expect(resolveSessionPath(db, "ghost")).toBeNull();
  });
});

describe("findMostRecentSessionFile", () => {
  it("returns null when projects root does not exist", async () => {
    expect(await findMostRecentSessionFile(join(dir, "nope"))).toBeNull();
  });

  it("returns the most recently modified .jsonl across all subdirs", async () => {
    const proj1 = join(dir, "-tmp-a");
    const proj2 = join(dir, "-tmp-b");
    mkdirSync(proj1, { recursive: true });
    mkdirSync(proj2, { recursive: true });
    writeFileSync(join(proj1, "old.jsonl"), '{"x":1}\n');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(proj2, "new.jsonl"), '{"x":2}\n');
    const res = await findMostRecentSessionFile(dir);
    expect(res).not.toBeNull();
    expect(res!.endsWith("new.jsonl")).toBe(true);
  });

  it("ignores non-.jsonl files", async () => {
    const proj1 = join(dir, "-tmp-a");
    mkdirSync(proj1, { recursive: true });
    writeFileSync(join(proj1, "readme.md"), "x\n");
    expect(await findMostRecentSessionFile(dir)).toBeNull();
  });
});

describe("listRecentSessionFiles", () => {
  it("returns empty when projects root does not exist", async () => {
    expect(await listRecentSessionFiles(join(dir, "nope"), 5)).toEqual([]);
  });

  it("returns empty when projects root has no .jsonl files", async () => {
    const proj1 = join(dir, "-tmp-a");
    mkdirSync(proj1, { recursive: true });
    writeFileSync(join(proj1, "readme.md"), "x\n");
    expect(await listRecentSessionFiles(dir, 5)).toEqual([]);
  });

  it("returns up to N files newest-first across subdirs", async () => {
    const proj1 = join(dir, "-tmp-a");
    const proj2 = join(dir, "-tmp-b");
    mkdirSync(proj1, { recursive: true });
    mkdirSync(proj2, { recursive: true });
    writeFileSync(join(proj1, "oldest.jsonl"), '{"x":1}\n');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(proj2, "middle.jsonl"), '{"x":2}\n');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(proj1, "newest.jsonl"), '{"x":3}\n');
    const res = await listRecentSessionFiles(dir, 3);
    expect(res).toHaveLength(3);
    expect(res[0]!.endsWith("newest.jsonl")).toBe(true);
    expect(res[1]!.endsWith("middle.jsonl")).toBe(true);
    expect(res[2]!.endsWith("oldest.jsonl")).toBe(true);
  });

  it("respects the count cap when more files exist than requested", async () => {
    const proj1 = join(dir, "-tmp-a");
    mkdirSync(proj1, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(proj1, `s${i}.jsonl`), `{"i":${i}}\n`);
      await new Promise((r) => setTimeout(r, 5));
    }
    const res = await listRecentSessionFiles(dir, 2);
    expect(res).toHaveLength(2);
  });

  it("returns empty for count <= 0", async () => {
    const proj1 = join(dir, "-tmp-a");
    mkdirSync(proj1, { recursive: true });
    writeFileSync(join(proj1, "x.jsonl"), "{}\n");
    expect(await listRecentSessionFiles(dir, 0)).toEqual([]);
    expect(await listRecentSessionFiles(dir, -1)).toEqual([]);
  });
});
