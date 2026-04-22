import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion, getPipelineIR, listPipelineVersions, insertPromptContent, insertPromptRefs, getPromptContent } from "./sql.js";
import { getLatestVersionHashByName } from "./sql.js";
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

  it("is idempotent on duplicate versionHash (no-op second insert)", () => {
    const db = makeDb();
    const ir = sampleIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "// gen" });
    // Second insert with same hash is a no-op (INSERT OR IGNORE).
    expect(() =>
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "// gen" }),
    ).not.toThrow();
    // Only one version persisted; child rows unchanged.
    expect(listPipelineVersions(db)).toEqual([hash]);
    const stages = db.prepare("SELECT stage_name FROM stages WHERE version_hash = ?").all(hash);
    expect((stages as Array<{ stage_name: string }>).map((r) => r.stage_name).sort()).toEqual(["A", "B"]);
    const ports = db.prepare("SELECT stage_name, port_name, direction FROM ports WHERE version_hash = ?").all(hash);
    expect((ports as Array<unknown>).length).toBe(2);
    const wires = db.prepare("SELECT from_stage FROM wires WHERE version_hash = ?").all(hash);
    expect((wires as Array<unknown>).length).toBe(1);
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
    const cols = db.prepare("PRAGMA table_info(prompt_contents)").all() as Array<{ name: string; pk: number; notnull: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["content", "content_hash", "created_at"]);
    const pk = cols.find((c) => c.name === "content_hash");
    expect(pk?.pk).toBe(1);
    expect(cols.find((c) => c.name === "content")?.notnull).toBe(1);
    expect(cols.find((c) => c.name === "created_at")?.notnull).toBe(1);
  });

  it("creates pipeline_prompt_refs table with composite PK and FK to prompt_contents", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const cols = db.prepare("PRAGMA table_info(pipeline_prompt_refs)").all() as Array<{ name: string; pk: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["content_hash", "prompt_ref", "version_hash"]);
    const fks = db.prepare("PRAGMA foreign_key_list(pipeline_prompt_refs)").all() as Array<{ table: string; from: string; to: string }>;
    const pcFk = fks.find((fk) => fk.table === "prompt_contents");
    const pvFk = fks.find((fk) => fk.table === "pipeline_versions");
    expect(pcFk?.from).toBe("content_hash");
    expect(pcFk?.to).toBe("content_hash");
    expect(pvFk?.from).toBe("version_hash");
    expect(pvFk?.to).toBe("version_hash");
  });
});

describe("insertPromptContent + insertPromptRefs", () => {
  it("inserts content once and is idempotent on same content_hash", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    insertPromptContent(db, "abc123", "hello world");
    insertPromptContent(db, "abc123", "hello world");
    const rows = db.prepare("SELECT content_hash FROM prompt_contents").all();
    expect(rows.length).toBe(1);
  });

  it("inserts prompt refs referencing an existing version and content", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES ('v1', 'test', 0, NULL, '{}', '')`,
    ).run();
    insertPromptContent(db, "h1", "content1");
    insertPromptRefs(db, "v1", { analyzing: "h1", "system/analysis": "h1" });
    const rows = db
      .prepare("SELECT prompt_ref, content_hash FROM pipeline_prompt_refs WHERE version_hash = ? ORDER BY prompt_ref")
      .all("v1") as Array<{ prompt_ref: string; content_hash: string }>;
    expect(rows).toEqual([
      { prompt_ref: "analyzing", content_hash: "h1" },
      { prompt_ref: "system/analysis", content_hash: "h1" },
    ]);
  });

  it("insertPromptRefs is idempotent on same (version_hash, prompt_ref)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES ('v1', 'test', 0, NULL, '{}', '')`,
    ).run();
    insertPromptContent(db, "h1", "c1");
    insertPromptRefs(db, "v1", { analyzing: "h1" });
    insertPromptRefs(db, "v1", { analyzing: "h1" });
    const rows = db.prepare("SELECT prompt_ref FROM pipeline_prompt_refs WHERE version_hash = ?").all("v1");
    expect(rows.length).toBe(1);
  });

  it("getPromptContent returns null for missing content_hash", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    expect(getPromptContent(db, "missing")).toBeNull();
  });
});

