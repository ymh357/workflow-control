import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs");
vi.mock("../cli/lib/fetch.js", () => ({
  fetchIndex: vi.fn(),
  fetchManifest: vi.fn(),
  downloadPackageFiles: vi.fn(),
}));
vi.mock("../cli/lib/lock.js", () => ({
  readLock: vi.fn(),
  writeLock: vi.fn(),
  addToLock: vi.fn(),
  removeFromLock: vi.fn(),
}));
vi.mock("../cli/lib/constants.js", () => ({
  CONFIG_DIR: "/fake/config",
  TYPE_DIR_MAP: {
    pipeline: "pipelines",
    skill: "skills",
    fragment: "prompts/fragments",
    hook: "hooks",
    gate: "gates",
    script: "scripts",
    mcp: "mcps",
  } as Record<string, string>,
}));
vi.mock("../cli/lib/github.js", () => ({
  publishToGitHub: vi.fn(),
}));
vi.mock("yaml", () => ({
  stringify: vi.fn((obj: unknown) => JSON.stringify(obj)),
  parse: vi.fn((str: string) => JSON.parse(str)),
}));

import * as fs from "node:fs";
import { RegistryService } from "./registry-service.js";
import { fetchIndex, fetchManifest, downloadPackageFiles } from "../cli/lib/fetch.js";
import { readLock, writeLock, addToLock, removeFromLock } from "../cli/lib/lock.js";
import { publishToGitHub } from "../cli/lib/github.js";
import type { PackageManifest, LockFile, LockFileEntry, RegistryPackageSummary } from "../cli/lib/types.js";

const mockFetchIndex = vi.mocked(fetchIndex);
const mockFetchManifest = vi.mocked(fetchManifest);
const mockDownloadPackageFiles = vi.mocked(downloadPackageFiles);
const mockReadLock = vi.mocked(readLock);
const mockWriteLock = vi.mocked(writeLock);
const mockAddToLock = vi.mocked(addToLock);
const mockRemoveFromLock = vi.mocked(removeFromLock);
const mockFs = vi.mocked(fs);

function makeManifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    name: "test-pkg",
    version: "1.0.0",
    type: "pipeline",
    description: "A test package",
    author: "tester",
    tags: ["demo"],
    files: ["pipeline.yaml"],
    ...overrides,
  };
}

function makePkg(overrides: Partial<RegistryPackageSummary> = {}): RegistryPackageSummary {
  return {
    name: "test-pkg",
    version: "1.0.0",
    type: "pipeline",
    description: "A test package",
    author: "tester",
    tags: ["demo"],
    ...overrides,
  };
}

function emptyLock(): LockFile {
  return { lockVersion: 1, packages: {} };
}

function lockWith(entries: Record<string, LockFileEntry>): LockFile {
  return { lockVersion: 1, packages: entries };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAddToLock.mockImplementation((lock, name, entry) => ({
    ...lock,
    packages: { ...lock.packages, [name]: entry },
  }));
  mockRemoveFromLock.mockImplementation((lock, name) => {
    const { [name]: _, ...rest } = lock.packages;
    return { ...lock, packages: rest };
  });
});

const svc = new RegistryService();

// ---------- search() edge cases ----------

describe("search - adversarial queries", () => {
  it("handles regex-like characters in query without crashing", async () => {
    mockFetchIndex.mockResolvedValue({
      version: 1,
      updated_at: "",
      packages: [makePkg({ name: "test", description: "safe", tags: [] })],
    });

    // Query with regex special chars — should be treated as literal
    const results = await svc.search(".*+?^${}()|[]\\");
    expect(results).toHaveLength(0);
  });

  it("handles empty string query (matches everything)", async () => {
    mockFetchIndex.mockResolvedValue({
      version: 1,
      updated_at: "",
      packages: [makePkg({ name: "a" }), makePkg({ name: "b" })],
    });

    const results = await svc.search("");
    // Empty string: q="" and "a".includes("") is true
    expect(results).toHaveLength(2);
  });

  it("handles undefined query with type filter", async () => {
    mockFetchIndex.mockResolvedValue({
      version: 1,
      updated_at: "",
      packages: [makePkg({ type: "skill" }), makePkg({ name: "p", type: "pipeline" })],
    });

    const results = await svc.search(undefined, "skill");
    expect(results).toHaveLength(1);
  });
});

