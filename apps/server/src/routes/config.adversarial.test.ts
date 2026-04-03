import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
  cpSync: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({ toString: () => "abcdef123456" })),
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
import { clearConfigCache, loadSystemSettings, loadMcpRegistry } from "../lib/config-loader.js";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockRealpathSync = vi.mocked(realpathSync);

const { configRoute } = await import("./config.js");

const app = new Hono();
app.route("/", configRoute);

function jsonReq(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

// ---------- safePath - symlink escape ----------

describe("safePath - symlink directory escape", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockMkdirSync.mockImplementation(() => undefined as any);
    mockWriteFileSync.mockImplementation(() => {});
    mockRenameSync.mockImplementation(() => {});
  });

  it("rejects when realpath resolves outside base directory", async () => {
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("evil-link")) return "/etc/passwd";
      return s;
    });

    const res = await app.request("/config/pipelines/evil-link");
    expect(res.status).toBe(400);
  });

  it("allows path when realpath stays within base", async () => {
    mockExistsSync.mockImplementation((p: any) => String(p).includes("pipeline.yaml"));
    mockRealpathSync.mockImplementation((p: any) => String(p));
    mockReadFileSync.mockReturnValue('name: "ok"\nstages: []\n');

    const res = await app.request("/config/pipelines/safe-name");
    expect(res.status).toBe(200);
  });
});

// ---------- PUT /config/settings - YAML injection ----------

describe("PUT /config/settings - YAML edge cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("accepts YAML with null values", async () => {
    const res = await jsonReq("PUT", "/config/settings", {
      content: "agent: null\nslack: null\n",
    });
    expect(res.status).toBe(200);
  });

  it("accepts empty YAML content (empty string)", async () => {
    const res = await jsonReq("PUT", "/config/settings", { content: "" });
    // Empty string is valid YAML (parses to null/undefined)
    expect(res.status).toBe(200);
  });

  it("rejects body with no content field at all", async () => {
    const res = await jsonReq("PUT", "/config/settings", {});
    expect(res.status).toBe(400);
  });

  it("atomicWriteSync cleanup on rename failure", async () => {
    mockRenameSync.mockImplementation(() => {
      throw new Error("rename failed");
    });
    mockUnlinkSync.mockImplementation(() => {});

    const res = await jsonReq("PUT", "/config/settings", {
      content: "agent:\n  key: value\n",
    });
    // Should propagate the error from renameSync
    expect(res.status).toBe(500);
  });
});

// ---------- PUT /config/sandbox - missing/extra fields ----------

describe("PUT /config/sandbox - boundary conditions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("defaults all fields when body is minimal empty object", async () => {
    const res = await jsonReq("PUT", "/config/sandbox", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sandbox.enabled).toBe(false);
    expect(body.sandbox.auto_allow_bash).toBe(true);
  });

  it("merges sandbox into existing YAML config without destroying other sections", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("agent:\n  max_budget_usd: 50\n");

    const res = await jsonReq("PUT", "/config/sandbox", { enabled: true });
    expect(res.status).toBe(200);

    // Verify writeFileSync was called with content containing both agent and sandbox
    const writeCall = mockWriteFileSync.mock.calls[0];
    const written = String(writeCall[1]);
    expect(written).toContain("agent");
    expect(written).toContain("sandbox");
  });

  it("handles corrupt existing YAML gracefully (starts fresh)", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("{{totally broken yaml");

    const res = await jsonReq("PUT", "/config/sandbox", { enabled: true });
    // Should not throw — catches parse error and starts fresh
    expect(res.status).toBe(200);
  });
});

// ---------- POST /config/pipelines - ID validation ----------

