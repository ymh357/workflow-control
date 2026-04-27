import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
}));

import { createKernelMcp } from "../server.js";
import { initKernelNextSchema } from "../../ir/sql.js";
import { getEntry } from "../../mcp-catalog/catalog-store.js";
import type { ExecFn } from "../../mcp-catalog/healthcheck.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTools(mcp: any): Map<string, { name: string; handler: (args: any) => Promise<unknown> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Map((mcp.tools as Array<{ name: string; handler: any }>).map((t) => [t.name, t]));
}

const validEntry = {
  id: "my-custom-tool",
  schemaVersion: "1" as const,
  name: "My Custom Tool",
  description: "A custom MCP server for testing",
  useCases: ["testing"],
  tags: ["custom", "test"],
  command: "npx",
  args: ["-y", "@example/my-mcp"],
  packageName: "@example/my-mcp",
  envKeys: [],
  healthCheckTimeoutMs: 5000,
};

const fakeExecOk: ExecFn = async () => ({ code: 0, stdout: "1.0.0\n", stderr: "", timedOut: false });
const fakeExecNotFound: ExecFn = async () => ({
  code: 1,
  stdout: "",
  stderr: "npm ERR! 404 Not Found",
  timedOut: false,
});

describe("add_mcp_catalog_entry MCP tool", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("creates a new custom entry when healthcheck passes", async () => {
    const mcp = createKernelMcp(db, { surface: "combined", catalogExec: fakeExecOk });
    const tool = getTools(mcp).get("add_mcp_catalog_entry");
    expect(tool).toBeDefined();

    const resp = await tool!.handler({ entry: validEntry });
    const data = JSON.parse((resp as { content: Array<{ text: string }> }).content[0]!.text) as {
      ok: boolean;
      entry?: { id: string; source: string };
    };
    expect(data.ok).toBe(true);
    expect(data.entry?.id).toBe("my-custom-tool");
    expect(data.entry?.source).toBe("custom");

    const persisted = getEntry(db, "my-custom-tool");
    expect(persisted?.name).toBe("My Custom Tool");
  });

  it("rejects when healthcheck reports package not found", async () => {
    const mcp = createKernelMcp(db, { surface: "combined", catalogExec: fakeExecNotFound });
    const tool = getTools(mcp).get("add_mcp_catalog_entry");

    const resp = await tool!.handler({ entry: validEntry });
    const data = JSON.parse((resp as { content: Array<{ text: string }> }).content[0]!.text) as {
      ok: boolean;
      diagnostics?: Array<{ code: string }>;
    };
    expect(data.ok).toBe(false);
    expect(data.diagnostics?.[0]?.code).toBe("MCP_PROVISION_PACKAGE_NOT_FOUND");

    expect(getEntry(db, "my-custom-tool")).toBeNull();
  });

  it("skips healthcheck when skipPackageCheck=true", async () => {
    // No catalogExec injected — would fail real npm view in offline test envs.
    // skipPackageCheck must let us through anyway.
    const mcp = createKernelMcp(db, { surface: "combined" });
    const tool = getTools(mcp).get("add_mcp_catalog_entry");

    const resp = await tool!.handler({ entry: validEntry, skipPackageCheck: true });
    const data = JSON.parse((resp as { content: Array<{ text: string }> }).content[0]!.text) as {
      ok: boolean;
    };
    expect(data.ok).toBe(true);
    expect(getEntry(db, "my-custom-tool")).not.toBeNull();
  });

  it("rejects entries that conflict with builtin id", async () => {
    // Seed a builtin first, mirroring what production seed.ts does at startup.
    db.prepare(`
      INSERT INTO mcp_catalog (id, source, entry_json, updated_at, deprecated_at)
      VALUES (?, 'builtin', ?, ?, NULL)
    `).run("github", JSON.stringify({ ...validEntry, id: "github", source: "builtin" }), Date.now());

    const mcp = createKernelMcp(db, { surface: "combined", catalogExec: fakeExecOk });
    const tool = getTools(mcp).get("add_mcp_catalog_entry");

    const resp = await tool!.handler({
      entry: { ...validEntry, id: "github" },
      skipPackageCheck: true,
    });
    const data = JSON.parse((resp as { content: Array<{ text: string }> }).content[0]!.text) as {
      ok: boolean;
      diagnostics?: Array<{ code: string }>;
    };
    expect(data.ok).toBe(false);
    expect(data.diagnostics?.[0]?.code).toBe("CATALOG_ENTRY_ID_CONFLICT");
  });

  it("rejects malformed entries via zod validation", async () => {
    const mcp = createKernelMcp(db, { surface: "combined", catalogExec: fakeExecOk });
    const tool = getTools(mcp).get("add_mcp_catalog_entry");

    const resp = await tool!.handler({
      entry: { ...validEntry, id: "Bad ID With Spaces" },
      skipPackageCheck: true,
    });
    const data = JSON.parse((resp as { content: Array<{ text: string }> }).content[0]!.text) as {
      ok: boolean;
      diagnostics?: Array<{ code: string }>;
    };
    expect(data.ok).toBe(false);
    expect(data.diagnostics?.[0]?.code).toBe("CATALOG_INVALID_ENTRY");
  });

  it("supports upsert: re-adding a custom entry overwrites", async () => {
    const mcp = createKernelMcp(db, { surface: "combined", catalogExec: fakeExecOk });
    const tool = getTools(mcp).get("add_mcp_catalog_entry");

    await tool!.handler({ entry: validEntry, skipPackageCheck: true });
    await tool!.handler({
      entry: { ...validEntry, name: "My Custom Tool v2" },
      skipPackageCheck: true,
    });

    const persisted = getEntry(db, "my-custom-tool");
    expect(persisted?.name).toBe("My Custom Tool v2");
  });
});
