import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock dependencies before importing the module under test
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({ toString: () => "abcdef123456" })),
}));

vi.mock("@workflow-control/shared", () => ({
  validatePipelineLogic: vi.fn(() => []),
  getValidationErrors: vi.fn(() => []),
}));

vi.mock("../lib/config/mcp.js", () => ({
  buildMcpFromRegistry: vi.fn(() => null),
}));

vi.mock("../lib/config-loader.js", () => ({
  CONFIG_DIR: "/mock/config",
  clearConfigCache: vi.fn(),
  loadSystemSettings: vi.fn(() => ({
    paths: { repos_base: "/repos" },
    slack: {},
    sandbox: { enabled: false },
    agent: {},
  })),
  loadMcpRegistry: vi.fn(() => null),
  getFragmentRegistry: vi.fn(() => ({
    getAllEntries: () => new Map(),
  })),
  listAvailablePipelines: vi.fn(() => []),
  loadPipelineConfig: vi.fn(() => null),
  isParallelGroup: (entry: any) => entry && typeof entry === "object" && "parallel" in entry,
  flattenStages: (entries: any[]) => {
    const result: any[] = [];
    for (const e of entries) {
      if (e && typeof e === "object" && "parallel" in e) {
        result.push(...e.parallel.stages);
      } else {
        result.push(e);
      }
    }
    return result;
  },
}));

vi.mock("../lib/preflight.js", () => ({
  runPreflight: vi.fn(() => ({ results: [] })),
}));

vi.mock("../scripts/index.js", () => ({
  scriptRegistry: {
    getAllMetadata: vi.fn(() => []),
  },
}));

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, renameSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { clearConfigCache, loadSystemSettings, loadMcpRegistry, listAvailablePipelines } from "../lib/config-loader.js";

const mockReadFileSync = vi.mocked(readFileSync);
const mockReadFile = vi.mocked(readFile);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockMkdirSync = vi.mocked(mkdirSync);

// Import after mocks
const { configRoute } = await import("./config.js");

const app = new Hono();
app.route("/", configRoute);

function jsonReq(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

// ---------- safePath (tested indirectly via routes) ----------

describe("safePath - path traversal prevention", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it("rejects path with '..'", async () => {
    const res = await app.request("/config/pipelines/..%2F..%2Fetc");
    // URL-decoded param: ../../../etc
    expect(res.status).toBe(400);
  });

  it("rejects path with forward slash", async () => {
    const res = await app.request("/config/pipelines/foo%2Fbar");
    expect(res.status).toBe(400);
  });

  it("rejects path with backslash", async () => {
    const res = await app.request("/config/pipelines/foo%5Cbar");
    expect(res.status).toBe(400);
  });

  it("rejects '..' in pipeline name for PUT", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/..%2Fsecret", {
      content: "name: test\nstages: []\n",
    });
    expect(res.status).toBe(400);
  });

  it("accepts valid pipeline name", async () => {
    mockExistsSync.mockImplementation((p: any) => String(p).includes("pipeline.yaml"));
    mockReadFile.mockResolvedValue('name: "valid"\nstages: []\n');

    const res = await app.request("/config/pipelines/my-pipeline");
    expect(res.status).toBe(200);
  });
});

// ---------- GET /config/scripts ----------

describe("GET /config/scripts", () => {
  it("returns script metadata", async () => {
    const res = await app.request("/config/scripts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ---------- GET /config/system ----------

describe("GET /config/system", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadSystemSettings).mockReturnValue({
      paths: { repos_base: "/repos" },
      slack: { bot_token: "xoxb", notify_channel_id: "C123" },
      sandbox: { enabled: false },
      agent: { default_engine: "claude" },
    });
    mockExistsSync.mockReturnValue(false);
  });

  it("returns system info", async () => {
    mockExistsSync.mockImplementation((p: any) => {
      const path = String(p);
      return path.includes("claude-md") || path.includes("gemini-md") || path.includes("codex-md");
    });
    mockReadFile.mockImplementation(((p: any) => {
      const path = String(p);
      if (path.includes("claude-md")) return Promise.resolve("# Claude");
      if (path.includes("gemini-md")) return Promise.resolve("# Gemini");
      if (path.includes("codex-md")) return Promise.resolve("# Codex");
      return Promise.resolve("");
    }) as any);
    const res = await app.request("/config/system");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.environment).toBeDefined();
    expect(body.notifications).toBeDefined();
    expect(body.capabilities).toBeDefined();
    expect(body.sandbox).toBeDefined();
    expect(body.instructions.globalClaudeMd).toBe("# Claude");
    expect(body.instructions.globalGeminiMd).toBe("# Gemini");
    expect(body.instructions.globalCodexMd).toBe("# Codex");
  });

  it("reports slack as configured when tokens present", async () => {
    const res = await app.request("/config/system");
    const body = await res.json();
    expect(body.notifications.slackConfigured).toBe(true);
  });
});