// ---------- install() - circular dependencies ----------

describe("install - circular dependency handling", () => {
  it("does not infinite-loop on circular dependencies", async () => {
    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockReadLock.mockReturnValue(emptyLock());
    mockDownloadPackageFiles.mockResolvedValue(["/fake/config/skills/a.md"]);

    // A depends on B, B depends on A
    mockFetchManifest.mockImplementation(async (name) => {
      if (name === "a") return makeManifest({ name: "a", type: "skill", files: ["a.md"], dependencies: { skills: ["b"] } });
      if (name === "b") return makeManifest({ name: "b", type: "skill", files: ["b.md"], dependencies: { skills: ["a"] } });
      throw new Error(`Unknown package: ${name}`);
    });

    // collectDeps uses a Map to track visited — should not infinite-loop
    const result = await svc.install(["a"]);
    expect(result.installed.map((i) => i.name)).toContain("a");
    expect(result.installed.map((i) => i.name)).toContain("b");
  });
});

// ---------- install() - version spec with @ ----------

describe("install - version spec edge cases", () => {
  it("handles package name containing @ (scoped-like, e.g., @scope/pkg)", async () => {
    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockReadLock.mockReturnValue(emptyLock());

    // "@scope/pkg".split("@")[0] = "" — the name becomes empty string
    mockFetchManifest.mockResolvedValue(makeManifest({ name: "", type: "pipeline" }));
    mockDownloadPackageFiles.mockResolvedValue([]);

    const result = await svc.install(["@scope/pkg"]);
    // Demonstrates the split("@")[0] bug with scoped packages
    expect(mockFetchManifest).toHaveBeenCalledWith("");
  });

  it("handles package name with multiple @ signs", async () => {
    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockReadLock.mockReturnValue(emptyLock());
    mockFetchManifest.mockResolvedValue(makeManifest({ name: "pkg", type: "pipeline" }));
    mockDownloadPackageFiles.mockResolvedValue(["/fake/config/pipelines/pipeline.yaml"]);

    // "pkg@1.0@extra".split("@")[0] = "pkg"
    await svc.install(["pkg@1.0@extra"]);
    expect(mockFetchManifest).toHaveBeenCalledWith("pkg");
  });
});

// ---------- uninstall() edge cases ----------

describe("uninstall - adversarial scenarios", () => {
  it("handles uninstalling package whose files no longer exist on disk", async () => {
    mockReadLock.mockReturnValue(lockWith({
      "dead-pkg": {
        version: "1.0.0",
        type: "skill",
        author: "test",
        installed_at: "2024-01-01",
        files: ["config/skills/dead.md"],
      },
    }));
    mockFs.existsSync.mockReturnValue(false);

    const result = await svc.uninstall(["dead-pkg"]);
    expect(result.removed).toContain("dead-pkg");
    expect(result.notFound).toHaveLength(0);
    // Should not throw even though files don't exist
  });

  it("reports not-found for packages not in lockfile", async () => {
    mockReadLock.mockReturnValue(emptyLock());
    const result = await svc.uninstall(["ghost-pkg"]);
    expect(result.notFound).toContain("ghost-pkg");
    expect(result.removed).toHaveLength(0);
  });

  it("handles uninstalling multiple packages in one call", async () => {
    mockReadLock.mockReturnValue(lockWith({
      "pkg-a": { version: "1.0.0", type: "pipeline", author: "t", installed_at: "", files: [] },
      "pkg-b": { version: "1.0.0", type: "skill", author: "t", installed_at: "", files: [] },
    }));
    mockFs.existsSync.mockReturnValue(false);

    const result = await svc.uninstall(["pkg-a", "pkg-b", "pkg-c"]);
    expect(result.removed).toEqual(["pkg-a", "pkg-b"]);
    expect(result.notFound).toEqual(["pkg-c"]);
  });
});

// ---------- update() edge cases ----------

