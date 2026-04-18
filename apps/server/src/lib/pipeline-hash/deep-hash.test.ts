import { describe, it, expect } from "vitest";
import {
  collectPipelineFragmentDigest,
  canonicalHashDeep,
} from "./deep-hash.js";
import { canonicalHash } from "./canonical.js";

// Test resolver scaffolding — a map of fragments keyed by id, plus a
// matcher that mimics the real FragmentRegistry behavior closely enough
// for the properties we care about here.
type FragEntry = {
  content: string;
  always: boolean;
  stages: string[] | "*";
  keywords: string[];
};

function makeResolver(
  entries: Record<string, FragEntry>,
): (stage: string, steps: string[] | undefined) => Array<{
  id: string;
  content: string;
  meta: { stages: string[] | "*"; keywords: string[]; always: boolean };
}> {
  return (stageName, steps) => {
    const stepsSet = new Set(steps ?? []);
    const out: Array<{
      id: string;
      content: string;
      meta: { stages: string[] | "*"; keywords: string[]; always: boolean };
    }> = [];
    for (const [id, e] of Object.entries(entries)) {
      const stageMatch = e.stages === "*" || (e.stages as string[]).includes(stageName);
      if (!stageMatch) continue;
      const meta = { stages: e.stages, keywords: e.keywords, always: e.always };
      if (e.always) {
        out.push({ id, content: e.content, meta });
      } else if (stepsSet.size > 0 && e.keywords.some((k) => stepsSet.has(k))) {
        out.push({ id, content: e.content, meta });
      }
    }
    return out;
  };
}

const simplePipeline = {
  name: "simple",
  stages: [
    { name: "analyze", type: "agent", runtime: {} },
    { name: "implement", type: "agent", runtime: {} },
  ],
};

const pipelineWithSteps = {
  name: "with-steps",
  stages: [
    {
      name: "analyze",
      type: "agent",
      runtime: {
        available_steps: [
          { key: "reviewSecurity", label: "Security" },
          { key: "reviewPerf", label: "Perf" },
        ],
      },
    },
  ],
};

const pipelineWithParallel = {
  name: "with-parallel",
  stages: [
    {
      parallel: {
        name: "gather",
        stages: [
          { name: "gatherA", type: "agent", runtime: {} },
          { name: "gatherB", type: "agent", runtime: {} },
        ],
      },
    },
  ],
};