describe("getLatestVersionHashByName", () => {
  it("returns null when no row matches", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    expect(getLatestVersionHashByName(db, "missing")).toBeNull();
  });

  it("returns the most recently created version for the given name", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES ('v1', 'p', 1000, NULL, '{}', '')`,
    ).run();
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES ('v2', 'p', 2000, 'v1', '{}', '')`,
    ).run();
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES ('vOther', 'q', 3000, NULL, '{}', '')`,
    ).run();
    expect(getLatestVersionHashByName(db, "p")).toBe("v2");
    expect(getLatestVersionHashByName(db, "q")).toBe("vOther");
  });
});

describe("agent_execution_details table", () => {
  it("creates table with attempt_id PK + FKs", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const cols = db.prepare("PRAGMA table_info(agent_execution_details)").all() as Array<{ name: string; pk: number; notnull: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toContain("attempt_id");
    expect(names).toContain("prompt_ref");
    expect(names).toContain("prompt_content_hash");
    expect(names).toContain("prompt_content");
    expect(names).toContain("model");
    expect(names).toContain("tool_calls_json");
    expect(names).toContain("agent_stream_json");
    expect(names).toContain("cost_usd");
    expect(names).toContain("token_input");
    expect(names).toContain("token_output");
    expect(names).toContain("session_id");
    expect(names).toContain("duration_ms");
    expect(names).toContain("started_at");
    expect(names).toContain("ended_at");
    expect(names).toContain("termination_reason");
    expect(names).toContain("last_heartbeat_at");
    const pk = cols.find((c) => c.name === "attempt_id");
    expect(pk?.pk).toBe(1);

    const fks = db.prepare("PRAGMA foreign_key_list(agent_execution_details)").all() as Array<{ table: string; from: string }>;
    expect(fks.some((fk) => fk.table === "stage_attempts" && fk.from === "attempt_id")).toBe(true);
    expect(fks.some((fk) => fk.table === "prompt_contents" && fk.from === "prompt_content_hash")).toBe(true);
  });

  it("rejects rows without matching stage_attempts row (FK enforcement)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    expect(() => db.prepare(
      `INSERT INTO agent_execution_details
       (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
        tool_calls_json, agent_stream_json,
        started_at, last_heartbeat_at)
       VALUES ('no-such-attempt', 'r', 'h', 'c', 'm', '[]', '[]', 1, 1)`,
    ).run()).toThrow(/FOREIGN KEY/i);
  });

  it("rejects bad termination_reason via CHECK", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    // Seed required rows: version + attempt + prompt_content.
    db.prepare(`INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source) VALUES ('v', 't', 0, NULL, '{}', '')`).run();
    db.prepare(`INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES ('a1', 'tk', 'v', 's', 1, 0, 'running')`).run();
    db.prepare(`INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at) VALUES ('h', 'c', 0)`).run();
    expect(() => db.prepare(
      `INSERT INTO agent_execution_details
       (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
        tool_calls_json, agent_stream_json,
        started_at, ended_at, termination_reason, last_heartbeat_at)
       VALUES ('a1', 'r', 'h', 'c', 'm', '[]', '[]', 1, 2, 'bogus_reason', 2)`,
    ).run()).toThrow(/CHECK/i);
  });
});

describe("script_execution_details table", () => {
  it("creates table with attempt_id PK + required columns", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const cols = db.prepare("PRAGMA table_info(script_execution_details)").all() as Array<{ name: string; pk: number; notnull: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toContain("attempt_id");
    expect(names).toContain("module_id");
    expect(names).toContain("inputs_json");
    expect(names).toContain("outputs_json");
    expect(names).toContain("stdout");
    expect(names).toContain("stderr");
    expect(names).toContain("exit_code");
    expect(names).toContain("error_message");
    expect(names).toContain("error_stack");
    expect(names).toContain("duration_ms");
    expect(names).toContain("started_at");
    expect(names).toContain("ended_at");
    expect(names).toContain("termination_reason");
    const pk = cols.find((c) => c.name === "attempt_id");
    expect(pk?.pk).toBe(1);
  });

  it("has FK attempt_id → stage_attempts ON DELETE RESTRICT", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const fks = db.prepare("PRAGMA foreign_key_list(script_execution_details)").all() as Array<{ table: string; from: string; on_delete: string }>;
    const fk = fks.find((f) => f.table === "stage_attempts" && f.from === "attempt_id");
    expect(fk).toBeDefined();
    expect(fk!.on_delete).toBe("RESTRICT");
  });

  it("rejects rows without matching stage_attempts row (FK enforcement)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    expect(() => db.prepare(
      `INSERT INTO script_execution_details
       (attempt_id, module_id, inputs_json, outputs_json,
        duration_ms, started_at, ended_at, termination_reason)
       VALUES ('no-such-attempt', 'mod', '{}', '{}', 0, 0, 0, 'natural_completion')`,
    ).run()).toThrow(/FOREIGN KEY/i);
  });

  it("rejects bad termination_reason via CHECK", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.prepare(`INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source) VALUES ('v', 't', 0, NULL, '{}', '')`).run();
    db.prepare(`INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES ('a1', 'tk', 'v', 's', 1, 0, 'running')`).run();
    expect(() => db.prepare(
      `INSERT INTO script_execution_details
       (attempt_id, module_id, inputs_json, outputs_json,
        duration_ms, started_at, ended_at, termination_reason)
       VALUES ('a1', 'mod', '{}', '{}', 0, 0, 0, 'bogus_reason')`,
    ).run()).toThrow(/CHECK/i);
  });

  it("accepts all four legal termination_reason values", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.prepare(`INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source) VALUES ('v', 't', 0, NULL, '{}', '')`).run();
    const reasons = ["natural_completion", "error", "module_not_found", "superseded"] as const;
    for (let i = 0; i < reasons.length; i++) {
      const aid = `a${i}`;
      db.prepare(`INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES (?, 'tk', 'v', 's', ?, 0, 'running')`).run(aid, i + 1);
      expect(() => db.prepare(
        `INSERT INTO script_execution_details
         (attempt_id, module_id, inputs_json, outputs_json,
          duration_ms, started_at, ended_at, termination_reason)
         VALUES (?, 'mod', '{}', '{}', 0, 0, 0, ?)`,
      ).run(aid, reasons[i]!)).not.toThrow();
    }
  });

  it("has idx_sed_module index on module_id", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='script_execution_details'").all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toContain("idx_sed_module");
  });
});