describe("update - adversarial scenarios", () => {
  it("throws when updating a specific package that is not installed", async () => {
    mockReadLock.mockReturnValue(emptyLock());
    await expect(svc.update("nonexistent")).rejects.toThrow('Package "nonexistent" is not installed.');
  });

  it("skips package when manifest has unknown type during update", async () => {
    mockReadLock.mockReturnValue(lockWith({
      "weird-pkg": { version: "1.0.0", type: "custom" as any, author: "t", installed_at: "", files: [] },
    }));
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "weird-pkg",
      version: "2.0.0",
      type: "custom" as any,
    }));

    const result = await svc.update("weird-pkg");
    // TYPE_DIR_MAP has no "custom" entry, so typeDir is undefined → continue
    expect(result.updated).toHaveLength(0);
    expect(result.upToDate).toHaveLength(0);
  });

  it("preserves .local/ files during update", async () => {
    mockReadLock.mockReturnValue(lockWith({
      "my-pipe": {
        version: "1.0.0",
        type: "pipeline",
        author: "t",
        installed_at: "",
        files: ["config/pipelines/my-pipe/pipeline.yaml", "config/pipelines/my-pipe/.local/custom.yaml"],
      },
    }));
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "my-pipe",
      version: "2.0.0",
      type: "pipeline",
    }));
    mockFs.existsSync.mockReturnValue(true);
    mockFs.rmSync.mockImplementation(() => {});
    mockDownloadPackageFiles.mockResolvedValue(["/fake/config/pipelines/my-pipe/pipeline.yaml"]);

    await svc.update("my-pipe");

    // .local/ file should NOT be removed
    const rmCalls = mockFs.rmSync.mock.calls.map((c) => String(c[0]));
    const localRemoved = rmCalls.some((p) => p.includes(".local/"));
    expect(localRemoved).toBe(false);
  });
});

// ---------- checkOutdated() ----------

describe("checkOutdated - edge cases", () => {
  it("returns empty when nothing is installed", async () => {
    mockReadLock.mockReturnValue(emptyLock());
    const result = await svc.checkOutdated();
    expect(result).toEqual([]);
    // Should not even fetch the index
    expect(mockFetchIndex).not.toHaveBeenCalled();
  });

  it("ignores installed packages that no longer exist in remote index", async () => {
    mockReadLock.mockReturnValue(lockWith({
      "removed-pkg": { version: "1.0.0", type: "pipeline", author: "t", installed_at: "", files: [] },
    }));
    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });

    const result = await svc.checkOutdated();
    // remote has no "removed-pkg", so it's not reported as outdated
    expect(result).toHaveLength(0);
  });

  it("correctly identifies outdated package", async () => {
    mockReadLock.mockReturnValue(lockWith({
      "my-pkg": { version: "1.0.0", type: "skill", author: "t", installed_at: "", files: [] },
    }));
    mockFetchIndex.mockResolvedValue({
      version: 1,
      updated_at: "",
      packages: [makePkg({ name: "my-pkg", version: "2.0.0", type: "skill" })],
    });

    const result = await svc.checkOutdated();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "my-pkg",
      installed: "1.0.0",
      latest: "2.0.0",
      type: "skill",
    });
  });
});

// ---------- publish() - error paths ----------

describe("publish - adversarial scenarios", () => {
  it("throws for invalid package type", async () => {
    await expect(svc.publish("my-pkg", "invalid-type")).rejects.toThrow("Invalid package type");
  });

  it("throws when single-file package does not exist on disk", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await expect(svc.publish("missing-skill", "skill")).rejects.toThrow("File not found");
  });

  it("throws when directory package does not exist on disk", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await expect(svc.publish("missing-pipe", "pipeline")).rejects.toThrow("Directory not found");
  });

  it("cleans up temp directory even when publishToGitHub fails", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("content");
    mockFs.readdirSync.mockReturnValue([] as any);
    mockFs.mkdirSync.mockImplementation(() => undefined as any);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.copyFileSync.mockImplementation(() => {});
    mockFs.rmSync.mockImplementation(() => {});
    mockFs.rmdirSync.mockImplementation(() => {});

    vi.mocked(publishToGitHub).mockRejectedValue(new Error("GitHub auth failed"));

    await expect(svc.publish("my-skill", "skill")).rejects.toThrow("GitHub auth failed");

    // Verify rmSync was called for cleanup in finally block
    expect(mockFs.rmSync).toHaveBeenCalled();
  });
});

