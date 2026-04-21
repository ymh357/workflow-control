import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initKernelNextSchema,
  insertPromptContent,
  insertPromptRefs,
} from "../ir/sql.js";
import { DbPromptResolver } from "./db-prompt-resolver.js";
import type { AgentStage } from "../ir/schema.js";

function seed(db: DatabaseSync, versionHash: string, refs: Record<string, string>) {
  db.prepare(
    `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
     VALUES (?, 'test', 0, NULL, '{}', '')`,
  ).run(versionHash);
  const refsToHash: Record<string, string> = {};
  let i = 0;
  for (const [ref, content] of Object.entries(refs)) {
    const h = `h-${versionHash}-${i++}`;
    insertPromptContent(db, h, content);
    refsToHash[ref] = h;
  }
  insertPromptRefs(db, versionHash, refsToHash);
}

function agentStage(name: string, promptRef: string): AgentStage {
  return { name, type: "agent", inputs: [], outputs: [], config: { promptRef } };
}

describe("DbPromptResolver", () => {
  it("returns stored prompt content for the bound versionHash", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seed(db, "v1", { analyzing: "ANALYZE ME" });
    const r = new DbPromptResolver(db, "v1");
    const out = r.resolve({
      stage: agentStage("analyzing", "analyzing"),
      taskId: "t", attemptId: "a", inputs: {},
    });
    expect(out).toBe("ANALYZE ME");
  });

  it("supports nested / path-style promptRefs", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seed(db, "v1", { "system/analysis": "DEEP" });
    const r = new DbPromptResolver(db, "v1");
    const out = r.resolve({
      stage: agentStage("s", "system/analysis"),
      taskId: "t", attemptId: "a", inputs: {},
    });
    expect(out).toBe("DEEP");
  });

  it("throws a helpful error when promptRef is missing", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seed(db, "v1", { a: "X" });
    const r = new DbPromptResolver(db, "v1");
    expect(() =>
      r.resolve({ stage: agentStage("s", "missing"), taskId: "t", attemptId: "a", inputs: {} }),
    ).toThrow(/promptRef 'missing' not found.*v1.*stage 's'/);
  });

  it("throws when promptRef is empty on stage", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seed(db, "v1", {});
    const r = new DbPromptResolver(db, "v1");
    expect(() =>
      r.resolve({ stage: agentStage("s", ""), taskId: "t", attemptId: "a", inputs: {} }),
    ).toThrow(/empty promptRef/);
  });

  it("distinguishes two versions with same promptRef but different content", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seed(db, "v1", { a: "old" });
    seed(db, "v2", { a: "new" });
    const r1 = new DbPromptResolver(db, "v1");
    const r2 = new DbPromptResolver(db, "v2");
    const args = { stage: agentStage("s", "a"), taskId: "t", attemptId: "a", inputs: {} };
    expect(r1.resolve(args)).toBe("old");
    expect(r2.resolve(args)).toBe("new");
  });
});