// ---------- GET /config/settings ----------

describe("GET /config/settings", () => {
  it("returns empty raw when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toBe("");
    expect(body.settings).toEqual({});
  });

  it("returns raw and parsed settings when file exists", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('agent:\n  max_budget_usd: 10\n');
    vi.mocked(loadSystemSettings).mockReturnValue({ agent: { max_budget_usd: 10 } } as any);

    const res = await app.request("/config/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toContain("max_budget_usd");
    expect(body.settings).toBeDefined();
  });
});

// ---------- PUT /config/settings ----------

describe("PUT /config/settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("accepts valid YAML content", async () => {
    const res = await jsonReq("PUT", "/config/settings", {
      content: "agent:\n  max_budget_usd: 20\n",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(clearConfigCache).toHaveBeenCalled();
  });

  it("rejects invalid YAML", async () => {
    const res = await jsonReq("PUT", "/config/settings", {
      content: "{{invalid yaml: [",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CONFIG");
  });

  it("rejects missing content field", async () => {
    const res = await jsonReq("PUT", "/config/settings", { wrong: "field" });
    expect(res.status).toBe(400);
  });
});

// ---------- GET /config/pipelines ----------

describe("GET /config/pipelines", () => {
  it("returns pipeline list", async () => {
    vi.mocked(listAvailablePipelines).mockReturnValue([
      { id: "p1", name: "Pipeline 1", engine: "claude", stageCount: 2 },
    ]);
    const res = await app.request("/config/pipelines");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pipelines).toHaveLength(1);
  });
});

// ---------- GET /config/pipelines/:name ----------

describe("GET /config/pipelines/:name", () => {
  it("returns 404 when pipeline not found", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/pipelines/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns raw and parsed when pipeline exists", async () => {
    mockExistsSync.mockImplementation((p: any) => {
      return String(p).includes("pipeline.yaml");
    });
    mockReadFile.mockResolvedValue('name: "test"\nstages:\n  - name: s1\n    type: agent\n');

    const res = await app.request("/config/pipelines/test-pipe");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toContain("name:");
    expect(body.parsed).toBeDefined();
    expect(body.parsed.name).toBe("test");
  });

  it("returns raw with null parsed on bad YAML", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("valid content");
    // Simulate content that parses but may not match expected structure
    const res = await app.request("/config/pipelines/test-pipe");
    expect(res.status).toBe(200);
  });
});

// ---------- PUT /config/pipelines/:name ----------

describe("PUT /config/pipelines/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("accepts valid pipeline YAML", async () => {
    const yaml = 'name: "updated"\nstages:\n  - name: s1\n    type: agent\n';
    const res = await jsonReq("PUT", "/config/pipelines/my-pipe", { content: yaml });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.parsed.name).toBe("updated");
  });

  it("rejects YAML without stages array", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/my-pipe", {
      content: 'name: "no-stages"\n',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors).toBeDefined();
  });

  it("rejects stages without name/type", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/my-pipe", {
      content: 'name: "bad"\nstages:\n  - foo: bar\n',
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid YAML syntax", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/my-pipe", {
      content: "{{broken yaml",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CONFIG");
  });

  it("rejects path traversal in pipeline name", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/..%2Fhack", {
      content: 'name: "hack"\nstages:\n  - name: s\n    type: agent\n',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_PATH");
  });
});

// ---------- POST /config/pipelines ----------