describe("collectPipelineFragmentDigest", () => {
  it("is empty when no fragments match", () => {
    const resolver = makeResolver({
      "unrelated-frag": {
        content: "x",
        always: false,
        stages: ["someOtherStage"],
        keywords: [],
      },
    });
    expect(collectPipelineFragmentDigest(simplePipeline, resolver)).toEqual([]);
  });

  it("includes always-true fragments that match at least one stage", () => {
    const resolver = makeResolver({
      "global-inv": {
        content: "inv",
        always: true,
        stages: "*",
        keywords: [],
      },
    });
    const digest = collectPipelineFragmentDigest(simplePipeline, resolver);
    expect(digest).toHaveLength(1);
    expect(digest[0]!.id).toBe("global-inv");
    expect(digest[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes step-matched fragments via available_steps probing", () => {
    const resolver = makeResolver({
      "sec-frag": {
        content: "sec",
        always: false,
        stages: ["analyze"],
        keywords: ["reviewSecurity"],
      },
      "perf-frag": {
        content: "perf",
        always: false,
        stages: ["analyze"],
        keywords: ["reviewPerf"],
      },
      "unrelated": {
        content: "u",
        always: false,
        stages: ["analyze"],
        keywords: ["somethingElse"],
      },
    });
    const digest = collectPipelineFragmentDigest(pipelineWithSteps, resolver);
    const ids = digest.map((d) => d.id);
    expect(ids).toContain("sec-frag");
    expect(ids).toContain("perf-frag");
    expect(ids).not.toContain("unrelated");
  });

  it("descends into parallel group children", () => {
    const resolver = makeResolver({
      "only-in-gatherA": {
        content: "A",
        always: true,
        stages: ["gatherA"],
        keywords: [],
      },
      "only-in-gatherB": {
        content: "B",
        always: true,
        stages: ["gatherB"],
        keywords: [],
      },
    });
    const digest = collectPipelineFragmentDigest(pipelineWithParallel, resolver);
    const ids = digest.map((d) => d.id);
    expect(ids).toContain("only-in-gatherA");
    expect(ids).toContain("only-in-gatherB");
  });

  it("returns entries sorted alphabetically by id (deterministic)", () => {
    const resolver = makeResolver({
      zeta: { content: "z", always: true, stages: "*", keywords: [] },
      alpha: { content: "a", always: true, stages: "*", keywords: [] },
      mid: { content: "m", always: true, stages: "*", keywords: [] },
    });
    const digest = collectPipelineFragmentDigest(simplePipeline, resolver);
    expect(digest.map((d) => d.id)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("de-duplicates a fragment that matches multiple stages", () => {
    const resolver = makeResolver({
      "multi-match": {
        content: "c",
        always: true,
        stages: "*",
        keywords: [],
      },
    });
    const digest = collectPipelineFragmentDigest(simplePipeline, resolver);
    expect(digest).toHaveLength(1);
  });
});

describe("canonicalHashDeep", () => {
  it("equals canonicalHash(pipeline + empty fragments) when resolver returns nothing", () => {
    const resolver = makeResolver({});
    const deep = canonicalHashDeep(simplePipeline, resolver);
    const baseline = canonicalHash({
      pipeline: simplePipeline,
      fragments: [],
    });
    expect(deep).toEqual(baseline);
  });

  it("differs when a fragment's content changes", () => {
    const before = makeResolver({
      frag: { content: "v1", always: true, stages: "*", keywords: [] },
    });
    const after = makeResolver({
      frag: { content: "v2", always: true, stages: "*", keywords: [] },
    });
    expect(canonicalHashDeep(simplePipeline, before)).not.toEqual(
      canonicalHashDeep(simplePipeline, after),
    );
  });

  it("does not differ when an unrelated fragment is added to the registry but does not match", () => {
    const base = makeResolver({
      "match": { content: "m", always: true, stages: "*", keywords: [] },
    });
    const extra = makeResolver({
      "match": { content: "m", always: true, stages: "*", keywords: [] },
      "nope": {
        content: "n",
        always: false,
        stages: ["otherStage"],
        keywords: [],
      },
    });
    expect(canonicalHashDeep(simplePipeline, base)).toEqual(
      canonicalHashDeep(simplePipeline, extra),
    );
  });

  it("differs when pipeline YAML changes (keeps canonicalHash sensitivity)", () => {
    const a = canonicalHashDeep(simplePipeline, makeResolver({}));
    const b = canonicalHashDeep(
      { ...simplePipeline, stages: [...simplePipeline.stages, { name: "extra", type: "agent", runtime: {} }] },
      makeResolver({}),
    );
    expect(a).not.toEqual(b);
  });

  it("accepts a raw YAML string as input", () => {
    const yaml = `
name: y
stages:
  - name: s
    type: agent
    runtime: {}
`;
    const hash = canonicalHashDeep(yaml, makeResolver({}));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across calls", () => {
    const resolver = makeResolver({
      a: { content: "AA", always: true, stages: "*", keywords: [] },
      b: { content: "BB", always: true, stages: "*", keywords: [] },
    });
    const first = canonicalHashDeep(simplePipeline, resolver);
    const second = canonicalHashDeep(simplePipeline, resolver);
    expect(first).toEqual(second);
  });
});

// T1.1 — Activation rules must flip the hash even when the rule change
// doesn't alter the current pipeline's probe results. Previously only
// content changes were hashed; keywords/stages/always drifting silently
// kept the hash stable, which made pipelineVersionHash a false identity.
describe("canonicalHashDeep — activation rule sensitivity (T1.1)", () => {
  it("differs when a fragment's keywords change (even if still matched here)", () => {
    const before = makeResolver({
      frag: { content: "same", always: false, stages: ["analyze"], keywords: ["reviewSecurity"] },
    });
    const after = makeResolver({
      frag: { content: "same", always: false, stages: ["analyze"], keywords: ["reviewSecurity", "newKeyword"] },
    });
    // Both probed with the same pipeline → both return the frag with same content.
    // Pre-T1.1 these would hash identically; post-T1.1 meta digest differs.
    expect(canonicalHashDeep(pipelineWithSteps, before)).not.toEqual(
      canonicalHashDeep(pipelineWithSteps, after),
    );
  });

  it("differs when a fragment's stages scope changes (even if still matches here)", () => {
    const before = makeResolver({
      frag: { content: "same", always: true, stages: ["analyze"], keywords: [] },
    });
    const after = makeResolver({
      frag: { content: "same", always: true, stages: ["analyze", "other"], keywords: [] },
    });
    expect(canonicalHashDeep(simplePipeline, before)).not.toEqual(
      canonicalHashDeep(simplePipeline, after),
    );
  });

  it("differs when a fragment toggles always (same content, same matched result)", () => {
    // Both configs result in the fragment matching on 'analyze'.
    // - always=true + stages:["analyze"] → matches via always
    // - always=false + stages:["analyze"] + keywords:["reviewSecurity"] → matches via step probe
    const before = makeResolver({
      frag: { content: "same", always: true, stages: ["analyze"], keywords: ["reviewSecurity"] },
    });
    const after = makeResolver({
      frag: { content: "same", always: false, stages: ["analyze"], keywords: ["reviewSecurity"] },
    });
    expect(canonicalHashDeep(pipelineWithSteps, before)).not.toEqual(
      canonicalHashDeep(pipelineWithSteps, after),
    );
  });

  it("is stable when meta is semantically identical but key order varies", () => {
    // canonicalJson sorts object keys, so {stages, keywords, always} and
    // {always, keywords, stages} must produce the same metaHash.
    const r1 = (stageName: string, _steps: string[] | undefined) => {
      if (stageName !== "analyze" && stageName !== "implement") return [];
      return [{
        id: "f",
        content: "c",
        meta: { stages: "*" as const, keywords: ["a", "b"], always: true },
      }];
    };
    const r2 = (stageName: string, _steps: string[] | undefined) => {
      if (stageName !== "analyze" && stageName !== "implement") return [];
      return [{
        id: "f",
        content: "c",
        // Same values, different key order
        meta: { always: true, keywords: ["a", "b"], stages: "*" as const },
      }];
    };
    expect(canonicalHashDeep(simplePipeline, r1)).toEqual(
      canonicalHashDeep(simplePipeline, r2),
    );
  });
});
