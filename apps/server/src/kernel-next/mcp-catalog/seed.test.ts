import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCatalogSchema } from "./sql.js";
import { seedBuiltinFromJson } from "./seed.js";
import { getEntry, upsertCustomEntry } from "./catalog-store.js";

describe("seedBuiltinFromJson", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), "catalog-seed-"));
  });

  function writeJson(content: unknown): string {
    const path = join(tmpDir, "entries.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it("inserts builtin entries from JSON", () => {
    const path = writeJson({
      schemaVersion: "1",
      entries: [
        {
          id: "x",
          schemaVersion: "1",
          name: "X",
          description: "x",
          useCases: ["use x"],
          tags: ["t"],
          command: "npx",
          args: ["-y", "@x/mcp"],
          envKeys: [],
          healthCheckTimeoutMs: 1000,
        },
      ],
    });

    const r = seedBuiltinFromJson(db, path);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.inserted).toBe(1);
      expect(r.updated).toBe(0);
      expect(r.deprecated).toBe(0);
    }

    expect(getEntry(db, "x")?.source).toBe("builtin");
  });

  it("updates existing builtin on second run", () => {
    const path = writeJson({
      schemaVersion: "1",
      entries: [
        {
          id: "x", schemaVersion: "1", name: "X-v1", description: "x",
          useCases: ["use x"], tags: [], command: "npx", args: [],
          envKeys: [], healthCheckTimeoutMs: 1000,
        },
      ],
    });
    seedBuiltinFromJson(db, path);

    writeFileSync(path, JSON.stringify({
      schemaVersion: "1",
      entries: [
        {
          id: "x", schemaVersion: "1", name: "X-v2", description: "x",
          useCases: ["use x"], tags: [], command: "npx", args: [],
          envKeys: [], healthCheckTimeoutMs: 1000,
        },
      ],
    }));
    const r = seedBuiltinFromJson(db, path);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.inserted).toBe(0);
      expect(r.updated).toBe(1);
    }

    expect(getEntry(db, "x")?.name).toBe("X-v2");
  });

  it("marks builtin deprecated when removed from JSON", () => {
    const fullPath = writeJson({
      schemaVersion: "1",
      entries: [
        { id: "a", schemaVersion: "1", name: "A", description: "a", useCases: ["a"], tags: [], command: "npx", args: [], envKeys: [], healthCheckTimeoutMs: 1000 },
        { id: "b", schemaVersion: "1", name: "B", description: "b", useCases: ["b"], tags: [], command: "npx", args: [], envKeys: [], healthCheckTimeoutMs: 1000 },
      ],
    });
    seedBuiltinFromJson(db, fullPath);

    writeFileSync(fullPath, JSON.stringify({
      schemaVersion: "1",
      entries: [
        { id: "a", schemaVersion: "1", name: "A", description: "a", useCases: ["a"], tags: [], command: "npx", args: [], envKeys: [], healthCheckTimeoutMs: 1000 },
      ],
    }));
    const r = seedBuiltinFromJson(db, fullPath);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.deprecated).toBe(1);
    }

    expect(getEntry(db, "b")).toBeNull();
    expect(getEntry(db, "b", { includeDeprecated: true })?.deprecatedAt).toBeGreaterThan(0);
  });

  it("does not affect custom entries", () => {
    upsertCustomEntry(db, {
      id: "my-custom", source: "custom", schemaVersion: "1",
      name: "My", description: "mine", useCases: ["mine"], tags: [],
      command: "npx", args: [], envKeys: [], healthCheckTimeoutMs: 1000,
    });

    const path = writeJson({ schemaVersion: "1", entries: [] });
    seedBuiltinFromJson(db, path);

    expect(getEntry(db, "my-custom")?.source).toBe("custom");
  });

  it("returns failure result on missing file (does not throw)", () => {
    const r = seedBuiltinFromJson(db, "/nonexistent/path.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/ENOENT|not found/i);
    }
  });

  it("returns failure result on invalid JSON (does not throw)", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "not json at all");
    const r = seedBuiltinFromJson(db, path);
    expect(r.ok).toBe(false);
  });

  it("returns failure result on invalid entry shape", () => {
    const path = writeJson({
      schemaVersion: "1",
      entries: [
        { id: "INVALID UPPERCASE", schemaVersion: "1", name: "x", description: "x", useCases: ["a"], tags: [], command: "npx", args: [], envKeys: [], healthCheckTimeoutMs: 1000 },
      ],
    });
    const r = seedBuiltinFromJson(db, path);
    expect(r.ok).toBe(false);
  });

  it("rejects entries.json that includes deprecatedAt field", () => {
    const path = writeJson({
      schemaVersion: "1",
      entries: [
        {
          id: "x", schemaVersion: "1", name: "X", description: "x",
          useCases: ["use x"], tags: [], command: "npx", args: [],
          envKeys: [], healthCheckTimeoutMs: 1000,
          deprecatedAt: 12345,
        },
      ],
    });
    const r = seedBuiltinFromJson(db, path);
    expect(r.ok).toBe(false);
  });
});