// ---------- listInstalled() ----------

describe("listInstalled - type filtering", () => {
  it("returns all packages when no type filter", () => {
    mockReadLock.mockReturnValue(lockWith({
      "a": { version: "1.0.0", type: "pipeline", author: "t", installed_at: "", files: [] },
      "b": { version: "1.0.0", type: "skill", author: "t", installed_at: "", files: [] },
    }));

    const result = svc.listInstalled();
    expect(Object.keys(result)).toHaveLength(2);
  });

  it("filters by type correctly", () => {
    mockReadLock.mockReturnValue(lockWith({
      "a": { version: "1.0.0", type: "pipeline", author: "t", installed_at: "", files: [] },
      "b": { version: "1.0.0", type: "skill", author: "t", installed_at: "", files: [] },
    }));

    const result = svc.listInstalled("skill");
    expect(Object.keys(result)).toEqual(["b"]);
  });

  it("returns empty object when type matches nothing", () => {
    mockReadLock.mockReturnValue(lockWith({
      "a": { version: "1.0.0", type: "pipeline", author: "t", installed_at: "", files: [] },
    }));

    const result = svc.listInstalled("fragment");
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ---------- listInstalled - disk merge ----------

describe("listInstalled - merges disk-present pipelines", () => {
  it("includes pipelines from disk not in lock file", async () => {
    mockReadLock.mockReturnValue(lockWith({
      "from-lock": { version: "1.0.0", type: "pipeline", author: "t", installed_at: "", files: [] },
    }));
    const existsMap: Record<string, boolean> = {
      "/fake/config/pipelines": true,
      "/fake/config/pipelines/from-lock/pipeline.yaml": true,
      "/fake/config/pipelines/from-disk/pipeline.yaml": true,
    };
    mockFs.existsSync.mockImplementation(((p: any) => existsMap[String(p)] ?? false) as any);
    mockFs.readdirSync.mockImplementation((() => [
      { name: "from-lock", isDirectory: () => true },
      { name: "from-disk", isDirectory: () => true },
      { name: ".trash", isDirectory: () => true },
    ]) as any);
    mockFs.readFileSync.mockImplementation((() => JSON.stringify({ name: "From Disk", official: true })) as any);
    mockFs.statSync.mockImplementation((() => ({ mtime: new Date("2026-01-01") })) as any);

    const result = svc.listInstalled();
    expect(Object.keys(result)).toContain("from-lock");
    expect(Object.keys(result)).toContain("from-disk");
    expect(result["from-disk"].version).toBe("builtin");
    expect(result["from-disk"].author).toBe("workflow-control");
    expect(Object.keys(result)).not.toContain(".trash");
    expect(result["from-lock"].version).toBe("1.0.0");
  });

  it("marks non-official disk pipelines as local", () => {
    mockReadLock.mockReturnValue(lockWith({}));
    mockFs.existsSync.mockImplementation((() => true) as any);
    mockFs.readdirSync.mockImplementation((() => [
      { name: "my-pipeline", isDirectory: () => true },
    ]) as any);
    mockFs.readFileSync.mockImplementation((() => JSON.stringify({ name: "My Pipeline" })) as any);
    mockFs.statSync.mockImplementation((() => ({ mtime: new Date() })) as any);

    const result = svc.listInstalled();
    expect(result["my-pipeline"].version).toBe("local");
    expect(result["my-pipeline"].author).toBe("local");
    expect(result["my-pipeline"].type).toBe("pipeline");
  });

  it("skips directories without pipeline.yaml", () => {
    mockReadLock.mockReturnValue(lockWith({}));
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith("/pipelines")) return true;
      if (s.includes("no-yaml") && s.endsWith("pipeline.yaml")) return false;
      return false;
    });
    mockFs.readdirSync.mockReturnValue([
      { name: "no-yaml", isDirectory: () => true },
    ] as any);

    const result = svc.listInstalled();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("skips .local directories", () => {
    mockReadLock.mockReturnValue(lockWith({}));
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([
      { name: "my-pipe.local", isDirectory: () => true },
    ] as any);

    const result = svc.listInstalled();
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ---------- MCP install adversarial ----------

describe("MCP install - adversarial scenarios", () => {
  const mcpManifest = (name: string, env?: Record<string, any>) => makeManifest({
    name,
    type: "mcp",
    files: [],
    mcp_entry: {
      description: `${name} MCP`,
      command: "npx",
      args: ["-y", `@test/${name}-mcp`],
      ...(env ? { env } : {}),
    },
  });

  it("preserves existing user env when updating an already-installed MCP", async () => {
    // registry.yaml already has notion with user's custom token
    const existingRegistry = JSON.stringify({
      notion: {
        description: "Old description",
        command: "old-npx",
        env: { NOTION_TOKEN: "user-custom-token" },
      },
    });

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(existingRegistry);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "notion",
      type: "mcp",
      version: "2.0.0",
      files: [],
      mcp_entry: {
        description: "New description",
        command: "new-npx",
        args: ["new-args"],
        env: { NOTION_TOKEN: "${NOTION_TOKEN}" },
      },
    }));
    mockReadLock.mockReturnValue(lockWith({
      notion: { version: "1.0.0", type: "mcp", author: "t", installed_at: "", files: [] },
    }));

    await svc.update("notion");

    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (c) => (c[0] as string).includes("registry.yaml"),
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall![1] as string);
    // User's env should be preserved, command/description updated
    expect(written.notion.env).toEqual({ NOTION_TOKEN: "user-custom-token" });
    expect(written.notion.description).toBe("New description");
    expect(written.notion.command).toBe("new-npx");
  });

  it("skips MCP install when entry exists in registry.yaml but not in lock (no force)", async () => {
    const existingRegistry = JSON.stringify({ notion: { command: "npx" } });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(existingRegistry);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(mcpManifest("notion"));
    mockReadLock.mockReturnValue(emptyLock()); // not in lock

    // force=false is default, but the package is explicitly requested
    // so forceThis = true (requestedNames.has("notion"))
    // This means it will overwrite — this is intentional behavior
    const result = await svc.install(["notion"], { force: false });
    expect(result.installed.some((i) => i.name === "notion")).toBe(true);

    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
  });

  it("handles MCP with no env (no mcpSetupNeeded)", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(mcpManifest("context7")); // no env
    mockReadLock.mockReturnValue(emptyLock());

    const result = await svc.install(["context7"]);
    expect(result.mcpSetupNeeded).toHaveLength(0);

    mockFs.existsSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
  });

  it("detects multiple missing env vars from nested json env", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    const manifest = makeManifest({
      name: "complex-mcp",
      type: "mcp",
      files: [],
      mcp_entry: {
        command: "npx",
        env: {
          SIMPLE_VAR: "${MISSING_VAR_A}",
          COMPLEX_VAR: { json: { key1: "${MISSING_VAR_B}", key2: "${MISSING_VAR_C}" } } as any,
        },
      },
    });

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(manifest);
    mockReadLock.mockReturnValue(emptyLock());

    delete process.env.MISSING_VAR_A;
    delete process.env.MISSING_VAR_B;
    delete process.env.MISSING_VAR_C;

    const result = await svc.install(["complex-mcp"]);
    expect(result.mcpSetupNeeded).toHaveLength(1);
    expect(result.mcpSetupNeeded[0].envVars).toContain("MISSING_VAR_A");
    expect(result.mcpSetupNeeded[0].envVars).toContain("MISSING_VAR_B");
    expect(result.mcpSetupNeeded[0].envVars).toContain("MISSING_VAR_C");

    mockFs.existsSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
  });
});

// ---------- MCP uninstall adversarial ----------

describe("MCP uninstall - adversarial scenarios", () => {
  it("handles uninstalling MCP when registry.yaml does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockReadLock.mockReturnValue(lockWith({
      notion: { version: "1.0.0", type: "mcp", author: "t", installed_at: "", files: [] },
    }));

    const result = await svc.uninstall(["notion"]);
    expect(result.removed).toContain("notion");
    // Should still write an empty registry.yaml
    expect(mockFs.writeFileSync).toHaveBeenCalled();

    mockFs.existsSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
  });

  it("handles uninstalling MCP that is not in registry.yaml (but is in lock)", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ context7: { command: "npx" } }));
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockReadLock.mockReturnValue(lockWith({
      notion: { version: "1.0.0", type: "mcp", author: "t", installed_at: "", files: [] },
    }));

    // notion is in lock but not in registry.yaml — should still succeed
    const result = await svc.uninstall(["notion"]);
    expect(result.removed).toContain("notion");
    // registry.yaml should be written without changes to context7
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (c) => (c[0] as string).includes("registry.yaml"),
    );
    const written = JSON.parse(writeCall![1] as string);
    expect(written.context7).toBeDefined();

    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
  });
});

