import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("./settings.js", () => ({
  CONFIG_DIR: "/fake/config",
}));

import { readFileSync, existsSync, readdirSync } from "node:fs";
import {
  parseFrontmatter,
  FragmentRegistry,
  getFragmentRegistry,
  clearFragmentCache,
  resolveFragmentsFromSnapshot,
} from "./fragments.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

beforeEach(() => {
  vi.clearAllMocks();
  clearFragmentCache();
});

// ---------- parseFrontmatter ----------

describe("parseFrontmatter", () => {
  it("returns null meta when no frontmatter markers", () => {
    const result = parseFrontmatter("just some content");
    expect(result.meta).toBeNull();
    expect(result.content).toBe("just some content");
  });

  it("returns null meta when opening --- but no closing ---", () => {
    const result = parseFrontmatter("---\nid: test\nno closing");
    expect(result.meta).toBeNull();
  });

  it("parses valid frontmatter with keywords and stages", () => {
    const raw = `---
id: my-frag
keywords:
  - lint
  - test
stages:
  - analyzing
  - coding
always: false
---
Fragment body here`;
    const result = parseFrontmatter(raw);
    expect(result.meta).toEqual({
      id: "my-frag",
      keywords: ["lint", "test"],
      stages: ["analyzing", "coding"],
      always: false,
    });
    expect(result.content).toBe("Fragment body here");
  });

  it("handles stages: '*' wildcard", () => {
    const raw = `---
id: global
keywords: []
stages: "*"
always: true
---
Global content`;
    const { meta } = parseFrontmatter(raw);
    expect(meta!.stages).toBe("*");
    expect(meta!.always).toBe(true);
  });

  it("returns null meta on invalid YAML", () => {
    const raw = `---
: : invalid: [yaml
---
body`;
    const result = parseFrontmatter(raw);
    expect(result.meta).toBeNull();
  });

  it("defaults missing fields gracefully", () => {
    const raw = `---
some_other_key: true
---
content`;
    const { meta } = parseFrontmatter(raw);
    expect(meta!.id).toBe("");
    expect(meta!.keywords).toEqual([]);
    expect(meta!.stages).toEqual([]);
    expect(meta!.always).toBe(false);
  });
});

// ---------- FragmentRegistry ----------

