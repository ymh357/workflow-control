import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import {
  buildLookupTutorialCache,
  buildWriteTutorialCache,
} from "./tutorial-cache.js";
import type { ScriptModuleContext } from "../runtime/script-module-resolver.js";

function ctx(): ScriptModuleContext {
  return {
    taskId: "t1",
    stageName: "lookupTutorialCache",
    attemptId: "a1",
    attemptIdx: 1,
    moduleId: "lookup_tutorial_cache",
    env: {},
  };
}

describe("lookup_tutorial_cache", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("returns all-miss when cache is empty", async () => {
    const mod = buildLookupTutorialCache(db);
    const r = await mod.run(
      { slugs: ["merkle-tree", "rollup"], subjectDomain: "Ethereum L2" },
      ctx(),
    );
    expect(r).toEqual({
      cachedSlugs: [],
      cachedContents: [],
      missingSlugs: ["merkle-tree", "rollup"],
    });
  });

  it("returns all-hit when every slug is fresh in cache", async () => {
    const writer = buildWriteTutorialCache(db);
    await writer.run(
      {
        slugs: ["merkle-tree", "rollup"],
        contents: ["# Merkle\nbody", "# Rollup\nbody"],
        subjectDomain: "Ethereum L2",
      },
      ctx(),
    );
    const lookup = buildLookupTutorialCache(db);
    const r = await lookup.run(
      { slugs: ["merkle-tree", "rollup"], subjectDomain: "Ethereum L2" },
      ctx(),
    ) as Record<string, unknown>;
    expect(r.cachedSlugs).toEqual(["merkle-tree", "rollup"]);
    expect(r.cachedContents).toEqual(["# Merkle\nbody", "# Rollup\nbody"]);
    expect(r.missingSlugs).toEqual([]);
  });

  it("treats expired rows as miss", async () => {
    const oldTimestamp = Date.now() - (31 * 24 * 60 * 60 * 1000); // 31 days ago
    db.prepare(
      `INSERT INTO tutorial_cache (slug, subject_domain, content_md, sources_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("stale", "domA", "old body", "[]", oldTimestamp);

    const lookup = buildLookupTutorialCache(db);
    const r = await lookup.run(
      { slugs: ["stale", "fresh"], subjectDomain: "domA" },
      ctx(),
    ) as Record<string, unknown>;
    expect(r.cachedSlugs).toEqual([]);
    expect(r.missingSlugs).toEqual(["stale", "fresh"]);
  });

  it("partial overlap returns correct split, preserving input order", async () => {
    const writer = buildWriteTutorialCache(db);
    await writer.run(
      {
        slugs: ["b", "d"],
        contents: ["body-b", "body-d"],
        subjectDomain: "x",
      },
      ctx(),
    );
    const lookup = buildLookupTutorialCache(db);
    const r = await lookup.run(
      { slugs: ["a", "b", "c", "d"], subjectDomain: "x" },
      ctx(),
    ) as Record<string, unknown>;
    expect(r.cachedSlugs).toEqual(["b", "d"]);
    expect(r.cachedContents).toEqual(["body-b", "body-d"]);
    expect(r.missingSlugs).toEqual(["a", "c"]);
  });

  it("empty slugs[] is a no-op (no error, all-empty output)", async () => {
    const lookup = buildLookupTutorialCache(db);
    const r = await lookup.run(
      { slugs: [], subjectDomain: "x" },
      ctx(),
    );
    expect(r).toEqual({
      cachedSlugs: [],
      cachedContents: [],
      missingSlugs: [],
    });
  });

  it("isolates by subject_domain (same slug different domain → independent)", async () => {
    const writer = buildWriteTutorialCache(db);
    await writer.run(
      {
        slugs: ["merkle"],
        contents: ["blockchain merkle"],
        subjectDomain: "blockchain",
      },
      ctx(),
    );
    await writer.run(
      {
        slugs: ["merkle"],
        contents: ["git merkle"],
        subjectDomain: "git-internals",
      },
      ctx(),
    );
    const lookup = buildLookupTutorialCache(db);
    const blockchainHit = await lookup.run(
      { slugs: ["merkle"], subjectDomain: "blockchain" },
      ctx(),
    ) as Record<string, unknown>;
    expect(blockchainHit.cachedContents).toEqual(["blockchain merkle"]);
    const gitHit = await lookup.run(
      { slugs: ["merkle"], subjectDomain: "git-internals" },
      ctx(),
    ) as Record<string, unknown>;
    expect(gitHit.cachedContents).toEqual(["git merkle"]);
  });

  it("rejects non-string slugs[]", async () => {
    const lookup = buildLookupTutorialCache(db);
    await expect(
      lookup.run({ slugs: ["ok", 42], subjectDomain: "x" }, ctx()),
    ).rejects.toThrow(/must be a string/);
  });

  it("caps slug count at 500", async () => {
    const lookup = buildLookupTutorialCache(db);
    const huge = Array.from({ length: 600 }, (_, i) => `slug-${i}`);
    await expect(
      lookup.run({ slugs: huge, subjectDomain: "x" }, ctx()),
    ).rejects.toThrow(/refusing to look up 600 slugs/);
  });

  // Bug 7 fix (c12+ review): on reject re-run, the rejection feedback
  // is non-empty; lookup must bypass the cache so the fanout actually
  // re-authors. Pre-fix the cache hit drained missingSlugs to [],
  // producing a 0-element fanout.
  describe("reject re-run cache bypass (Bug 7)", () => {
    it("treats every slug as missing when tutorialRejectionFeedback is non-empty", async () => {
      const writer = buildWriteTutorialCache(db);
      await writer.run(
        {
          slugs: ["a", "b", "c"],
          contents: ["body-a", "body-b", "body-c"],
          subjectDomain: "dom",
        },
        ctx(),
      );
      const lookup = buildLookupTutorialCache(db);
      const r = await lookup.run(
        {
          slugs: ["a", "b", "c"],
          subjectDomain: "dom",
          tutorialRejectionFeedback: "Tutorials a and b are too shallow; expand both.",
        },
        ctx(),
      );
      expect(r).toEqual({
        cachedSlugs: [],
        cachedContents: [],
        missingSlugs: ["a", "b", "c"],
      });
    });

    it("treats whitespace-only feedback as empty (does NOT bypass)", async () => {
      const writer = buildWriteTutorialCache(db);
      await writer.run(
        { slugs: ["a"], contents: ["v1"], subjectDomain: "dom" },
        ctx(),
      );
      const lookup = buildLookupTutorialCache(db);
      const r = await lookup.run(
        {
          slugs: ["a"],
          subjectDomain: "dom",
          tutorialRejectionFeedback: "   \n\t  ",
        },
        ctx(),
      ) as Record<string, unknown>;
      expect(r.cachedSlugs).toEqual(["a"]);
      expect(r.missingSlugs).toEqual([]);
    });

    it("normal lookup still works when feedback is empty string", async () => {
      const writer = buildWriteTutorialCache(db);
      await writer.run(
        { slugs: ["x"], contents: ["body-x"], subjectDomain: "dom" },
        ctx(),
      );
      const lookup = buildLookupTutorialCache(db);
      const r = await lookup.run(
        {
          slugs: ["x", "y"],
          subjectDomain: "dom",
          tutorialRejectionFeedback: "",
        },
        ctx(),
      ) as Record<string, unknown>;
      expect(r.cachedSlugs).toEqual(["x"]);
      expect(r.missingSlugs).toEqual(["y"]);
    });
  });
});

describe("write_tutorial_cache", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("inserts new rows and returns the count", async () => {
    const mod = buildWriteTutorialCache(db);
    const r = await mod.run(
      {
        slugs: ["a", "b"],
        contents: ["body-a", "body-b"],
        subjectDomain: "dom",
      },
      ctx(),
    );
    expect(r).toEqual({ written: 2 });
    const count = (db.prepare("SELECT COUNT(*) AS n FROM tutorial_cache").get() as { n: number }).n;
    expect(count).toBe(2);
  });

  it("upsert refreshes content + created_at on conflict", async () => {
    const mod = buildWriteTutorialCache(db);
    await mod.run(
      {
        slugs: ["a"],
        contents: ["v1"],
        subjectDomain: "dom",
      },
      ctx(),
    );
    const before = db.prepare(
      "SELECT content_md, created_at FROM tutorial_cache WHERE slug = ? AND subject_domain = ?",
    ).get("a", "dom") as { content_md: string; created_at: number };
    expect(before.content_md).toBe("v1");

    // Sleep to ensure created_at differs (Date.now resolution is ms).
    await new Promise((r) => setTimeout(r, 5));

    await mod.run(
      {
        slugs: ["a"],
        contents: ["v2"],
        subjectDomain: "dom",
      },
      ctx(),
    );
    const after = db.prepare(
      "SELECT content_md, created_at FROM tutorial_cache WHERE slug = ? AND subject_domain = ?",
    ).get("a", "dom") as { content_md: string; created_at: number };
    expect(after.content_md).toBe("v2");
    expect(after.created_at).toBeGreaterThan(before.created_at);
    // Still only one row (upsert, not insert).
    const count = (db.prepare("SELECT COUNT(*) AS n FROM tutorial_cache").get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it("empty input is a no-op (returns written: 0)", async () => {
    const mod = buildWriteTutorialCache(db);
    const r = await mod.run(
      {
        slugs: [],
        contents: [],
        subjectDomain: "dom",
      },
      ctx(),
    );
    expect(r).toEqual({ written: 0 });
  });

  it("rejects parallel-array length mismatch", async () => {
    const mod = buildWriteTutorialCache(db);
    await expect(
      mod.run(
        {
          slugs: ["a", "b"],
          contents: ["only one"],
          subjectDomain: "dom",
        },
        ctx(),
      ),
    ).rejects.toThrow(/length mismatch/);
  });
});
