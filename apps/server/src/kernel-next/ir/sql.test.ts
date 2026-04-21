import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion, getPipelineIR, listPipelineVersions } from "./sql.js";
import { versionHash } from "./canonical.js";
import type { PipelineIR } from "./schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function sampleIR(): PipelineIR {
  return {
    name: "t",
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
      { name: "B", type: "agent", inputs: [{ name: "x", type: "number", zod: "z.number()" }], outputs: [], config: { promptRef: "p" } },
    ],
    wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
  };
}

describe("kernel-next SQL persistence", () => {
  it("creates schema with indices", () => {
    const db = makeDb();
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all();
    const indexNames = (rows as Array<{ name: string }>).map((r) => r.name);
    expect(indexNames).toContain("idx_sa_task_stage");
    expect(indexNames).toContain("idx_sa_version_stage");
    expect(indexNames).toContain("idx_pv_port");
    expect(indexNames).toContain("idx_pv_attempt");
    db.close();
  });

  it("inserts a pipeline version and reads it back", () => {
    const db = makeDb();
    const ir = sampleIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "// gen" });

    const back = getPipelineIR(db, hash);
    expect(back).toEqual(ir);

    // Check child rows persisted.
    const stages = db.prepare("SELECT stage_name FROM stages WHERE version_hash = ?").all(hash);
    expect((stages as Array<{ stage_name: string }>).map((r) => r.stage_name).sort()).toEqual(["A", "B"]);

    const ports = db.prepare("SELECT stage_name, port_name, direction, zod_schema FROM ports WHERE version_hash = ? ORDER BY stage_name, direction, port_name").all(hash);
    expect(ports).toEqual([
      { stage_name: "A", port_name: "x", direction: "out", zod_schema: null },
      { stage_name: "B", port_name: "x", direction: "in", zod_schema: "z.number()" },
    ]);

    const wires = db.prepare("SELECT from_stage, from_port, to_stage, to_port FROM wires WHERE version_hash = ?").all(hash);
    expect(wires).toEqual([{ from_stage: "A", from_port: "x", to_stage: "B", to_port: "x" }]);

    db.close();
  });

  it("rolls back on insert failure (duplicate PK)", () => {
    const db = makeDb();
    const ir = sampleIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "// gen" });
    // Second insert with same hash violates pipeline_versions PK.
    expect(() =>
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "// gen" }),
    ).toThrow();
    // Only one version present (second attempt rolled back).
    expect(listPipelineVersions(db)).toEqual([hash]);
    db.close();
  });

  it("listPipelineVersions filters by name when provided", () => {
    const db = makeDb();
    const a: PipelineIR = { ...sampleIR(), name: "alpha" };
    const b: PipelineIR = { ...sampleIR(), name: "beta" };
    insertPipelineVersion(db, a, { versionHash: versionHash(a), tsSource: "" });
    insertPipelineVersion(db, b, { versionHash: versionHash(b), tsSource: "" });
    expect(listPipelineVersions(db, "alpha")).toEqual([versionHash(a)]);
    expect(listPipelineVersions(db, "beta")).toEqual([versionHash(b)]);
    expect(listPipelineVersions(db).sort()).toEqual([versionHash(a), versionHash(b)].sort());
    db.close();
  });

  it("getPipelineIR returns null for unknown hash", () => {
    const db = makeDb();
    expect(getPipelineIR(db, "nonexistent")).toBeNull();
    db.close();
  });

  it("creates prompt_contents table with content_hash PK", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const cols = db.prepare("PRAGMA table_info(prompt_contents)").all() as Array<{ name: string; pk: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["content", "content_hash", "created_at"]);
    const pk = cols.find((c) => c.name === "content_hash");
    expect(pk?.pk).toBe(1);
  });

  it("creates pipeline_prompt_refs table with composite PK and FK to prompt_contents", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const cols = db.prepare("PRAGMA table_info(pipeline_prompt_refs)").all() as Array<{ name: string; pk: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["content_hash", "prompt_ref", "version_hash"]);
    const fks = db.prepare("PRAGMA foreign_key_list(pipeline_prompt_refs)").all() as Array<{ table: string; from: string; to: string }>;
    expect(fks.some((fk) => fk.table === "prompt_contents" && fk.from === "content_hash")).toBe(true);
    expect(fks.some((fk) => fk.table === "pipeline_versions" && fk.from === "version_hash")).toBe(true);
  });
});
