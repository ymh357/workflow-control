import { describe, it, expect } from "vitest";
import { BUILTIN_SCRIPT_MODULES } from "./index.js";
import type { ScriptModuleContext } from "../runtime/script-module-resolver.js";

const merge = BUILTIN_SCRIPT_MODULES.merge_tutorials!;

function ctx(): ScriptModuleContext {
  return {
    taskId: "t1",
    stageName: "mergeTutorials",
    attemptId: "a1",
    attemptIdx: 1,
    moduleId: "merge_tutorials",
    env: {},
  };
}

describe("merge_tutorials", () => {
  it("concatenates cached then fresh, parallel-array order preserved", async () => {
    const r = await merge.run(
      {
        cachedSlugs: ["a", "b"],
        cachedContents: ["body-a", "body-b"],
        freshSlugs: ["c"],
        freshContents: ["body-c"],
      },
      ctx(),
    );
    expect(r).toEqual({
      slugs: ["a", "b", "c"],
      contents: ["body-a", "body-b", "body-c"],
    });
  });

  it("all-cache (no fresh) → output equals cached", async () => {
    const r = await merge.run(
      {
        cachedSlugs: ["x"],
        cachedContents: ["body-x"],
        freshSlugs: [],
        freshContents: [],
      },
      ctx(),
    );
    expect(r).toEqual({
      slugs: ["x"],
      contents: ["body-x"],
    });
  });

  it("all-fresh (no cache) → output equals fresh", async () => {
    const r = await merge.run(
      {
        cachedSlugs: [],
        cachedContents: [],
        freshSlugs: ["y"],
        freshContents: ["body-y"],
      },
      ctx(),
    );
    expect(r).toEqual({
      slugs: ["y"],
      contents: ["body-y"],
    });
  });

  it("empty-empty → empty", async () => {
    const r = await merge.run(
      {
        cachedSlugs: [], cachedContents: [],
        freshSlugs: [], freshContents: [],
      },
      ctx(),
    );
    expect(r).toEqual({ slugs: [], contents: [] });
  });

  it("treats omitted inputs as empty arrays", async () => {
    const r = await merge.run({}, ctx());
    expect(r).toEqual({ slugs: [], contents: [] });
  });

  it("rejects parallel-array length mismatch in cached", async () => {
    await expect(
      merge.run(
        {
          cachedSlugs: ["a", "b"],
          cachedContents: ["only one"],
          freshSlugs: [], freshContents: [],
        },
        ctx(),
      ),
    ).rejects.toThrow(/cached parallel-array length mismatch/);
  });

  it("rejects parallel-array length mismatch in fresh", async () => {
    await expect(
      merge.run(
        {
          cachedSlugs: [], cachedContents: [],
          freshSlugs: ["a"],
          freshContents: ["x", "y"],
        },
        ctx(),
      ),
    ).rejects.toThrow(/fresh parallel-array length mismatch/);
  });
});