// ---------- MCP publish adversarial ----------

describe("MCP publish - adversarial scenarios", () => {
  it("throws when MCP name is not in registry.yaml", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ context7: { command: "npx" } }));

    await expect(svc.publish("nonexistent", "mcp")).rejects.toThrow('MCP "nonexistent" not found in registry.yaml');

    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
  });

  it("throws when registry.yaml does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await expect(svc.publish("notion", "mcp")).rejects.toThrow('MCP "notion" not found in registry.yaml');

    mockFs.existsSync.mockReset();
  });

  it("publishes MCP with correct manifest structure", async () => {
    mockFs.existsSync.mockImplementation((p) => {
      if ((p as string).includes("registry.yaml")) return true;
      if ((p as string).includes(".publish-tmp")) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      notion: { description: "Notion MCP", command: "npx", args: ["-y", "notion-mcp"] },
    }));
    mockFs.readdirSync.mockReturnValue([] as any);
    mockFs.mkdirSync.mockImplementation(() => undefined as any);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.rmSync.mockImplementation(() => {});
    mockFs.rmdirSync.mockImplementation(() => {});
    vi.mocked(publishToGitHub).mockResolvedValue(undefined as any);

    const result = await svc.publish("notion", "mcp");
    expect(result.success).toBe(true);

    // Verify manifest written to tmp dir
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (c) => (c[0] as string).includes("manifest.yaml"),
    );
    expect(writeCall).toBeDefined();
    const manifest = JSON.parse(writeCall![1] as string);
    expect(manifest.type).toBe("mcp");
    expect(manifest.mcp_entry).toBeDefined();
    expect(manifest.mcp_entry.command).toBe("npx");
    expect(manifest.files).toEqual([]);

    // publishToGitHub called with files: []
    expect(vi.mocked(publishToGitHub)).toHaveBeenCalledWith(
      expect.objectContaining({ files: [] }),
    );

    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.rmSync.mockReset();
    mockFs.mkdirSync.mockReset();
    mockFs.rmdirSync.mockReset();
  });
});