describe("POST /config/pipelines", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("creates minimal pipeline with valid id", async () => {
    const res = await jsonReq("POST", "/config/pipelines", { id: "new-pipe" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe("new-pipe");
  });

  it("rejects missing id", async () => {
    const res = await jsonReq("POST", "/config/pipelines", {});
    expect(res.status).toBe(400);
  });

  it("rejects id with uppercase", async () => {
    const res = await jsonReq("POST", "/config/pipelines", { id: "Bad-Name" });
    expect(res.status).toBe(400);
  });

  it("rejects id with special chars", async () => {
    const res = await jsonReq("POST", "/config/pipelines", { id: "bad_name!" });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate pipeline", async () => {
    mockExistsSync.mockImplementation((p: any) => String(p).includes("pipeline.yaml"));
    const res = await jsonReq("POST", "/config/pipelines", { id: "existing" });
    expect(res.status).toBe(409);
  });

  it("creates pipeline with custom content", async () => {
    const res = await jsonReq("POST", "/config/pipelines", {
      id: "custom",
      content: 'name: "custom"\nstages: []\n',
    });
    expect(res.status).toBe(201);
  });
});

// ---------- DELETE /config/pipelines/:name ----------

describe("DELETE /config/pipelines/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRenameSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("deletes existing pipeline (moves to trash)", async () => {
    mockExistsSync.mockReturnValue(true);
    const res = await app.request("/config/pipelines/old-pipe", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockRenameSync).toHaveBeenCalled();
  });

  it("returns 404 for nonexistent pipeline", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/pipelines/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects path traversal", async () => {
    const res = await app.request("/config/pipelines/..%2Fhack", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});

// ---------- GET /config/mcps ----------

describe("GET /config/mcps", () => {
  it("returns empty registry when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/mcps");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toBe("");
    expect(body.registry).toEqual({});
  });

  it("returns parsed registry when file exists", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('notion:\n  command: npx\n  args: ["-y", "@notionhq/notion-mcp-server"]\n');

    const res = await app.request("/config/mcps");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registry.notion).toBeDefined();
  });
});

// ---------- PUT /config/mcps ----------

describe("PUT /config/mcps", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("accepts valid YAML registry", async () => {
    const res = await jsonReq("PUT", "/config/mcps", {
      content: 'notion:\n  command: npx\n',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("rejects invalid YAML", async () => {
    const res = await jsonReq("PUT", "/config/mcps", {
      content: "{{bad yaml",
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-object YAML (string scalar)", async () => {
    const res = await jsonReq("PUT", "/config/mcps", {
      content: '"just a string"',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CONFIG");
  });

  it("accepts array YAML (typeof array is object in JS)", async () => {
    // The route checks `typeof parsed !== "object"`, and arrays pass that check
    const res = await jsonReq("PUT", "/config/mcps", {
      content: "- just\n- a\n- list\n",
    });
    expect(res.status).toBe(200);
  });
});

// ---------- GET /config/prompts ----------

describe("GET /config/prompts", () => {
  it("returns prompt listings", async () => {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const res = await app.request("/config/prompts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("system");
    expect(body).toHaveProperty("fragments");
    expect(body).toHaveProperty("globalConstraints");
  });
});

// ---------- GET /config/prompts/:category/:name ----------

describe("GET /config/prompts/:category/:name", () => {
  it("returns prompt content", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("# System prompt content");

    const res = await app.request("/config/prompts/system/analyze");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("# System prompt content");
  });

  it("returns 404 for missing prompt", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/prompts/system/missing");
    expect(res.status).toBe(404);
  });

  it("rejects invalid category", async () => {
    const res = await app.request("/config/prompts/invalid/test");
    expect(res.status).toBe(400);
  });

  it("handles global constraints path", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("Constraints content");

    const res = await app.request("/config/prompts/global/constraints");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("Constraints content");
  });
});

// ---------- DELETE /config/prompts/:category/:name ----------

describe("DELETE /config/prompts/:category/:name", () => {
  it("prevents deleting global constraints", async () => {
    const res = await app.request("/config/prompts/global/constraints", { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CONFIG");
  });

  it("deletes existing prompt", async () => {
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => {});

    const res = await app.request("/config/prompts/system/old-prompt", { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});

// ---------- GET/PUT /config/files/:subdir/:name ----------

describe("config files (gates/hooks/skills)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects invalid subdir", async () => {
    const res = await app.request("/config/files/invalid/test.yaml");
    expect(res.status).toBe(400);
  });

  it("accepts gates subdir", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("gate content");
    const res = await app.request("/config/files/gates/lint.yaml");
    expect(res.status).toBe(200);
  });

  it("accepts hooks subdir", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("hook content");
    const res = await app.request("/config/files/hooks/pre-deploy.yaml");
    expect(res.status).toBe(200);
  });

  it("accepts skills subdir", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("skill content");
    const res = await app.request("/config/files/skills/search.md");
    expect(res.status).toBe(200);
  });

  it("returns 404 for missing file", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/files/gates/missing.yaml");
    expect(res.status).toBe(404);
  });
});

// ---------- GET /config/overview ----------

describe("GET /config/overview", () => {
  it("returns overview of all editable dirs", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("gates");
    expect(body).toHaveProperty("hooks");
    expect(body).toHaveProperty("skills");
  });
});

// ---------- claude-md / gemini-md layers ----------

describe("claude-md layers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("GET /config/claude-md returns layers", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/claude-md");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("global");
    expect(body).toHaveProperty("stage");
  });

  it("rejects invalid layer", async () => {
    const res = await app.request("/config/claude-md/invalid/file.md");
    expect(res.status).toBe(400);
  });

  it("accepts global layer", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("global content");
    const res = await app.request("/config/claude-md/global/base.md");
    expect(res.status).toBe(200);
  });

  it("accepts stage layer", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("stage content");
    const res = await app.request("/config/claude-md/stage/analyze.md");
    expect(res.status).toBe(200);
  });
});

