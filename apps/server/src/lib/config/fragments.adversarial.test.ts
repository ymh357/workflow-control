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

describe("parseFrontmatter adversarial", () => {
  it("handles content that is only frontmatter delimiters with empty body", () => {
    const raw = "---\nid: test\n---";
    const result = parseFrontmatter(raw);
    expect(result.meta).toBeDefined();
    expect(result.meta!.id).toBe("test");
    expect(result.content).toBe("");
  });

  it("handles multiple --- delimiters (picks first closing)", () => {
    const raw = "---\nid: first\n---\nbody\n---\nid: second\n---";
    const result = parseFrontmatter(raw);
    expect(result.meta!.id).toBe("first");
    expect(result.content).toContain("body");
  });

  it("handles frontmatter with only whitespace in yaml block", () => {
    const raw = "---\n   \n---\ncontent";
    const result = parseFrontmatter(raw);
    // parseYAML("   ") returns null, so parsed will be null
    // The code does `parsed.id` which will throw on null
    // This should fall into the catch and return meta: null
    expect(result.meta).toBeNull();
  });

  it("handles non-string keywords by converting to strings", () => {
    const raw = "---\nid: x\nkeywords:\n  - 123\n  - true\nstages: \"*\"\nalways: false\n---\nbody";
    const result = parseFrontmatter(raw);
    expect(result.meta!.keywords).toEqual(["123", "true"]);
  });

  it("handles stages as non-star string (not array, not '*')", () => {
    const raw = "---\nid: x\nkeywords: []\nstages: single-stage\nalways: false\n---\nbody";
    const result = parseFrontmatter(raw);
    // stages is a string but not "*", and not array, so it falls through to []
    expect(result.meta!.stages).toEqual([]);
  });

  it("handles completely empty string", () => {
    const result = parseFrontmatter("");
    expect(result.meta).toBeNull();
    expect(result.content).toBe("");
  });

  it("handles string with only whitespace", () => {
    const result = parseFrontmatter("   \n  \n  ");
    expect(result.meta).toBeNull();
    expect(result.content).toBe("");
  });

  it("handles frontmatter where --- appears at position 0 of a later line", () => {
    // Content starts with --- but second --- is embedded in content
    const raw = "---\nid: x\nkeywords: []\nstages: \"*\"\nalways: true\n---\nLine1\n---\nLine2";
    const result = parseFrontmatter(raw);
    expect(result.meta).toBeDefined();
    // The content after the first closing --- should include the rest
    expect(result.content).toContain("Line1");
  });
});

describe("FragmentRegistry adversarial: build edge cases", () => {
  it("handles file that throws on read (silently skips)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["good.md", "bad.md"] as any);
    mockReadFileSync.mockImplementation((filePath: any) => {
      if ((filePath as string).endsWith("bad.md")) throw new Error("permission denied");
      return "---\nid: good\nkeywords: []\nstages: \"*\"\nalways: true\n---\nGood";
    });
    const reg = new FragmentRegistry();
    reg.build();
    expect(reg.getAllEntries().size).toBe(1);
    expect(reg.getAllEntries().has("good")).toBe(true);
  });

  it("handles .local.md override that throws on read (silently skips)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["base.md", "base.local.md"] as any);
    mockReadFileSync.mockImplementation((filePath: any) => {
      if ((filePath as string).endsWith("base.local.md")) throw new Error("permission denied");
      return "---\nid: base\nkeywords: []\nstages: \"*\"\nalways: true\n---\nBase content";
    });
    const reg = new FragmentRegistry();
    reg.build();
    // Base should still be loaded
    expect(reg.getAllEntries().get("base")!.content).toBe("Base content");
  });

  it("handles .local.md without frontmatter and no base (legacy local)", () => {
    setupDir({
      "orphan.local.md": "Just plain local content, no frontmatter",
    });
    const reg = new FragmentRegistry();
    reg.build();
    const entry = reg.getAllEntries().get("orphan");
    expect(entry).toBeDefined();
    expect(entry!.meta.always).toBe(true);
    expect(entry!.meta.stages).toBe("*");
    expect(entry!.content).toBe("Just plain local content, no frontmatter");
  });

  it("handles .local.md without frontmatter overriding existing base", () => {
    setupDir({
      "test.md": "---\nid: test\nkeywords:\n  - k1\nstages: \"*\"\nalways: false\n---\nBase",
      "test.local.md": "Local override without frontmatter",
    });
    const reg = new FragmentRegistry();
    reg.build();
    const entry = reg.getAllEntries().get("test");
    // meta is null from local, so keeps base meta
    expect(entry!.meta.keywords).toEqual(["k1"]);
    // Content replaced by local (parseFrontmatter returns content = trimmed raw)
    expect(entry!.content).toBe("Local override without frontmatter");
  });

  it("handles directory with no .md files", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["readme.txt", "config.yaml"] as any);
    const reg = new FragmentRegistry();
    reg.build();
    expect(reg.getAllEntries().size).toBe(0);
  });
});

