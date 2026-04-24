// P2.1 pre-flight unit tests. Covers isMcpRemoteDecl recognition +
// findMissingMcpRemoteAuth scanning. Token-file detection is covered
// indirectly by injecting fixtures into a tmpdir HOME for one test.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isMcpRemoteDecl,
  mcpRemoteUrlHash,
  findMissingMcpRemoteAuth,
  hasCachedMcpRemoteToken,
} from "./mcp-remote-preflight.js";

describe("mcp-remote-preflight / isMcpRemoteDecl", () => {
  it("recognises canonical `npx -y mcp-remote <url>`", () => {
    expect(isMcpRemoteDecl({
      name: "linear",
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      envKeys: [],
    })).toBe("https://mcp.linear.app/mcp");
  });

  it("recognises form without `-y`", () => {
    expect(isMcpRemoteDecl({
      name: "notion",
      command: "npx",
      args: ["mcp-remote", "https://mcp.notion.com/mcp"],
      envKeys: [],
    })).toBe("https://mcp.notion.com/mcp");
  });

  it("returns null for a stdio MCP with its own package", () => {
    expect(isMcpRemoteDecl({
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      envKeys: ["GITHUB_TOKEN"],
    })).toBeNull();
  });

  it("returns null when command is not npx", () => {
    expect(isMcpRemoteDecl({
      name: "linear",
      command: "node",
      args: ["mcp-remote", "https://mcp.linear.app/mcp"],
      envKeys: [],
    })).toBeNull();
  });

  it("returns null when URL argument missing", () => {
    expect(isMcpRemoteDecl({
      name: "x",
      command: "npx",
      args: ["-y", "mcp-remote"],
      envKeys: [],
    })).toBeNull();
  });

  it("returns null when URL arg is not http(s)", () => {
    expect(isMcpRemoteDecl({
      name: "x",
      command: "npx",
      args: ["-y", "mcp-remote", "some-flag"],
      envKeys: [],
    })).toBeNull();
  });
});

describe("mcp-remote-preflight / mcpRemoteUrlHash", () => {
  it("matches the md5(url) scheme used by mcp-remote", () => {
    // Computed via mcp-remote 0.1.37's getServerUrlHash — anchored to
    // guard against the algorithm drifting.
    expect(mcpRemoteUrlHash("https://mcp.linear.app/mcp"))
      .toBe("fcc436b0d1e0a1ed9a2b15bbd638eb13");
  });
});

describe("mcp-remote-preflight / hasCachedMcpRemoteToken", () => {
  const originalHome = process.env.HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mcp-preflight-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns false when ~/.mcp-auth does not exist", () => {
    expect(hasCachedMcpRemoteToken("https://mcp.linear.app/mcp")).toBe(false);
  });

  it("returns false when mcp-remote-<ver> dirs exist but tokens.json missing", () => {
    const dir = join(tmpHome, ".mcp-auth", "mcp-remote-0.1.37");
    mkdirSync(dir, { recursive: true });
    expect(hasCachedMcpRemoteToken("https://mcp.linear.app/mcp")).toBe(false);
  });

  it("returns true when <hash>_tokens.json exists in any mcp-remote-* dir", () => {
    const dir = join(tmpHome, ".mcp-auth", "mcp-remote-0.1.37");
    mkdirSync(dir, { recursive: true });
    const hash = mcpRemoteUrlHash("https://mcp.linear.app/mcp");
    writeFileSync(join(dir, `${hash}_tokens.json`), "{\"access_token\":\"x\"}");
    expect(hasCachedMcpRemoteToken("https://mcp.linear.app/mcp")).toBe(true);
  });

  it("scans multiple mcp-remote-<ver> dirs", () => {
    const dirOld = join(tmpHome, ".mcp-auth", "mcp-remote-0.1.30");
    const dirNew = join(tmpHome, ".mcp-auth", "mcp-remote-0.2.0");
    mkdirSync(dirOld, { recursive: true });
    mkdirSync(dirNew, { recursive: true });
    const hash = mcpRemoteUrlHash("https://mcp.linear.app/mcp");
    writeFileSync(join(dirNew, `${hash}_tokens.json`), "{}");
    expect(hasCachedMcpRemoteToken("https://mcp.linear.app/mcp")).toBe(true);
  });
});

describe("mcp-remote-preflight / findMissingMcpRemoteAuth", () => {
  const originalHome = process.env.HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mcp-preflight-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("flags an OAuth MCP with no cached token", () => {
    const missing = findMissingMcpRemoteAuth([
      {
        name: "fetchTasks",
        type: "agent",
        config: {
          mcpServers: [{
            name: "linear",
            command: "npx",
            args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
            envKeys: [],
          }],
        },
      },
    ]);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      serverName: "linear",
      url: "https://mcp.linear.app/mcp",
      stage: "fetchTasks",
    });
  });

  it("does NOT flag a stdio MCP with its own package", () => {
    const missing = findMissingMcpRemoteAuth([
      {
        name: "fetchIssues",
        type: "agent",
        config: {
          mcpServers: [{
            name: "github",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            envKeys: ["GITHUB_TOKEN"],
          }],
        },
      },
    ]);
    expect(missing).toHaveLength(0);
  });

  it("does NOT flag an OAuth MCP whose token is cached", () => {
    const dir = join(tmpHome, ".mcp-auth", "mcp-remote-0.1.37");
    mkdirSync(dir, { recursive: true });
    const hash = mcpRemoteUrlHash("https://mcp.linear.app/mcp");
    writeFileSync(join(dir, `${hash}_tokens.json`), "{}");
    const missing = findMissingMcpRemoteAuth([
      {
        name: "fetchTasks",
        type: "agent",
        config: {
          mcpServers: [{
            name: "linear",
            command: "npx",
            args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
            envKeys: [],
          }],
        },
      },
    ]);
    expect(missing).toHaveLength(0);
  });

  it("skips gate stages (they have no config.mcpServers)", () => {
    const missing = findMissingMcpRemoteAuth([
      { name: "g", type: "gate", config: {} as unknown },
    ]);
    expect(missing).toHaveLength(0);
  });

  it("skips agent stages that declare no mcpServers", () => {
    const missing = findMissingMcpRemoteAuth([
      { name: "s", type: "agent", config: { mcpServers: [] } },
      { name: "t", type: "agent", config: { mcpServers: undefined } },
      { name: "u", type: "agent", config: {} as unknown },
    ]);
    expect(missing).toHaveLength(0);
  });

  it("aggregates across multiple stages + multiple servers per stage", () => {
    const missing = findMissingMcpRemoteAuth([
      {
        name: "s1",
        type: "agent",
        config: {
          mcpServers: [
            { name: "linear", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], envKeys: [] },
            { name: "notion", command: "npx", args: ["-y", "mcp-remote", "https://mcp.notion.com/mcp"], envKeys: [] },
          ],
        },
      },
      {
        name: "s2",
        type: "agent",
        config: {
          mcpServers: [
            { name: "atlassian", command: "npx", args: ["-y", "mcp-remote", "https://mcp.atlassian.com/mcp"], envKeys: [] },
          ],
        },
      },
    ]);
    expect(missing).toHaveLength(3);
    expect(missing.map((m) => m.serverName).sort()).toEqual(["atlassian", "linear", "notion"]);
  });
});