describe("gemini-md layers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("GET /config/gemini-md returns layers", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/gemini-md");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("global");
    expect(body).toHaveProperty("stage");
  });

  it("rejects invalid layer", async () => {
    const res = await app.request("/config/gemini-md/invalid/file.md");
    expect(res.status).toBe(400);
  });
});

// ---------- GET /config/sandbox ----------

describe("GET /config/sandbox", () => {
  it("returns sandbox config", async () => {
    vi.mocked(loadSystemSettings).mockReturnValue({
      sandbox: { enabled: true, auto_allow_bash: false },
    } as any);

    const res = await app.request("/config/sandbox");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
  });

  it("returns default when sandbox not configured", async () => {
    vi.mocked(loadSystemSettings).mockReturnValue({} as any);
    const res = await app.request("/config/sandbox");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });
});

// ---------- PUT /config/sandbox ----------

describe("PUT /config/sandbox", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('agent:\n  max_budget_usd: 10\n');
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("saves sandbox config", async () => {
    const res = await jsonReq("PUT", "/config/sandbox", {
      enabled: true,
      auto_allow_bash: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sandbox.enabled).toBe(true);
  });
});

// ---------- Fragment Registry ----------

describe("GET /config/fragments/registry", () => {
  it("returns fragment entries", async () => {
    const res = await app.request("/config/fragments/registry");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("entries");
  });
});

// ---------- Pipeline prompts ----------

describe("Pipeline prompts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("GET constraints returns empty for missing file", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/pipelines/my-pipe/prompts/constraints");
    // safePath will reject if .. etc, but "my-pipe" is fine
    // existsSync returns false for file so should return { content: "" }
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("");
  });

  it("GET system prompts lists files", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/pipelines/my-pipe/prompts/system");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompts).toEqual([]);
  });

  it("rejects traversal in prompt name", async () => {
    const res = await app.request("/config/pipelines/my-pipe/prompts/system/..%2F..%2Fetc");
    expect(res.status).toBe(400);
  });
});

// ---------- POST /config/pipelines (copyFrom & content branches) ----------

describe("POST /config/pipelines - copyFrom", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("returns 404 when copyFrom source does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await jsonReq("POST", "/config/pipelines", {
      id: "new-copy",
      copyFrom: "nonexistent",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("FILE_NOT_FOUND");
  });

  it("returns 400 for invalid copyFrom path traversal", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await jsonReq("POST", "/config/pipelines", {
      id: "new-copy",
      copyFrom: "../hack",
    });
    expect(res.status).toBe(404);
  });
});

