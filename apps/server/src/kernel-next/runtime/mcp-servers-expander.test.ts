import { describe, it, expect } from "vitest";
import { expandMcpServers, McpEnvExpansionError } from "./mcp-servers-expander.js";
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
    const out = expandMcpServers(decls, { GITHUB_TOKEN: "ghp_x" }, {});
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
    const out = expandMcpServers(decls, { X: "task" }, { X: "proc" });
    expect(out.n.env!.K).toBe("task");
  });

  it("falls through to processEnv when taskEnv missing", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: [], env: { K: "${X}" }, envKeys: ["X"],
    }];
    const out = expandMcpServers(decls, {}, { X: "proc" });
    expect(out.n.env!.K).toBe("proc");
  });

  it("throws McpEnvExpansionError on missing variable", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: [], env: { K: "${MISSING}" }, envKeys: ["MISSING"],
    }];
    expect(() => expandMcpServers(decls, {}, {})).toThrow(McpEnvExpansionError);
    try {
      expandMcpServers(decls, {}, {});
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof McpEnvExpansionError)) throw e;
      expect(e.server).toBe("n");
      expect(e.fieldKey).toBe("env.K");
      expect(e.variable).toBe("MISSING");
    }
  });

  it("handles env-less declaration", () => {
    const decls: McpServerDecl[] = [{
      name: "context7", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], envKeys: [],
    }];
    const out = expandMcpServers(decls, {}, {});
    expect(out.context7).toEqual({
      type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"],
    });
    expect(out.context7.env).toBeUndefined();
  });

  it("preserves literal $-free values", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: [], env: { K: "plain-value" }, envKeys: [],
    }];
    const out = expandMcpServers(decls, {}, {});
    expect(out.n.env!.K).toBe("plain-value");
  });

  it("expands ${VAR} inside command and args too", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "${CMD}", args: ["${A}"], envKeys: ["CMD", "A"],
    }];
    const out = expandMcpServers(decls, { CMD: "npx", A: "arg1" }, {});
    expect(out.n.command).toBe("npx");
    expect(out.n.args).toEqual(["arg1"]);
  });

  it("throws with fieldKey args[0] when args-level var missing", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: ["${X}"], envKeys: [],
    }];
    try {
      expandMcpServers(decls, {}, {});
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof McpEnvExpansionError)) throw e;
      expect(e.fieldKey).toBe("args[0]");
    }
  });

  it("handles multiple servers independently", () => {
    const decls: McpServerDecl[] = [
      { name: "a", command: "c", args: [], env: { K: "${X}" }, envKeys: ["X"] },
      { name: "b", command: "c", args: [], env: { K: "${Y}" }, envKeys: ["Y"] },
    ];
    const out = expandMcpServers(decls, { X: "1", Y: "2" }, {});
    expect(out.a.env!.K).toBe("1");
    expect(out.b.env!.K).toBe("2");
  });

  it("does not recursively expand taskEnv values (single-pass)", () => {
    const decls: McpServerDecl[] = [{
      name: "n", command: "c", args: [], env: { K: "${A}" }, envKeys: ["A"],
    }];
    const out = expandMcpServers(decls, { A: "${B}", B: "should-not-see" }, {});
    expect(out.n.env!.K).toBe("${B}");
  });
});