// ---------- MCP update — env merge logic ----------

describe("MCP update - env merge edge cases", () => {
  it("should include new env keys from updated package even when preserving existing values", async () => {
    // v1 had only NOTION_TOKEN. v2 adds NOTION_WORKSPACE_ID.
    // After update, user should see BOTH keys — old value preserved + new key with template.
    const existingRegistry = JSON.stringify({
      notion: {
        description: "Old",
        command: "npx",
        env: { NOTION_TOKEN: "user-secret-token" },
      },
    });

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(existingRegistry);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "notion",
      type: "mcp",
      version: "2.0.0",
      files: [],
      mcp_entry: {
        description: "New",
        command: "new-npx",
        env: {
          NOTION_TOKEN: "${NOTION_TOKEN}",
          NOTION_WORKSPACE_ID: "${NOTION_WORKSPACE_ID}",
        },
      },
    }));
    mockReadLock.mockReturnValue(lockWith({
      notion: { version: "1.0.0", type: "mcp", author: "t", installed_at: "", files: [] },
    }));

    await svc.update("notion");

    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (c) => (c[0] as string).includes("registry.yaml"),
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall![1] as string);
    // Existing value preserved
    expect(written.notion.env.NOTION_TOKEN).toBe("user-secret-token");
    // New key from updated package should be present
    expect(written.notion.env.NOTION_WORKSPACE_ID).toBe("${NOTION_WORKSPACE_ID}");
  });

  it("should remove env keys that were dropped in the updated package", async () => {
    // v1 had LEGACY_KEY + NOTION_TOKEN. v2 only has NOTION_TOKEN.
    // After update, LEGACY_KEY should be gone.
    const existingRegistry = JSON.stringify({
      notion: {
        command: "npx",
        env: { LEGACY_KEY: "old-val", NOTION_TOKEN: "user-token" },
      },
    });

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(existingRegistry);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "notion",
      type: "mcp",
      version: "2.0.0",
      files: [],
      mcp_entry: {
        description: "New",
        command: "new-npx",
        env: { NOTION_TOKEN: "${NOTION_TOKEN}" },
      },
    }));
    mockReadLock.mockReturnValue(lockWith({
      notion: { version: "1.0.0", type: "mcp", author: "t", installed_at: "", files: [] },
    }));

    await svc.update("notion");

    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (c) => (c[0] as string).includes("registry.yaml"),
    );
    const written = JSON.parse(writeCall![1] as string);
    // Preserved value for key still in new version
    expect(written.notion.env.NOTION_TOKEN).toBe("user-token");
    // Dropped key should not be carried over
    expect(written.notion.env.LEGACY_KEY).toBeUndefined();
  });
});