describe("POST /config/pipelines - adversarial ID values", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("rejects id with underscores (only hyphens allowed)", async () => {
    const res = await jsonReq("POST", "/config/pipelines", { id: "my_pipeline" });
    expect(res.status).toBe(400);
  });

  it("rejects id with dots", async () => {
    const res = await jsonReq("POST", "/config/pipelines", { id: "my.pipeline" });
    expect(res.status).toBe(400);
  });

  it("rejects empty string id", async () => {
    const res = await jsonReq("POST", "/config/pipelines", { id: "" });
    expect(res.status).toBe(400);
  });

  it("rejects id that is boolean type", async () => {
    const res = await jsonReq("POST", "/config/pipelines", { id: true });
    expect(res.status).toBe(400);
  });

  it("rejects id that is a number", async () => {
    const res = await jsonReq("POST", "/config/pipelines", { id: 123 });
    expect(res.status).toBe(400);
  });

  it("returns 404 when copyFrom references nonexistent pipeline", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await jsonReq("POST", "/config/pipelines", {
      id: "new-pipe",
      copyFrom: "nonexistent-source",
    });
    expect(res.status).toBe(404);
  });
});

// ---------- PUT /config/pipelines/:name - stage validation ----------

describe("PUT /config/pipelines/:name - adversarial stage definitions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("rejects stages with name but missing type", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/test", {
      content: 'name: "test"\nstages:\n  - name: s1\n',
    });
    expect(res.status).toBe(400);
  });

  it("rejects stages with type but missing name", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/test", {
      content: 'name: "test"\nstages:\n  - type: agent\n',
    });
    expect(res.status).toBe(400);
  });

  it("accepts pipeline where stages is null (parsed as falsy)", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/test", {
      content: 'name: "test"\nstages: null\n',
    });
    // stages is null, not an array
    expect(res.status).toBe(400);
  });

  it("rejects YAML that parses to a scalar string", async () => {
    const res = await jsonReq("PUT", "/config/pipelines/test", {
      content: '"just a string"',
    });
    expect(res.status).toBe(400);
  });
});

// ---------- PUT /config/mcps - type confusion ----------

describe("PUT /config/mcps - adversarial YAML types", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockRenameSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);
  });

  it("accepts YAML null (parsed as null, typeof null === 'object')", async () => {
    const res = await jsonReq("PUT", "/config/mcps", { content: "null" });
    // null check: `!parsed || typeof parsed !== "object"` — !null is true, should reject
    expect(res.status).toBe(400);
  });

  it("rejects YAML number value", async () => {
    const res = await jsonReq("PUT", "/config/mcps", { content: "42" });
    expect(res.status).toBe(400);
  });

  it("rejects YAML boolean value", async () => {
    const res = await jsonReq("PUT", "/config/mcps", { content: "true" });
    expect(res.status).toBe(400);
  });
});

// ---------- Prompt paths - edge cases ----------

describe("prompt path resolution - boundary cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("auto-appends .md extension when not present", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("# content");

    const res = await app.request("/config/prompts/system/my-prompt");
    expect(res.status).toBe(200);
  });

  it("does not double-append .md when already present", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("# content");

    const res = await app.request("/config/prompts/system/my-prompt.md");
    expect(res.status).toBe(200);
  });

  it("rejects path traversal in prompt name", async () => {
    const res = await app.request("/config/prompts/system/..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
  });
});

// ---------- DELETE /config/files/:subdir/:name - error paths ----------

describe("DELETE /config/files - adversarial", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects deletion from non-editable subdir", async () => {
    const res = await app.request("/config/files/pipelines/test.yaml", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when trying to delete nonexistent gate file", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/files/gates/missing.yaml", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects path traversal in file name for deletion", async () => {
    const res = await app.request("/config/files/gates/..%2Fsecret.yaml", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});

// ---------- claude-md/gemini-md layer validation ----------

describe("claude-md/gemini-md - invalid layer values", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects invalid layer for GET claude-md", async () => {
    const res = await app.request("/config/claude-md/invalid/file.md");
    expect(res.status).toBe(400);
  });

  it("rejects invalid layer for PUT claude-md", async () => {
    const res = await jsonReq("PUT", "/config/claude-md/invalid/file.md", {
      content: "# test",
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid layer for DELETE gemini-md", async () => {
    const res = await app.request("/config/gemini-md/admin/file.md", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for nonexistent gemini-md stage file", async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await app.request("/config/gemini-md/stage/missing.md");
    expect(res.status).toBe(404);
  });
});
