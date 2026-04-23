import { describe, it, expect } from "vitest";
import { canonicalJSON } from "./canonical.js";
import type { PipelineIR } from "./schema.js";

describe("canonical: mcpServers participate in canonical form", () => {
  const baseIr: PipelineIR = {
    name: "p",
    stages: [{
      name: "s",
      type: "agent",
      inputs: [],
      outputs: [{ name: "o", type: "string" }],
      config: { promptRef: "p" },
    }],
    wires: [],
    externalInputs: [],
  };

  it("produces different canonical JSON when mcpServers differ", () => {
    const a = canonicalJSON(baseIr);
    const withMcp: PipelineIR = {
      ...baseIr,
      stages: [{
        ...baseIr.stages[0]!,
        type: "agent",
        config: {
          promptRef: "p",
          mcpServers: [{ name: "github", command: "npx", args: [], envKeys: ["GH"] }],
        },
      }],
    };
    const b = canonicalJSON(withMcp);
    expect(a).not.toBe(b);
  });

  it("same mcpServers in different server-object key order produce identical canonical JSON", () => {
    const irA: PipelineIR = {
      ...baseIr,
      stages: [{
        ...baseIr.stages[0]!,
        type: "agent",
        config: {
          promptRef: "p",
          mcpServers: [{ name: "x", envKeys: ["A"], args: [], command: "c" }],
        },
      }],
    };
    const irB: PipelineIR = {
      ...baseIr,
      stages: [{
        ...baseIr.stages[0]!,
        type: "agent",
        config: {
          // different key order within server object, same content
          mcpServers: [{ command: "c", name: "x", args: [], envKeys: ["A"] }],
          promptRef: "p",
        },
      }],
    };
    expect(canonicalJSON(irA)).toBe(canonicalJSON(irB));
  });

  it("same mcpServers in different array order produce identical canonical JSON (sort by name)", () => {
    const irA: PipelineIR = {
      ...baseIr,
      stages: [{
        ...baseIr.stages[0]!,
        type: "agent",
        config: {
          promptRef: "p",
          mcpServers: [
            { name: "alpha", command: "c", args: [], envKeys: [] },
            { name: "beta", command: "c", args: [], envKeys: [] },
          ],
        },
      }],
    };
    const irB: PipelineIR = {
      ...baseIr,
      stages: [{
        ...baseIr.stages[0]!,
        type: "agent",
        config: {
          promptRef: "p",
          mcpServers: [
            { name: "beta", command: "c", args: [], envKeys: [] },
            { name: "alpha", command: "c", args: [], envKeys: [] },
          ],
        },
      }],
    };
    expect(canonicalJSON(irA)).toBe(canonicalJSON(irB));
  });

  it("different envKeys order produces identical canonical JSON (envKeys sorted)", () => {
    const irA: PipelineIR = {
      ...baseIr,
      stages: [{
        ...baseIr.stages[0]!,
        type: "agent",
        config: {
          promptRef: "p",
          mcpServers: [{ name: "x", command: "c", args: [], envKeys: ["Z", "A"] }],
        },
      }],
    };
    const irB: PipelineIR = {
      ...baseIr,
      stages: [{
        ...baseIr.stages[0]!,
        type: "agent",
        config: {
          promptRef: "p",
          mcpServers: [{ name: "x", command: "c", args: [], envKeys: ["A", "Z"] }],
        },
      }],
    };
    expect(canonicalJSON(irA)).toBe(canonicalJSON(irB));
  });

  it("args array order is PRESERVED (not sorted — command-line positional)", () => {
    const irA: PipelineIR = {
      ...baseIr,
      stages: [{
        ...baseIr.stages[0]!,
        type: "agent",
        config: {
          promptRef: "p",
          mcpServers: [{ name: "x", command: "c", args: ["--foo", "--bar"], envKeys: [] }],
        },
      }],
    };
    const irB: PipelineIR = {
      ...baseIr,
      stages: [{
        ...baseIr.stages[0]!,
        type: "agent",
        config: {
          promptRef: "p",
          mcpServers: [{ name: "x", command: "c", args: ["--bar", "--foo"], envKeys: [] }],
        },
      }],
    };
    // DIFFERENT — args positional, order matters
    expect(canonicalJSON(irA)).not.toBe(canonicalJSON(irB));
  });
});