// ---------- MCP install — findMissingEnvVars robustness ----------

describe("MCP install - findMissingEnvVars edge cases", () => {
  it("should not crash when mcp_entry.env contains a null value", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "broken-mcp",
      type: "mcp",
      files: [],
      mcp_entry: {
        command: "npx",
        env: { NULL_KEY: null as any, GOOD_KEY: "${GOOD_KEY}" },
      },
    }));
    mockReadLock.mockReturnValue(emptyLock());

    // Should not throw even if env value is null
    await expect(svc.install(["broken-mcp"])).resolves.toBeDefined();

    mockFs.existsSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
  });

  it("should not crash when mcp_entry.env contains a numeric value", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "num-mcp",
      type: "mcp",
      files: [],
      mcp_entry: {
        command: "npx",
        env: { PORT: 3000 as any },
      },
    }));
    mockReadLock.mockReturnValue(emptyLock());

    await expect(svc.install(["num-mcp"])).resolves.toBeDefined();

    mockFs.existsSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
  });
});

// ---------- MCP install — concurrent / name edge cases ----------

describe("MCP install - name edge cases", () => {
  it("should handle MCP name with path traversal characters", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "../../../etc/passwd",
      type: "mcp",
      files: [],
      mcp_entry: { command: "npx" },
    }));
    mockReadLock.mockReturnValue(emptyLock());

    // Should not crash — name is only used as a YAML key, not a file path
    const result = await svc.install(["../../../etc/passwd"]);
    expect(result.installed).toHaveLength(1);

    // Verify the entry is written as a YAML key, not creating files at traversal path
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (c) => (c[0] as string).includes("registry.yaml"),
    );
    expect(writeCall).toBeDefined();
    // The key should be the raw name string
    const written = JSON.parse(writeCall![1] as string);
    expect(written["../../../etc/passwd"]).toBeDefined();

    mockFs.existsSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
  });

  it("should handle MCP name with special characters", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "mcp-with-$pecial_chars.v2",
      type: "mcp",
      files: [],
      mcp_entry: { command: "npx" },
    }));
    mockReadLock.mockReturnValue(emptyLock());

    await expect(svc.install(["mcp-with-$pecial_chars.v2"])).resolves.toBeDefined();

    mockFs.existsSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
  });

  it("should handle installing same MCP twice in one call (dedup)", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "notion",
      type: "mcp",
      files: [],
      mcp_entry: { command: "npx" },
    }));
    mockReadLock.mockReturnValue(emptyLock());

    // Install same package twice in one call
    const result = await svc.install(["notion", "notion"]);
    // collectDeps deduplicates via Map, so only one install
    const notionInstalls = result.installed.filter((i) => i.name === "notion");
    expect(notionInstalls).toHaveLength(1);

    mockFs.existsSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdirSync.mockReset();
  });
});

