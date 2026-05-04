import { describe, it, expect, afterEach } from "vitest";
import { __setForgeDbForTest, getForgeDb } from "../db/open.js";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";

describe("getForgeDb", () => {
  afterEach(() => __setForgeDbForTest(undefined));

  it("returns the test override when set", () => {
    const db = new DatabaseSync(":memory:");
    initForgeSchema(db);
    __setForgeDbForTest(db);
    expect(getForgeDb()).toBe(db);
  });

  it("throws when not initialized", () => {
    __setForgeDbForTest(undefined);
    expect(() => getForgeDb()).toThrow(/not initialized/i);
  });
});
