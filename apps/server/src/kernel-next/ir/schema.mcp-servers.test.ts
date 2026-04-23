import { describe, it, expect } from "vitest";
import { AgentStageSchema } from "./schema.js";

describe("AgentStageSchema: mcpServers field", () => {
  it("accepts stage with mcpServers declaration", () => {
    const parsed = AgentStageSchema.parse({
      name: "fetchGitHub",
      type: "agent",
      inputs: [],
      outputs: [{ name: "result", type: "string" }],
      config: {
        promptRef: "p",
        mcpServers: [
          {
            name: "github",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
            envKeys: ["GITHUB_TOKEN"],
          },
        ],
      },
    });
    expect(parsed.config.mcpServers).toHaveLength(1);
    expect(parsed.config.mcpServers![0]!.name).toBe("github");
    expect(parsed.config.mcpServers![0]!.envKeys).toEqual(["GITHUB_TOKEN"]);
  });

  it("rejects mcpServers with duplicate names", () => {
    expect(() =>
      AgentStageSchema.parse({
        name: "s",
        type: "agent",
        inputs: [],
        outputs: [{ name: "o", type: "string" }],
        config: {
          promptRef: "p",
          mcpServers: [
            { name: "github", command: "x", args: [], envKeys: [] },
            { name: "github", command: "y", args: [], envKeys: [] },
          ],
        },
      })
    ).toThrow(/duplicate mcpServer name/i);
  });

  it("accepts stage without mcpServers (backwards compat)", () => {
    const parsed = AgentStageSchema.parse({
      name: "s",
      type: "agent",
      inputs: [],
      outputs: [{ name: "o", type: "string" }],
      config: { promptRef: "p" },
    });
    expect(parsed.config.mcpServers).toBeUndefined();
  });

  it("defaults args and envKeys to empty arrays when omitted", () => {
    const parsed = AgentStageSchema.parse({
      name: "s",
      type: "agent",
      inputs: [],
      outputs: [{ name: "o", type: "string" }],
      config: {
        promptRef: "p",
        mcpServers: [{ name: "context7", command: "npx" }],
      },
    });
    expect(parsed.config.mcpServers![0]!.args).toEqual([]);
    expect(parsed.config.mcpServers![0]!.envKeys).toEqual([]);
  });

  it("rejects invalid server name (starts with digit)", () => {
    expect(() =>
      AgentStageSchema.parse({
        name: "s",
        type: "agent",
        inputs: [],
        outputs: [{ name: "o", type: "string" }],
        config: {
          promptRef: "p",
          mcpServers: [{ name: "1bad", command: "x", args: [], envKeys: [] }],
        },
      })
    ).toThrow();
  });
});