describe("FragmentRegistry adversarial: resolve edge cases", () => {
  it("returns empty when no fragments exist and stage is queried", () => {
    mockExistsSync.mockReturnValue(false);
    const reg = new FragmentRegistry();
    const results = reg.resolve("nonexistent-stage");
    expect(results).toEqual([]);
  });

  it("keyword fragment with empty enabledSteps is not matched", () => {
    setupDir({
      "kw.md": "---\nid: kw\nkeywords:\n  - feature\nstages: \"*\"\nalways: false\n---\nKW",
    });
    const reg = new FragmentRegistry();
    const results = reg.resolve("any-stage", []);
    // stepsSet.size === 0, so keyword match branch is skipped
    expect(results).toEqual([]);
  });

  it("keyword fragment with undefined enabledSteps is not matched", () => {
    setupDir({
      "kw.md": "---\nid: kw\nkeywords:\n  - feature\nstages: \"*\"\nalways: false\n---\nKW",
    });
    const reg = new FragmentRegistry();
    const results = reg.resolve("any-stage", undefined);
    // stepsSet from [] has size 0
    expect(results).toEqual([]);
  });

  it("fragment with multiple keywords matches if any one step matches", () => {
    setupDir({
      "multi.md": "---\nid: multi\nkeywords:\n  - a\n  - b\n  - c\nstages: \"*\"\nalways: false\n---\nMulti",
    });
    const reg = new FragmentRegistry();
    const results = reg.resolve("stage", ["b"]);
    expect(results).toHaveLength(1);
  });
});

describe("FragmentRegistry adversarial: validate edge cases", () => {
  it("warns for each unknown stage individually", () => {
    setupDir({
      "multi-stage.md": "---\nid: ms\nkeywords:\n  - x\nstages:\n  - bad1\n  - bad2\nalways: false\n---\nBody",
    });
    const reg = new FragmentRegistry();
    reg.build();
    const warnings = reg.validate(["good-stage"]);
    expect(warnings.filter((w) => w.includes("unknown stage"))).toHaveLength(2);
  });

  it("does not warn for fragment with always=true and empty keywords", () => {
    setupDir({
      "always-on.md": "---\nid: always-on\nkeywords: []\nstages: \"*\"\nalways: true\n---\nAlways",
    });
    const reg = new FragmentRegistry();
    reg.build();
    const warnings = reg.validate([]);
    // always=true means it will always load, no warning needed
    expect(warnings.filter((w) => w.includes("no keywords"))).toHaveLength(0);
  });

  it("handles empty pipeline stage names list", () => {
    setupDir({
      "frag.md": "---\nid: frag\nkeywords: []\nstages:\n  - stage-a\nalways: false\n---\nF",
    });
    const reg = new FragmentRegistry();
    reg.build();
    const warnings = reg.validate([]);
    expect(warnings.some((w) => w.includes('unknown stage "stage-a"'))).toBe(true);
  });
});

describe("getFragmentRegistry adversarial: cache TTL", () => {
  it("creates new registry after TTL expires", () => {
    mockExistsSync.mockReturnValue(false);
    const first = getFragmentRegistry();

    // Advance time past TTL
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 70_000);
    const second = getFragmentRegistry();
    expect(first).not.toBe(second);
    vi.restoreAllMocks();
  });
});

describe("resolveFragmentsFromSnapshot adversarial", () => {
  it("handles empty fragmentMeta", () => {
    const results = resolveFragmentsFromSnapshot("stage", ["step"], { a: "content" }, {});
    expect(results).toEqual([]);
  });

  it("handles empty fragmentContents", () => {
    const meta = {
      frag: { id: "frag", keywords: ["step"], stages: "*" as const, always: true },
    };
    const results = resolveFragmentsFromSnapshot("stage", ["step"], {}, meta);
    // Content is falsy (undefined), so it's skipped
    expect(results).toEqual([]);
  });

  it("handles fragment with empty string content (falsy)", () => {
    const meta = {
      frag: { id: "frag", keywords: [], stages: "*" as const, always: true },
    };
    const results = resolveFragmentsFromSnapshot("stage", [], { frag: "" }, meta);
    // Empty string is falsy, so `if (!content) continue` will skip it
    expect(results).toEqual([]);
  });

  it("does not match keyword fragment when enabledSteps is empty array", () => {
    const meta = {
      frag: { id: "frag", keywords: ["kw"], stages: ["s1"] as string[], always: false },
    };
    const results = resolveFragmentsFromSnapshot("s1", [], { frag: "content" }, meta);
    expect(results).toEqual([]);
  });
});
