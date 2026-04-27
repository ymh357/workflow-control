import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initCatalogSchema } from "./sql.js";
import { insertBuiltinEntry } from "./catalog-store.js";
import { recommendForTopicLocal } from "./recommender.js";
import type { CatalogEntry } from "./schema.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "x", source: "builtin", schemaVersion: "1",
    name: "X", description: "test entry",
    useCases: ["use case x"], tags: ["t"],
    command: "npx", args: [], envKeys: [],
    healthCheckTimeoutMs: 1000,
    ...overrides,
  };
}

describe("recommendForTopicLocal", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initCatalogSchema(db);
  });

  it("returns empty for empty catalog", () => {
    expect(recommendForTopicLocal(db, "anything")).toEqual([]);
  });

  it("matches a useCase by token overlap", () => {
    insertBuiltinEntry(db, entry({
      id: "etherscan",
      useCases: ["verify tx hash on ethereum"],
      tags: [],
      description: "x",
    }));

    const r = recommendForTopicLocal(db, "I want to verify a tx hash");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].id).toBe("etherscan");
    expect(r[0].evidence.matchedUseCases.length).toBeGreaterThan(0);
  });

  it("matches by tag", () => {
    insertBuiltinEntry(db, entry({
      id: "etherscan",
      useCases: ["unrelated thing"],
      tags: ["onchain-verification"],
      description: "x",
    }));

    const r = recommendForTopicLocal(db, "research onchain-verification needs");
    expect(r[0]?.id).toBe("etherscan");
    expect(r[0]?.evidence.matchedTags).toContain("onchain-verification");
  });

  it("Chinese substring matches Chinese useCase even without spaces", () => {
    insertBuiltinEntry(db, entry({
      id: "etherscan",
      useCases: ["verify tx on ethereum / 验证以太坊上的合约"],
      tags: [],
      description: "x",
    }));

    const r = recommendForTopicLocal(db, "我要验证以太坊上的桥");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].id).toBe("etherscan");
  });

  it("score is between 0 and 1", () => {
    insertBuiltinEntry(db, entry({
      id: "x",
      useCases: ["test test test test test"],
      tags: ["test"],
      description: "test",
    }));

    const r = recommendForTopicLocal(db, "test");
    expect(r[0].score).toBeGreaterThan(0);
    expect(r[0].score).toBeLessThanOrEqual(1);
  });

  it("filters out entries below MIN_SCORE", () => {
    insertBuiltinEntry(db, entry({
      id: "unrelated",
      useCases: ["xyz unrelated thing"],
      tags: ["unrelated"],
      description: "totally unrelated",
    }));

    expect(recommendForTopicLocal(db, "abc def ghi")).toEqual([]);
  });

  it("respects maxResults", () => {
    for (let i = 0; i < 8; i++) {
      insertBuiltinEntry(db, entry({
        id: `e${i}`,
        useCases: ["common keyword here"],
        tags: ["common"],
      }));
    }

    expect(recommendForTopicLocal(db, "common keyword").length).toBe(5);
    expect(recommendForTopicLocal(db, "common keyword", { maxResults: 3 }).length).toBe(3);
  });

  it("respects excludeIds", () => {
    insertBuiltinEntry(db, entry({ id: "a", useCases: ["common topic"] }));
    insertBuiltinEntry(db, entry({ id: "b", useCases: ["common topic"] }));

    const r = recommendForTopicLocal(db, "common topic", { excludeIds: ["a"] });
    expect(r.map((x) => x.id)).toEqual(["b"]);
  });

  it("ignores deprecated entries", () => {
    insertBuiltinEntry(db, entry({ id: "a", useCases: ["common"] }));
    db.prepare("UPDATE mcp_catalog SET deprecated_at=? WHERE id=?").run(Date.now(), "a");

    expect(recommendForTopicLocal(db, "common")).toEqual([]);
  });

  it("higher useCase match outranks higher tag match", () => {
    insertBuiltinEntry(db, entry({
      id: "use-case-hit",
      useCases: ["alpha beta gamma delta epsilon"],
      tags: [],
    }));
    insertBuiltinEntry(db, entry({
      id: "tag-hit",
      useCases: ["unrelated"],
      tags: ["alpha", "beta", "gamma", "delta", "epsilon"],
    }));

    const r = recommendForTopicLocal(db, "alpha beta gamma");
    expect(r[0].id).toBe("use-case-hit");
  });
});
