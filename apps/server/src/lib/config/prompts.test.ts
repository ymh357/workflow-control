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
import { getFragmentRegistry } from "./fragments.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------- loadPipelineSystemPrompt ----------

describe("loadPipelineSystemPrompt", () => {
  it("returns content from .local override if it exists", () => {
    mockExistsSync.mockImplementation((p: any) =>
      (p as string).includes(".local") ? true : false,
    );
    mockReadFileSync.mockReturnValue("  local prompt content  ");
    expect(loadPipelineSystemPrompt("my-pipe", "analyzing")).toBe("local prompt content");
  });

  it("falls back to base path when no local override", () => {
    mockExistsSync.mockImplementation((p: any) => {
      if ((p as string).includes(".local")) return false;
      return true;
    });
    mockReadFileSync.mockReturnValue("  base prompt  ");
    expect(loadPipelineSystemPrompt("my-pipe", "analyzing")).toBe("base prompt");
  });

  it("returns null when neither local nor base exists", () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadPipelineSystemPrompt("my-pipe", "analyzing")).toBeNull();
  });

  it("falls through to base when local read throws", () => {
    let callCount = 0;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error("read error");
      return "base content";
    });
    expect(loadPipelineSystemPrompt("my-pipe", "analyzing")).toBe("base content");
  });
});

// ---------- loadPipelineConstraints ----------

describe("loadPipelineConstraints", () => {
  it("returns constraints content when file exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("  ## Constraints  ");
    expect(loadPipelineConstraints("my-pipe")).toBe("## Constraints");
  });

  it("returns null when file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadPipelineConstraints("my-pipe")).toBeNull();
  });

  it("returns null when read throws", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error("fail"); });
    expect(loadPipelineConstraints("my-pipe")).toBeNull();
  });
});

// ---------- readProjectClaudeMd ----------

describe("readProjectClaudeMd", () => {
  it("returns empty string when cwd is undefined", () => {
    expect(readProjectClaudeMd(undefined)).toBe("");
  });

  it("reads from .claude/CLAUDE.md first", () => {
    mockExistsSync.mockImplementation((p: any) =>
      (p as string).endsWith(".claude/CLAUDE.md"),
    );
    mockReadFileSync.mockReturnValue("claude md content");
    expect(readProjectClaudeMd("/project")).toBe("claude md content");
  });

  it("falls back to CLAUDE.md in root", () => {
    mockExistsSync.mockImplementation((p: any) =>
      (p as string).endsWith("/project/CLAUDE.md") && !(p as string).includes(".claude"),
    );
    mockReadFileSync.mockReturnValue("root claude md");
    expect(readProjectClaudeMd("/project")).toBe("root claude md");
  });

  it("returns empty string when no file found", () => {
    mockExistsSync.mockReturnValue(false);
    expect(readProjectClaudeMd("/project")).toBe("");
  });
});

// ---------- readProjectGeminiMd ----------

describe("readProjectGeminiMd", () => {
  it("returns empty string when cwd is undefined", () => {
    expect(readProjectGeminiMd(undefined)).toBe("");
  });

  it("reads from .gemini/GEMINI.md first", () => {
    mockExistsSync.mockImplementation((p: any) =>
      (p as string).endsWith(".gemini/GEMINI.md"),
    );
    mockReadFileSync.mockReturnValue("gemini md content");
    expect(readProjectGeminiMd("/project")).toBe("gemini md content");
  });

  it("returns empty string when no file found", () => {
    mockExistsSync.mockReturnValue(false);
    expect(readProjectGeminiMd("/project")).toBe("");
  });
});

// ---------- loadPromptFragment ----------

describe("loadPromptFragment", () => {
  it("returns content from registry when fragment exists", () => {
    vi.mocked(getFragmentRegistry).mockReturnValue({
      getAllEntries: () =>
        new Map([["my-frag", { meta: {} as any, content: "frag content" }]]),
    } as any);
    expect(loadPromptFragment("my-frag")).toBe("frag content");
  });

  it("falls back to disk read when not in registry", () => {
    vi.mocked(getFragmentRegistry).mockReturnValue({
      getAllEntries: () => new Map(),
    } as any);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("disk fragment content");
    expect(loadPromptFragment("disk-frag")).toBe("disk fragment content");
  });

  it("returns null when neither registry nor disk has fragment", () => {
    vi.mocked(getFragmentRegistry).mockReturnValue({
      getAllEntries: () => new Map(),
    } as any);
    mockExistsSync.mockReturnValue(false);
    expect(loadPromptFragment("missing")).toBeNull();
  });
});

// ---------- getSkillPath ----------

describe("getSkillPath", () => {
  it("returns local override path when it exists", () => {
    mockExistsSync.mockImplementation((p: any) =>
      (p as string).endsWith(".local.md"),
    );
    const result = getSkillPath("deploy");
    expect(result).toContain("deploy.local.md");
  });

  it("returns base path when no local override", () => {
    mockExistsSync.mockImplementation((p: any) =>
      !(p as string).includes(".local") && (p as string).endsWith("deploy.md"),
    );
    const result = getSkillPath("deploy");
    expect(result).toContain("deploy.md");
    expect(result).not.toContain(".local");
  });

  it("returns null when neither exists", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getSkillPath("missing")).toBeNull();
  });
});

// ---------- getClaudeMdPath / getGeminiMdPath ----------

describe("getClaudeMdPath", () => {
  it("returns path when file exists", () => {
    mockExistsSync.mockReturnValue(true);
    expect(getClaudeMdPath("global.md")).toContain("claude-md/global.md");
  });

  it("returns null when file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getClaudeMdPath("missing.md")).toBeNull();
  });
});

describe("getGeminiMdPath", () => {
  it("returns path when file exists", () => {
    mockExistsSync.mockReturnValue(true);
    expect(getGeminiMdPath("global.md")).toContain("gemini-md/global.md");
  });

  it("returns null when file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getGeminiMdPath("missing.md")).toBeNull();
  });
});

// ---------- loadHookConfig ----------

describe("loadHookConfig", () => {
  it("returns parsed YAML from .local override", () => {
    mockExistsSync.mockImplementation((p: any) =>
      (p as string).includes(".local"),
    );
    mockReadFileSync.mockReturnValue("event: push\ntype: shell\ncommand: echo hi");
    const result = loadHookConfig("on-push");
    expect(result).toEqual({ event: "push", type: "shell", command: "echo hi" });
  });

  it("returns parsed YAML from base path", () => {
    mockExistsSync.mockImplementation((p: any) =>
      !(p as string).includes(".local"),
    );
    mockReadFileSync.mockReturnValue("event: commit\ntype: script");
    const result = loadHookConfig("on-commit");
    expect(result).toEqual({ event: "commit", type: "script" });
  });

  it("returns null when no file exists", () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadHookConfig("missing")).toBeNull();
  });

  it("returns null when parse fails", () => {
    mockExistsSync.mockImplementation((p: any) =>
      !(p as string).includes(".local"),
    );
    mockReadFileSync.mockImplementation(() => { throw new Error("bad yaml"); });
    expect(loadHookConfig("broken")).toBeNull();
  });
});

// ---------- getGatePath ----------

describe("getGatePath", () => {
  it("returns path when gate file exists", () => {
    mockExistsSync.mockReturnValue(true);
    expect(getGatePath("quality")).toContain("gates/quality.ts");
  });

  it("returns null when gate file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getGatePath("missing")).toBeNull();
  });
});
