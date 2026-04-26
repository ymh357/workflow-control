import { describe, it, expect } from "vitest";
import { expandMcpServers } from "./mcp-servers-expander.js";
import type { McpServerDecl } from "../ir/schema.js";

describe("expandMcpServers", () => {
  it("expands ${VAR} using taskEnv then processEnv", () => {
    const decls: McpServerDecl[] = [{
      name: "github",
      command: "npx",
      args: ["-y", "@mcp/server-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
      envKeys: ["GITHUB_TOKEN"],
    }];
    const r = expandMcpServers(decls, { GITHUB_TOKEN: "ghp_x" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.servers;
    expect(out.github).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@mcp/server-github"],
      env: { GITHUB_TOKEN: "ghp_x" },
    });
  });

  it("prefers taskEnv over processEnv", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: [], env: { K: "${X}" }, envKeys: ["X"],
    }];
    const r = expandMcpServers(decls, { X: "task" }, { X: "proc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.servers;
    expect(out.n.env!.K).toBe("task");
  });

  it("falls through to processEnv when taskEnv missing", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: [], env: { K: "${X}" }, envKeys: ["X"],
    }];
    const r = expandMcpServers(decls, {}, { X: "proc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.servers;
    expect(out.n.env!.K).toBe("proc");
  });

  it("returns ok:false with detail on missing variable", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: [], env: { K: "${MISSING}" }, envKeys: ["MISSING"],
    }];
    const r = expandMcpServers(decls, {}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missingKeys.length).toBeGreaterThan(0);
    expect(r.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ server: "n", fieldKey: "env.K", key: "MISSING" }),
      ]),
    );
  });

  it("handles env-less declaration", () => {
    const decls: McpServerDecl[] = [{
      name: "context7", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], envKeys: [],
    }];
    const r = expandMcpServers(decls, {}, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.servers;
    expect(out.context7).toEqual({
      type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"],
    });
    expect(out.context7.env).toBeUndefined();
  });

  it("preserves literal $-free values", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: [], env: { K: "plain-value" }, envKeys: [],
    }];
    const r = expandMcpServers(decls, {}, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.servers;
    expect(out.n.env!.K).toBe("plain-value");
  });

  it("expands ${VAR} inside command and args too", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "${CMD}", args: ["${A}"], envKeys: ["CMD", "A"],
    }];
    const r = expandMcpServers(decls, { CMD: "npx", A: "arg1" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.servers;
    expect(out.n.command).toBe("npx");
    expect(out.n.args).toEqual(["arg1"]);
  });

  it("returns ok:false with fieldKey args[0] when args-level var missing", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: ["${X}"], envKeys: [],
    }];
    const r = expandMcpServers(decls, {}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.details[0]!.fieldKey).toBe("args[0]");
  });

  it("handles multiple servers independently", () => {
    const decls: McpServerDecl[] = [
      { name: "a", command: "c", args: [], env: { K: "${X}" }, envKeys: ["X"] },
      { name: "b", command: "c", args: [], env: { K: "${Y}" }, envKeys: ["Y"] },
    ];
    const r = expandMcpServers(decls, { X: "1", Y: "2" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.servers;
    expect(out.a.env!.K).toBe("1");
    expect(out.b.env!.K).toBe("2");
  });

  it("does not recursively expand taskEnv values (single-pass)", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: [], env: { K: "${A}" }, envKeys: ["A"],
    }];
    const r = expandMcpServers(decls, { A: "${B}", B: "should-not-see" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.servers;
    expect(out.n.env!.K).toBe("${B}");
  });
});

describe("expandMcpServers (batched missing-key enumeration)", () => {
  it("returns ok:true with servers when all variables resolved", () => {
    const decls = [
      { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envKeys: ["GITHUB_TOKEN"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
    ];
    const r = expandMcpServers(decls, { GITHUB_TOKEN: "ghp_x" }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.servers.github!.env!.GITHUB_TOKEN).toBe("ghp_x");
  });

  it("returns ok:false with all missing keys, deduplicated and sorted", () => {
    const decls = [
      { name: "a", command: "npx", args: ["${KEY_B}"], envKeys: ["KEY_B"], env: { X: "${KEY_A}" } },
      { name: "b", command: "npx", args: ["${KEY_A}"], envKeys: ["KEY_A"] },
    ];
    const r = expandMcpServers(decls, {}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missingKeys).toEqual(["KEY_A", "KEY_B"]); // sorted, deduped
    expect(r.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ server: "a", fieldKey: "args[0]", key: "KEY_B" }),
        expect.objectContaining({ server: "a", fieldKey: "env.X", key: "KEY_A" }),
        expect.objectContaining({ server: "b", fieldKey: "args[0]", key: "KEY_A" }),
      ]),
    );
  });

  it("returns ok:false with single key when only one missing", () => {
    const decls = [
      { name: "x", command: "${MISSING}", args: [], envKeys: ["MISSING"] },
    ];
    const r = expandMcpServers(decls, {}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missingKeys).toEqual(["MISSING"]);
  });
});