describe("FragmentRegistry", () => {
  function setupDir(files: Record<string, string>) {
    mockExistsSync.mockReturnValue(true);
    const allFiles = Object.keys(files);
    mockReaddirSync.mockReturnValue(allFiles as any);
    mockReadFileSync.mockImplementation((filePath: any) => {
      const name = allFiles.find((f) => (filePath as string).endsWith(f));
      if (name) return files[name];
      throw new Error(`ENOENT: ${filePath}`);
    });
  }

  describe("build", () => {
    it("returns empty when directory does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      const reg = new FragmentRegistry();
      reg.build();
      expect(reg.getAllEntries().size).toBe(0);
    });

    it("loads .md files with frontmatter", () => {
      setupDir({
        "lint.md": `---\nid: lint\nkeywords:\n  - lint\nstages: "*"\nalways: false\n---\nLint rules`,
      });
      const reg = new FragmentRegistry();
      reg.build();
      const entry = reg.getAllEntries().get("lint");
      expect(entry).toBeDefined();
      expect(entry!.meta.keywords).toEqual(["lint"]);
      expect(entry!.content).toBe("Lint rules");
    });

    it("treats .md files without frontmatter as always/*", () => {
      setupDir({ "legacy.md": "Legacy content no frontmatter" });
      const reg = new FragmentRegistry();
      reg.build();
      const entry = reg.getAllEntries().get("legacy");
      expect(entry!.meta.always).toBe(true);
      expect(entry!.meta.stages).toBe("*");
    });

    it("applies .local.md overrides to existing base fragment", () => {
      setupDir({
        "lint.md": `---\nid: lint\nkeywords:\n  - lint\nstages: "*"\nalways: false\n---\nBase content`,
        "lint.local.md": `---\nid: lint\nkeywords:\n  - lint-local\nstages: "*"\nalways: true\n---\nLocal override content`,
      });
      const reg = new FragmentRegistry();
      reg.build();
      const entry = reg.getAllEntries().get("lint");
      expect(entry!.content).toBe("Local override content");
      expect(entry!.meta.keywords).toEqual(["lint-local"]);
    });

    it("adds .local.md as new fragment when no base exists", () => {
      setupDir({
        "custom.local.md": `---\nid: custom\nkeywords:\n  - custom\nstages:\n  - coding\nalways: false\n---\nCustom local only`,
      });
      const reg = new FragmentRegistry();
      reg.build();
      const entry = reg.getAllEntries().get("custom");
      expect(entry).toBeDefined();
      expect(entry!.content).toBe("Custom local only");
    });

    it("skips .local.md files in the base pass", () => {
      setupDir({
        "base.md": `---\nid: base\nkeywords: []\nstages: "*"\nalways: true\n---\nBase`,
        "base.local.md": `---\nid: base\nkeywords: []\nstages: "*"\nalways: true\n---\nOverride`,
      });
      const reg = new FragmentRegistry();
      reg.build();
      // Should have exactly one entry, overridden by local
      expect(reg.getAllEntries().size).toBe(1);
      expect(reg.getAllEntries().get("base")!.content).toBe("Override");
    });
  });

  describe("resolve", () => {
    it("returns always-on fragments matching stage", () => {
      setupDir({
        "global.md": `---\nid: global\nkeywords: []\nstages: "*"\nalways: true\n---\nGlobal content`,
      });
      const reg = new FragmentRegistry();
      const results = reg.resolve("analyzing");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("global");
    });

    it("returns keyword-matched fragments when enabledSteps match", () => {
      setupDir({
        "lint.md": `---\nid: lint\nkeywords:\n  - lint\nstages:\n  - coding\nalways: false\n---\nLint content`,
      });
      const reg = new FragmentRegistry();
      const results = reg.resolve("coding", ["lint"]);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("lint");
    });

    it("excludes keyword fragments when no matching enabledSteps", () => {
      setupDir({
        "lint.md": `---\nid: lint\nkeywords:\n  - lint\nstages:\n  - coding\nalways: false\n---\nLint content`,
      });
      const reg = new FragmentRegistry();
      const results = reg.resolve("coding", ["test"]);
      expect(results).toHaveLength(0);
    });

    it("excludes fragments not matching stage", () => {
      setupDir({
        "lint.md": `---\nid: lint\nkeywords:\n  - lint\nstages:\n  - coding\nalways: false\n---\nLint content`,
      });
      const reg = new FragmentRegistry();
      const results = reg.resolve("analyzing", ["lint"]);
      expect(results).toHaveLength(0);
    });

    it("auto-builds if entries are empty", () => {
      setupDir({
        "auto.md": `---\nid: auto\nkeywords: []\nstages: "*"\nalways: true\n---\nAuto`,
      });
      const reg = new FragmentRegistry();
      // Do NOT call build explicitly
      const results = reg.resolve("anything");
      expect(results).toHaveLength(1);
    });
  });

  describe("getAllKeywordsWithDescriptions", () => {
    it("returns all keyword-fragment pairs", () => {
      setupDir({
        "a.md": `---\nid: a\nkeywords:\n  - kw1\n  - kw2\nstages: "*"\nalways: false\n---\nA`,
        "b.md": `---\nid: b\nkeywords:\n  - kw3\nstages: "*"\nalways: false\n---\nB`,
      });
      const reg = new FragmentRegistry();
      reg.build();
      const kws = reg.getAllKeywordsWithDescriptions();
      expect(kws).toEqual([
        { keyword: "kw1", fragmentId: "a" },
        { keyword: "kw2", fragmentId: "a" },
        { keyword: "kw3", fragmentId: "b" },
      ]);
    });

    it("returns empty array when no keywords exist", () => {
      setupDir({
        "nope.md": `---\nid: nope\nkeywords: []\nstages: "*"\nalways: true\n---\nNope`,
      });
      const reg = new FragmentRegistry();
      reg.build();
      expect(reg.getAllKeywordsWithDescriptions()).toEqual([]);
    });
  });

  describe("validate", () => {
    it("warns about fragments with no keywords and always=false", () => {
      setupDir({
        "dead.md": `---\nid: dead\nkeywords: []\nstages: "*"\nalways: false\n---\nDead`,
      });
      const reg = new FragmentRegistry();
      reg.build();
      const warnings = reg.validate(["analyzing"]);
      expect(warnings.some((w) => w.includes("no keywords"))).toBe(true);
    });

    it("warns about unknown stage references", () => {
      setupDir({
        "frag.md": `---\nid: frag\nkeywords:\n  - x\nstages:\n  - nonexistent\nalways: false\n---\nF`,
      });
      const reg = new FragmentRegistry();
      reg.build();
      const warnings = reg.validate(["analyzing", "coding"]);
      expect(warnings.some((w) => w.includes('unknown stage "nonexistent"'))).toBe(true);
    });

    it("warns about duplicate keywords across fragments", () => {
      setupDir({
        "a.md": `---\nid: a\nkeywords:\n  - shared\nstages: "*"\nalways: false\n---\nA`,
        "b.md": `---\nid: b\nkeywords:\n  - shared\nstages: "*"\nalways: false\n---\nB`,
      });
      const reg = new FragmentRegistry();
      reg.build();
      const warnings = reg.validate([]);
      expect(warnings.some((w) => w.includes('"shared"') && w.includes("multiple fragments"))).toBe(true);
    });
  });
});

