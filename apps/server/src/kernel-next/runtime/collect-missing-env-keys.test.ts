import { describe, it, expect } from "vitest";
import { collectMissingEnvKeys } from "./start-pipeline-run.js";
import type { PipelineIR } from "../ir/schema.js";

function makeIR(stages: PipelineIR["stages"]): PipelineIR {
  return {
    name: "Test Pipeline",
    pipeline_id: "test-pipeline",
    description: "",
    stages,
    wires: [],
    store_schema: [],
  };
}

describe("collectMissingEnvKeys", () => {
  it("returns empty array when no stage has mcpServers", () => {
    const ir = makeIR([
      { type: "agent", name: "s1", inputs: [], outputs: [], config: { promptRef: "p1" } },
    ]);
    expect(collectMissingEnvKeys(ir, undefined, {})).toEqual([]);
  });

  it("returns empty array when all keys satisfied via envValues", () => {
    const ir = makeIR([
      {
        type: "agent", name: "s1", inputs: [], outputs: [],
        config: {
          promptRef: "p1",
          mcpServers: [{ name: "etherscan", command: "npx", args: [], envKeys: ["ETHERSCAN_API_KEY"] }],
        },
      },
    ]);
    expect(collectMissingEnvKeys(ir, { ETHERSCAN_API_KEY: "abc" }, {})).toEqual([]);
  });

  it("returns empty array when all keys satisfied via process.env", () => {
    const ir = makeIR([
      {
        type: "agent", name: "s1", inputs: [], outputs: [],
        config: {
          promptRef: "p1",
          mcpServers: [{ name: "github", command: "npx", args: [], envKeys: ["GITHUB_TOKEN"] }],
        },
      },
    ]);
    expect(collectMissingEnvKeys(ir, undefined, { GITHUB_TOKEN: "tok" })).toEqual([]);
  });

  it("returns missing keys sorted when none are satisfied", () => {
    const ir = makeIR([
      {
        type: "agent", name: "s1", inputs: [], outputs: [],
        config: {
          promptRef: "p1",
          mcpServers: [
            { name: "etherscan", command: "npx", args: [], envKeys: ["ETHERSCAN_API_KEY"] },
            { name: "github", command: "npx", args: [], envKeys: ["GITHUB_TOKEN"] },
          ],
        },
      },
    ]);
    expect(collectMissingEnvKeys(ir, undefined, {})).toEqual(["ETHERSCAN_API_KEY", "GITHUB_TOKEN"]);
  });

  it("deduplicates the same key declared in multiple stages", () => {
    const ir = makeIR([
      {
        type: "agent", name: "s1", inputs: [], outputs: [],
        config: { promptRef: "p1", mcpServers: [{ name: "eth", command: "npx", args: [], envKeys: ["SHARED_KEY"] }] },
      },
      {
        type: "agent", name: "s2", inputs: [], outputs: [],
        config: { promptRef: "p2", mcpServers: [{ name: "eth2", command: "npx", args: [], envKeys: ["SHARED_KEY"] }] },
      },
    ]);
    expect(collectMissingEnvKeys(ir, undefined, {})).toEqual(["SHARED_KEY"]);
  });

  it("ignores script stages (no mcpServers)", () => {
    const ir = makeIR([
      { type: "script", name: "s1", inputs: [], outputs: [], config: { registry: "some_script" } },
    ]);
    expect(collectMissingEnvKeys(ir, undefined, {})).toEqual([]);
  });

  it("envValues takes precedence — key present in envValues but not process.env is not missing", () => {
    const ir = makeIR([
      {
        type: "agent", name: "s1", inputs: [], outputs: [],
        config: { promptRef: "p1", mcpServers: [{ name: "eth", command: "npx", args: [], envKeys: ["API_KEY"] }] },
      },
    ]);
    expect(collectMissingEnvKeys(ir, { API_KEY: "val" }, {})).toEqual([]);
  });
});
