import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
} from "vitest";
import { DatabaseSync } from "node:sqlite";

const testDb = new DatabaseSync(":memory:");
testDb.exec(`
  CREATE TABLE IF NOT EXISTS pipeline_versions (
    version_hash     TEXT PRIMARY KEY,
    pipeline_name    TEXT NOT NULL,
    canonical_json   TEXT NOT NULL,
    first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

vi.mock("../db.js", () => ({
  getDb: () => testDb,
}));

import {
  observePipelineVersion,
  getPipelineVersion,
  listPipelineVersions,
  deletePipelineVersion,
} from "./versions-store.js";

beforeEach(() => {
  testDb.exec("DELETE FROM pipeline_versions");
});

describe("observePipelineVersion", () => {
  it("returns true on first sight, inserts a row", () => {
    const inserted = observePipelineVersion({
      versionHash: "hash-1",
      pipelineName: "pipeline-generator",
      canonicalJson: '{"pipeline":{}}',
    });
    expect(inserted).toBe(true);
    const row = getPipelineVersion("hash-1")!;
    expect(row.versionHash).toBe("hash-1");
    expect(row.pipelineName).toBe("pipeline-generator");
    expect(row.canonicalJson).toBe('{"pipeline":{}}');
    expect(row.firstSeenAt).toEqual(row.lastSeenAt);
  });

  it("returns false on repeat sight, bumps last_seen_at but keeps first_seen_at", async () => {
    observePipelineVersion({
      versionHash: "hash-2",
      pipelineName: "p",
      canonicalJson: "{}",
    });
    const first = getPipelineVersion("hash-2")!;
    // Wait past SQLite datetime() second-resolution so the UPDATE is visible.
    await new Promise((r) => setTimeout(r, 1_100));
    const second = observePipelineVersion({
      versionHash: "hash-2",
      pipelineName: "p",
      canonicalJson: "{}",
    });
    expect(second).toBe(false);
    const after = getPipelineVersion("hash-2")!;
    expect(after.firstSeenAt).toBe(first.firstSeenAt);
    expect(after.lastSeenAt >= first.lastSeenAt).toBe(true);
  });

  it("repeated observe does NOT overwrite canonical_json (PK hash implies same content)", () => {
    observePipelineVersion({
      versionHash: "hash-3",
      pipelineName: "p",
      canonicalJson: '{"version":"original"}',
    });
    // Adversary tries to inject different payload under same hash.
    observePipelineVersion({
      versionHash: "hash-3",
      pipelineName: "p",
      canonicalJson: '{"version":"tampered"}',
    });
    const row = getPipelineVersion("hash-3")!;
    expect(row.canonicalJson).toBe('{"version":"original"}');
  });
});

describe("getPipelineVersion", () => {
  it("returns null for unknown hash", () => {
    expect(getPipelineVersion("missing")).toBeNull();
  });
});

describe("listPipelineVersions", () => {
  beforeEach(async () => {
    testDb.exec("DELETE FROM pipeline_versions");
    observePipelineVersion({
      versionHash: "h-old",
      pipelineName: "pipeline-A",
      canonicalJson: "{}",
    });
    await new Promise((r) => setTimeout(r, 1_100));
    observePipelineVersion({
      versionHash: "h-mid",
      pipelineName: "pipeline-B",
      canonicalJson: "{}",
    });
    await new Promise((r) => setTimeout(r, 1_100));
    observePipelineVersion({
      versionHash: "h-new",
      pipelineName: "pipeline-A",
      canonicalJson: "{}",
    });
  });

  it("orders results by last_seen_at DESC", () => {
    const rows = listPipelineVersions();
    expect(rows.map((r) => r.versionHash)).toEqual(["h-new", "h-mid", "h-old"]);
  });

  it("filters by pipeline_name", () => {
    const rows = listPipelineVersions({ pipelineName: "pipeline-A" });
    expect(rows.map((r) => r.versionHash)).toEqual(["h-new", "h-old"]);
  });

  it("respects limit", () => {
    const rows = listPipelineVersions({ limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it("returns [] when filter matches nothing", () => {
    expect(listPipelineVersions({ pipelineName: "unknown" })).toEqual([]);
  });
});

describe("deletePipelineVersion", () => {
  it("returns true when deleting an existing row", () => {
    observePipelineVersion({
      versionHash: "del-1",
      pipelineName: "p",
      canonicalJson: "{}",
    });
    expect(deletePipelineVersion("del-1")).toBe(true);
    expect(getPipelineVersion("del-1")).toBeNull();
  });

  it("returns false for unknown hash", () => {
    expect(deletePipelineVersion("no-such")).toBe(false);
  });
});