// ---------- getFragmentRegistry ----------

describe("getFragmentRegistry", () => {
  it("returns a FragmentRegistry instance", () => {
    mockExistsSync.mockReturnValue(false);
    const reg = getFragmentRegistry();
    expect(reg).toBeInstanceOf(FragmentRegistry);
  });

  it("returns the cached instance within TTL", () => {
    mockExistsSync.mockReturnValue(false);
    const first = getFragmentRegistry();
    const second = getFragmentRegistry();
    expect(first).toBe(second);
  });

  it("returns a new instance after clearFragmentCache", () => {
    mockExistsSync.mockReturnValue(false);
    const first = getFragmentRegistry();
    clearFragmentCache();
    const second = getFragmentRegistry();
    expect(first).not.toBe(second);
  });
});

// ---------- resolveFragmentsFromSnapshot ----------

describe("resolveFragmentsFromSnapshot", () => {
  const fragmentContents: Record<string, string> = {
    global: "Global content",
    lint: "Lint content",
    test: "Test content",
  };

  const fragmentMeta = {
    global: { id: "global", keywords: [], stages: "*" as const, always: true },
    lint: { id: "lint", keywords: ["lint"], stages: ["coding"], always: false },
    test: { id: "test", keywords: ["test"], stages: ["coding"], always: false },
  };

  it("returns always-on fragments matching stage", () => {
    const results = resolveFragmentsFromSnapshot("coding", [], fragmentContents, fragmentMeta);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("global");
  });

  it("returns keyword-matched fragments", () => {
    const results = resolveFragmentsFromSnapshot("coding", ["lint"], fragmentContents, fragmentMeta);
    expect(results.map((r) => r.id)).toContain("lint");
    expect(results.map((r) => r.id)).toContain("global");
  });

  it("excludes fragments not matching stage", () => {
    const results = resolveFragmentsFromSnapshot("analyzing", ["lint"], fragmentContents, fragmentMeta);
    expect(results.map((r) => r.id)).not.toContain("lint");
  });

  it("skips fragments with missing content", () => {
    const sparseContents = { global: "Global content" };
    const results = resolveFragmentsFromSnapshot("coding", ["lint"], sparseContents, fragmentMeta);
    expect(results.map((r) => r.id)).not.toContain("lint");
  });

  it("handles undefined enabledSteps", () => {
    const results = resolveFragmentsFromSnapshot("coding", undefined, fragmentContents, fragmentMeta);
    // Only always-on should appear (lint/test require keyword match)
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("global");
  });
});