// ---------- MCP update — edge cases ----------

describe("MCP update - additional edge cases", () => {
  it("should handle update when new version has no env but old version had env", async () => {
    const existingRegistry = JSON.stringify({
      notion: {
        command: "npx",
        env: { NOTION_TOKEN: "user-token" },
      },
    });

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(existingRegistry);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "notion",
      type: "mcp",
      version: "2.0.0",
      files: [],
      mcp_entry: {
        command: "new-npx",
        // No env at all in new version
      },
    }));
    mockReadLock.mockReturnValue(lockWith({
      notion: { version: "1.0.0", type: "mcp", author: "t", installed_at: "", files: [] },
    }));

    await svc.update("notion");

    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (c) => (c[0] as string).includes("registry.yaml"),
    );
    const written = JSON.parse(writeCall![1] as string);
    // New version has no env — old env should NOT carry over
    expect(written.notion.env).toBeUndefined();
    expect(written.notion.command).toBe("new-npx");
  });

  it("should handle update when old version had no env but new version adds env", async () => {
    const existingRegistry = JSON.stringify({
      context7: { command: "npx" },
    });

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(existingRegistry);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    mockFetchIndex.mockResolvedValue({ version: 1, updated_at: "", packages: [] });
    mockFetchManifest.mockResolvedValue(makeManifest({
      name: "context7",
      type: "mcp",
      version: "2.0.0",
      files: [],
      mcp_entry: {
        command: "new-npx",
        env: { NEW_TOKEN: "${NEW_TOKEN}" },
      },
    }));
    mockReadLock.mockReturnValue(lockWith({
      context7: { version: "1.0.0", type: "mcp", author: "t", installed_at: "", files: [] },
    }));

    await svc.update("context7");

    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (c) => (c[0] as string).includes("registry.yaml"),
    );
    const written = JSON.parse(writeCall![1] as string);
    // New env should be present from the package
    expect(written.context7.env.NEW_TOKEN).toBe("${NEW_TOKEN}");
  });
});

// ---------- MCP listLocalOnly adversarial ----------

describe("MCP listLocalOnly - adversarial scenarios", () => {
  it("detects MCP entries in registry.yaml not tracked by lock", () => {
    mockReadLock.mockReturnValue(lockWith({
      notion: { version: "1.0.0", type: "mcp", author: "t", installed_at: "", files: [] },
    }));
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      notion: { command: "npx" },
      context7: { command: "npx" },
      figma: { command: "npx" },
    }));
    mockFs.readdirSync.mockReturnValue([] as any);

    const result = svc.listLocalOnly();
    // notion is in lock, context7 and figma are not
    const mcpLocal = result.filter((r) => r.type === "mcp");
    expect(mcpLocal.map((r) => r.name).sort()).toEqual(["context7", "figma"]);

    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
    mockFs.readdirSync.mockReset();
  });

  it("handles malformed registry.yaml gracefully", () => {
    mockReadLock.mockReturnValue(emptyLock());
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("not: valid: yaml: [[[");
    mockFs.readdirSync.mockReturnValue([] as any);

    // Should not throw — catch block handles parse errors
    const result = svc.listLocalOnly();
    const mcpLocal = result.filter((r) => r.type === "mcp");
    expect(mcpLocal).toHaveLength(0);

    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
    mockFs.readdirSync.mockReset();
  });

  it("filters by type=mcp in listInstalled", () => {
    mockReadLock.mockReturnValue(lockWith({
      notion: { version: "1.0.0", type: "mcp", author: "t", installed_at: "", files: [] },
      "my-pipe": { version: "1.0.0", type: "pipeline", author: "t", installed_at: "", files: [] },
    }));

    const result = svc.listInstalled("mcp");
    expect(Object.keys(result)).toEqual(["notion"]);
  });
});
