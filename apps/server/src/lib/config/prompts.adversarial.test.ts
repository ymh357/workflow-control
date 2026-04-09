import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("./settings.js", () => ({
  CONFIG_DIR: "/fake/config",
}));

vi.mock("./fragments.js", () => ({
  getFragmentRegistry: vi.fn(() => ({
    getAllEntries: vi.fn(() => new Map()),
  })),
  parseFrontmatter: vi.fn((raw: string) => ({ meta: null, content: raw.trim() })),
}));

import { readFileSync, existsSync } from "node:fs";
import {
  loadPipelineSystemPrompt,
  loadPipelineConstraints,
  readProjectClaudeMd,
  readProjectGeminiMd,
  loadPromptFragment,
  getSkillPath,
  getClaudeMdPath,
  getGeminiMdPath,
  loadHookConfig,
  getGatePath,
} from "./prompts.js";
import { getFragmentRegistry, parseFrontmatter } from "./fragments.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadPipelineSystemPrompt adversarial", () => {
  it("trims whitespace from loaded prompt", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("\n\n  prompt with whitespace  \n\n");
    expect(loadPipelineSystemPrompt("pipe", "stage")).toBe("prompt with whitespace");
  });

  it("rejects pipeline name with path-traversal characters", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("evil content");
    const result = loadPipelineSystemPrompt("../evil", "stage");
    // safeName rejects names containing ".." or "/"
    expect(result).toBeNull();
  });

  it("returns null when both local and base read throw", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("read error");
    });
    // Local throws -> falls through; base exists but also throws -> returns null
    expect(loadPipelineSystemPrompt("pipe", "stage")).toBeNull();
  });

  it("rejects empty string prompt name", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("content");
    const result = loadPipelineSystemPrompt("pipe", "");
    // safeName rejects empty strings
    expect(result).toBeNull();
  });
});

describe("loadPipelineConstraints adversarial", () => {
  it("handles file that exists but reads as empty string", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("   ");
    // "   ".trim() === ""
    expect(loadPipelineConstraints("pipe")).toBe("");
  });
});

describe("readProjectClaudeMd adversarial", () => {
  it("returns empty string for empty cwd", () => {
    // Empty string is falsy
    expect(readProjectClaudeMd("")).toBe("");
  });

  it("returns empty string when existsSync returns true but read throws", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    // Both .claude/CLAUDE.md and CLAUDE.md throw, falls through to ""
    expect(readProjectClaudeMd("/project")).toBe("");
  });

  it("prefers .claude/CLAUDE.md over root CLAUDE.md", () => {
    mockExistsSync.mockReturnValue(true);
    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? "from .claude dir" : "from root";
    });
    expect(readProjectClaudeMd("/project")).toBe("from .claude dir");
  });
});

describe("readProjectGeminiMd adversarial", () => {
  it("returns empty string for empty cwd", () => {
    expect(readProjectGeminiMd("")).toBe("");
  });

  it("falls back to root GEMINI.md when .gemini/GEMINI.md doesn't exist", () => {
    mockExistsSync.mockImplementation((p: any) => {
      return !(p as string).includes(".gemini");
    });
    mockReadFileSync.mockReturnValue("root gemini content");
    expect(readProjectGeminiMd("/project")).toBe("root gemini content");
  });
});

describe("loadPromptFragment adversarial", () => {
  it("uses parseFrontmatter when loading from disk fallback", () => {
    vi.mocked(getFragmentRegistry).mockReturnValue({
      getAllEntries: () => new Map(),
    } as any);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("---\nid: x\n---\nactual content");
    vi.mocked(parseFrontmatter).mockReturnValue({ meta: null, content: "actual content" });

    expect(loadPromptFragment("disk-frag")).toBe("actual content");
    expect(parseFrontmatter).toHaveBeenCalled();
  });

  it("returns null when disk fallback read throws", () => {
    vi.mocked(getFragmentRegistry).mockReturnValue({
      getAllEntries: () => new Map(),
    } as any);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadPromptFragment("broken-frag")).toBeNull();
  });

  it("handles fragment name with special characters", () => {
    vi.mocked(getFragmentRegistry).mockReturnValue({
      getAllEntries: () => new Map(),
    } as any);
    mockExistsSync.mockReturnValue(false);
    expect(loadPromptFragment("name/with/../traversal")).toBeNull();
  });
});

describe("getSkillPath adversarial", () => {
  it("checks local path before base path", () => {
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p: any) => {
      checkedPaths.push(p as string);
      return false;
    });
    getSkillPath("test");
    expect(checkedPaths[0]).toContain(".local.md");
    expect(checkedPaths[1]).toContain("test.md");
    expect(checkedPaths[1]).not.toContain(".local");
  });

  it("returns local path even when base also exists", () => {
    mockExistsSync.mockReturnValue(true);
    const result = getSkillPath("deploy");
    expect(result).toContain(".local.md");
  });
});

describe("getClaudeMdPath / getGeminiMdPath adversarial", () => {
  it("constructs correct path under claude-md directory", () => {
    mockExistsSync.mockReturnValue(true);
    const result = getClaudeMdPath("sub/path.md");
    expect(result).toContain("claude-md/sub/path.md");
  });

  it("constructs correct path under gemini-md directory", () => {
    mockExistsSync.mockReturnValue(true);
    const result = getGeminiMdPath("sub/path.md");
    expect(result).toContain("gemini-md/sub/path.md");
  });
});

describe("loadHookConfig adversarial", () => {
  it("returns local override even if base also exists", () => {
    mockExistsSync.mockReturnValue(true);
    let readCount = 0;
    mockReadFileSync.mockImplementation(() => {
      readCount++;
      if (readCount === 1) return "event: local-event\ntype: local-type";
      return "event: base-event\ntype: base-type";
    });
    const result = loadHookConfig("my-hook");
    expect(result!.event).toBe("local-event");
  });

  it("falls through to base when local read throws", () => {
    let readCount = 0;
    mockExistsSync.mockImplementation((p: any) => {
      return (p as string).includes(".local") || (p as string).endsWith(".yaml");
    });
    mockReadFileSync.mockImplementation((p: any) => {
      if ((p as string).includes(".local")) throw new Error("fail");
      return "event: base\ntype: shell";
    });
    const result = loadHookConfig("fallback-hook");
    expect(result!.event).toBe("base");
  });

  it("handles YAML that parses to non-object", () => {
    mockExistsSync.mockImplementation((p: any) => !(p as string).includes(".local"));
    mockReadFileSync.mockReturnValue("just a string");
    const result = loadHookConfig("string-yaml");
    // parseYAML("just a string") returns the string, which is cast to HookConfig
    expect(result).toBe("just a string");
  });
});

describe("getGatePath adversarial", () => {
  it("only checks .ts extension", () => {
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p: any) => {
      checkedPaths.push(p as string);
      return false;
    });
    getGatePath("quality");
    expect(checkedPaths).toHaveLength(1);
    expect(checkedPaths[0]).toContain("quality.ts");
  });
});
