import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { KERNEL_NEXT_SCHEMA } from "../ir/sql.js";
import { storeTaskEnvValues, loadTaskEnvValues, deleteTaskEnvValues } from "./task-env-values.js";

describe("task-env-values: store / load / delete", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(KERNEL_NEXT_SCHEMA);
  });

  it("stores and reads back values by taskId", () => {
    storeTaskEnvValues(db, "task-1", { GITHUB_TOKEN: "ghp_x", NOTION_TOKEN: "ntn_y" });
    expect(loadTaskEnvValues(db, "task-1")).toEqual({ GITHUB_TOKEN: "ghp_x", NOTION_TOKEN: "ntn_y" });
  });

  it("returns empty object for unknown taskId", () => {
    expect(loadTaskEnvValues(db, "missing")).toEqual({});
  });

  it("storing again overwrites existing keys and adds new ones", () => {
    storeTaskEnvValues(db, "t", { A: "1" });
    storeTaskEnvValues(db, "t", { A: "2", B: "3" });
    expect(loadTaskEnvValues(db, "t")).toEqual({ A: "2", B: "3" });
  });

  it("delete removes all values for a taskId", () => {
    storeTaskEnvValues(db, "t", { K: "v" });
    deleteTaskEnvValues(db, "t");
    expect(loadTaskEnvValues(db, "t")).toEqual({});
  });

  it("store with empty object is a no-op", () => {
    storeTaskEnvValues(db, "t", {});
    expect(loadTaskEnvValues(db, "t")).toEqual({});
  });

  it("delete on unknown taskId is safe (no error)", () => {
    expect(() => deleteTaskEnvValues(db, "missing")).not.toThrow();
  });

  it("different taskIds isolated from each other", () => {
    storeTaskEnvValues(db, "a", { K: "av" });
    storeTaskEnvValues(db, "b", { K: "bv" });
    expect(loadTaskEnvValues(db, "a")).toEqual({ K: "av" });
    expect(loadTaskEnvValues(db, "b")).toEqual({ K: "bv" });
  });
});