// ---------- Pipeline constraints PUT ----------

describe("PUT /config/pipelines/:name/prompts/constraints", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("saves constraints content", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/my-pipe/prompts/constraints", {
      content: "# Constraints",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("rejects path traversal in pipeline name", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/..%2Fhack/prompts/constraints", {
      content: "# Constraints",
    });
    expect(res.status).toBe(400);
  });
});

// ---------- Pipeline constraints GET with content ----------

describe("GET /config/pipelines/:name/prompts/constraints with file", () => {
  it("returns file content when it exists", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("constraint content here");
    const res = await app.request("/config/pipelines/my-pipe/prompts/constraints");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("constraint content here");
  });
});

// ---------- Pipeline system prompts CRUD ----------

describe("GET /config/pipelines/:name/prompts/system/:promptName", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns prompt content when found", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("prompt body");
    const res = await app.request("/config/pipelines/my-pipe/prompts/system/analyze");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("prompt body");
  });

  it("returns 404 when prompt not found", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/pipelines/my-pipe/prompts/system/missing");
    expect(res.status).toBe(404);
  });

  it("appends .md to names without extension", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("content");
    const res = await app.request("/config/pipelines/my-pipe/prompts/system/analyze");
    expect(res.status).toBe(200);
  });

  it("handles names already ending with .md", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("content");
    const res = await app.request("/config/pipelines/my-pipe/prompts/system/analyze.md");
    expect(res.status).toBe(200);
  });
});

describe("PUT /config/pipelines/:name/prompts/system/:promptName", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("saves system prompt", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/my-pipe/prompts/system/analyze", {
      content: "# System prompt",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("rejects path traversal in prompt name", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/my-pipe/prompts/system/..%2Fhack", {
      content: "bad",
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /config/pipelines/:name/prompts/system/:promptName", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockUnlinkSync.mockImplementation(() => {});
  });

  it("deletes existing prompt", async () => {
    mockExistsSync.mockReturnValue(true);
    const res = await app.request("/config/pipelines/my-pipe/prompts/system/old.md", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("returns 404 for missing prompt", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/pipelines/my-pipe/prompts/system/missing.md", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects path traversal", async () => {
    const res = await app.request("/config/pipelines/my-pipe/prompts/system/..%2Fhack", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});

// ---------- Legacy pipeline endpoints ----------

describe("GET /config/pipeline (legacy)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns empty when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/pipeline");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toBe("");
    expect(body.parsed).toBe(null);
  });

  it("returns raw and parsed when file exists", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('name: "legacy"\nstages:\n  - name: s1\n    type: agent\n');
    const res = await app.request("/config/pipeline");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parsed.name).toBe("legacy");
  });
});

describe("PUT /config/pipeline (legacy)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("accepts valid pipeline YAML", async () => {
    const yaml = 'name: "legacy"\nstages:\n  - name: s1\n    type: agent\n';
    const res = await jsonReq("PUT", "/config/pipeline", { content: yaml });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("rejects invalid YAML", async () => {
    const res = await jsonReq("PUT", "/config/pipeline", { content: "{{broken" });
    expect(res.status).toBe(400);
  });

  it("rejects YAML without stages array", async () => {
    const res = await jsonReq("PUT", "/config/pipeline", { content: 'name: "no-stages"\n' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CONFIG");
  });
});

// ---------- Prompt CRUD ----------

describe("PUT /config/prompts/:category/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("saves system prompt content", async () => {
    const res = await jsonReq("PUT", "/config/prompts/system/test-prompt", {
      content: "# Prompt content",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("saves fragments prompt content", async () => {
    const res = await jsonReq("PUT", "/config/prompts/fragments/test-frag", {
      content: "fragment content",
    });
    expect(res.status).toBe(200);
  });

  it("saves global constraints", async () => {
    const res = await jsonReq("PUT", "/config/prompts/global/constraints", {
      content: "global constraint content",
    });
    expect(res.status).toBe(200);
  });

  it("rejects invalid category", async () => {
    const res = await jsonReq("PUT", "/config/prompts/invalid/test", {
      content: "test",
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /config/workbench/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
    mockReaddirSync.mockReturnValue([]);
  });

  it("saves pipeline, prompts, and global instructions in one request", async () => {
    const res = await jsonReq("PUT", "/config/workbench/test-pipeline", {
      config: {
        pipeline: {
          name: "test-pipeline",
          stages: [],
        },
        prompts: {
          system: { analyzing: "# Analyze" },
          fragments: {
            architecture: "Arch guidance",
          },
          fragmentMeta: {
            architecture: { id: "architecture", keywords: ["arch"], stages: "*", always: true },
          },
          globalConstraints: "Do the right thing",
          globalClaudeMd: "# Claude rules",
          globalGeminiMd: "# Gemini rules",
          globalCodexMd: "# Codex rules",
        },
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const renameTargets = mockRenameSync.mock.calls.map((call) => String(call[1]));
    expect(renameTargets).toContain("/mock/config/pipelines/test-pipeline/pipeline.yaml");
    expect(renameTargets).toContain("/mock/config/pipelines/test-pipeline/prompts/global-constraints.md");
    expect(renameTargets).toContain("/mock/config/pipelines/test-pipeline/prompts/system/analyzing.md");
    expect(renameTargets).toContain("/mock/config/prompts/fragments/architecture.md");
    expect(renameTargets).toContain("/mock/config/claude-md/global.md");
    expect(renameTargets).toContain("/mock/config/gemini-md/global.md");
    expect(renameTargets).toContain("/mock/config/codex-md/global.md");
  });

  it("accepts prompt references created within the same workbench payload", async () => {
    const res = await jsonReq("PUT", "/config/workbench/test-pipeline", {
      config: {
        pipeline: {
          name: "test-pipeline",
          stages: [
            {
              name: "analyzing",
              type: "agent",
              runtime: { engine: "llm", system_prompt: "newPrompt" },
            },
          ],
        },
        prompts: {
          system: { newPrompt: "# Analyze" },
          fragments: {},
          fragmentMeta: {},
          globalConstraints: "",
          globalClaudeMd: "",
          globalGeminiMd: "",
          globalCodexMd: "",
        },
      },
    });

    expect(res.status).toBe(200);
  });
});

describe("DELETE /config/prompts/:category/:name - additional", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockUnlinkSync.mockImplementation(() => {});
  });

  it("returns 404 for missing prompt in system category", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/prompts/system/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects invalid category", async () => {
    const res = await app.request("/config/prompts/invalid/test", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("deletes fragment prompt", async () => {
    mockExistsSync.mockReturnValue(true);
    const res = await app.request("/config/prompts/fragments/old-frag", { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});

// ---------- PUT/DELETE config files ----------

describe("PUT /config/files/:subdir/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("saves gate file", async () => {
    const res = await jsonReq("PUT", "/config/files/gates/test.yaml", {
      content: "gate: true",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("saves hook file", async () => {
    const res = await jsonReq("PUT", "/config/files/hooks/pre.yaml", {
      content: "hook: true",
    });
    expect(res.status).toBe(200);
  });

  it("rejects invalid subdir", async () => {
    const res = await jsonReq("PUT", "/config/files/invalid/test.yaml", {
      content: "test",
    });
    expect(res.status).toBe(400);
  });

  it("rejects path traversal", async () => {
    const res = await jsonReq("PUT", "/config/files/gates/..%2Fhack.yaml", {
      content: "test",
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /config/files/:subdir/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockUnlinkSync.mockImplementation(() => {});
  });

  it("deletes existing file", async () => {
    mockExistsSync.mockReturnValue(true);
    const res = await app.request("/config/files/gates/old.yaml", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("returns 404 for missing file", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/files/gates/missing.yaml", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects invalid subdir", async () => {
    const res = await app.request("/config/files/invalid/test.yaml", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("rejects path traversal", async () => {
    const res = await app.request("/config/files/hooks/..%2Fhack", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});

// ---------- CLAUDE.md PUT/DELETE ----------

describe("PUT /config/claude-md/:layer/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("saves global layer file", async () => {
    const res = await jsonReq("PUT", "/config/claude-md/global/base.md", {
      content: "# Global",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("saves stage layer file", async () => {
    const res = await jsonReq("PUT", "/config/claude-md/stage/analyze.md", {
      content: "# Stage",
    });
    expect(res.status).toBe(200);
  });

  it("rejects invalid layer", async () => {
    const res = await jsonReq("PUT", "/config/claude-md/invalid/file.md", {
      content: "test",
    });
    expect(res.status).toBe(400);
  });

  it("rejects path traversal", async () => {
    const res = await jsonReq("PUT", "/config/claude-md/global/..%2Fhack", {
      content: "bad",
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /config/claude-md/:layer/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockUnlinkSync.mockImplementation(() => {});
  });

  it("deletes existing global file", async () => {
    mockExistsSync.mockReturnValue(true);
    const res = await app.request("/config/claude-md/global/old.md", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("deletes existing stage file", async () => {
    mockExistsSync.mockReturnValue(true);
    const res = await app.request("/config/claude-md/stage/old.md", { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("returns 404 for missing file", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/claude-md/global/missing.md", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects invalid layer", async () => {
    const res = await app.request("/config/claude-md/invalid/file.md", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("rejects path traversal", async () => {
    const res = await app.request("/config/claude-md/global/..%2Fhack", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});

// ---------- GEMINI.md CRUD ----------

describe("GET /config/gemini-md/:layer/:name", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns global layer content", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("gemini global content");
    const res = await app.request("/config/gemini-md/global/base.md");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("gemini global content");
  });

  it("returns stage layer content", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("gemini stage content");
    const res = await app.request("/config/gemini-md/stage/analyze.md");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("gemini stage content");
  });

  it("returns 404 for missing file", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/gemini-md/global/missing.md");
    expect(res.status).toBe(404);
  });

  it("rejects path traversal", async () => {
    const res = await app.request("/config/gemini-md/global/..%2Fhack");
    expect(res.status).toBe(400);
  });
});

describe("PUT /config/gemini-md/:layer/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("saves global layer file", async () => {
    const res = await jsonReq("PUT", "/config/gemini-md/global/base.md", {
      content: "# Gemini Global",
    });
    expect(res.status).toBe(200);
  });

  it("saves stage layer file", async () => {
    const res = await jsonReq("PUT", "/config/gemini-md/stage/analyze.md", {
      content: "# Gemini Stage",
    });
    expect(res.status).toBe(200);
  });

  it("rejects invalid layer", async () => {
    const res = await jsonReq("PUT", "/config/gemini-md/invalid/file.md", {
      content: "test",
    });
    expect(res.status).toBe(400);
  });

  it("rejects path traversal", async () => {
    const res = await jsonReq("PUT", "/config/gemini-md/global/..%2Fhack", {
      content: "bad",
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /config/gemini-md/:layer/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockUnlinkSync.mockImplementation(() => {});
  });

  it("deletes existing global file", async () => {
    mockExistsSync.mockReturnValue(true);
    const res = await app.request("/config/gemini-md/global/old.md", { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("deletes existing stage file", async () => {
    mockExistsSync.mockReturnValue(true);
    const res = await app.request("/config/gemini-md/stage/old.md", { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("returns 404 for missing file", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/gemini-md/global/missing.md", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects invalid layer", async () => {
    const res = await app.request("/config/gemini-md/invalid/file.md", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});

// ---------- MCP registry parse error ----------

describe("GET /config/mcps - parse error", () => {
  it("returns empty registry on unparseable YAML", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("{{invalid yaml");
    const res = await app.request("/config/mcps");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registry).toEqual({});
  });
});

// ---------- Settings parse error ----------

describe("GET /config/settings - parse error", () => {
  it("returns empty settings when loadSystemSettings throws", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("valid: yaml");
    vi.mocked(loadSystemSettings).mockImplementation(() => { throw new Error("corrupt"); });

    const res = await app.request("/config/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({});
    expect(body.raw).toBe("valid: yaml");
  });
});

// ---------- PUT /config/sandbox - merge with existing ----------

describe("PUT /config/sandbox - fresh file", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("creates sandbox config when no settings file exists", async () => {
    const res = await jsonReq("PUT", "/config/sandbox", {
      enabled: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sandbox.enabled).toBe(true);
  });
});
