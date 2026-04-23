import { describe, it, expect } from "vitest";
import { irToFlow } from "./ir-to-flow";
import type { PipelineIRLike } from "./ir-to-flow";

describe("irToFlow", () => {
  it("converts a 2-stage linear pipeline", () => {
    const ir: PipelineIRLike = {
      name: "p",
      stages: [
        {
          name: "a", type: "agent",
          inputs: [],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "pa" },
        },
        {
          name: "b", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [],
          config: { promptRef: "pb" },
        },
      ],
      wires: [{
        from: { source: "stage", stage: "a", port: "x" },
        to: { stage: "b", port: "x" },
      }],
      externalInputs: [],
    };
    const { nodes, edges } = irToFlow(ir);
    expect(nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "a", target: "b" });
    expect(edges[0]!.label).toBe("x → x");
  });

  it("adds __external__ synthetic node when external wires exist", () => {
    const ir: PipelineIRLike = {
      name: "p",
      stages: [{
        name: "a", type: "agent",
        inputs: [{ name: "seed", type: "string" }],
        outputs: [],
        config: { promptRef: "p" },
      }],
      wires: [{
        from: { source: "external", port: "seed" },
        to: { stage: "a", port: "seed" },
      }],
      externalInputs: [{ name: "seed", type: "string" }],
    };
    const { nodes, edges } = irToFlow(ir);
    expect(nodes.some((n) => n.id === "__external__")).toBe(true);
    const external = nodes.find((n) => n.id === "__external__")!;
    expect(external.data.stageType).toBe("external");
    expect(edges[0]!.source).toBe("__external__");
    expect(edges[0]!.label).toBe("seed");
  });

  it("does NOT add __external__ node when no external wires exist", () => {
    const ir: PipelineIRLike = {
      name: "p",
      stages: [{
        name: "a", type: "agent", inputs: [], outputs: [],
        config: { promptRef: "p" },
      }],
      wires: [],
      externalInputs: [],
    };
    const { nodes } = irToFlow(ir);
    expect(nodes.some((n) => n.id === "__external__")).toBe(false);
  });

  it("tags gate stage with stageType='gate' and no fanout", () => {
    const ir: PipelineIRLike = {
      name: "p",
      stages: [{
        name: "g", type: "gate",
        inputs: [], outputs: [],
        config: {
          question: { text: "?" },
          routing: { routes: { yes: "g" } },
        },
      }],
      wires: [],
      externalInputs: [],
    };
    const { nodes } = irToFlow(ir);
    expect(nodes[0]!.data.stageType).toBe("gate");
    expect(nodes[0]!.data.fanout).toBe(false);
  });

  it("tags fanout stages with fanout=true + mcpCount + subAgentCount", () => {
    const ir: PipelineIRLike = {
      name: "p",
      stages: [{
        name: "f", type: "agent",
        inputs: [{ name: "items", type: "string[]" }], outputs: [],
        config: {
          promptRef: "p",
          subAgents: [{ name: "s", description: "d", prompt: "p" }],
          mcpServers: [{
            name: "github", command: "npx", args: [],
            envKeys: ["GITHUB_TOKEN"],
          }],
        },
        fanout: { input: "items" },
      }],
      wires: [],
      externalInputs: [{ name: "items", type: "string[]" }],
    };
    const { nodes } = irToFlow(ir);
    expect(nodes[0]!.data.fanout).toBe(true);
    expect(nodes[0]!.data.subAgentCount).toBe(1);
    expect(nodes[0]!.data.mcpCount).toBe(1);
  });

  it("tags script stage with stageType='script' + moduleId", () => {
    const ir: PipelineIRLike = {
      name: "p",
      stages: [{
        name: "s", type: "script",
        inputs: [], outputs: [],
        config: { moduleId: "my-module" },
      }],
      wires: [],
      externalInputs: [],
    };
    const { nodes } = irToFlow(ir);
    expect(nodes[0]!.data.stageType).toBe("script");
    expect(nodes[0]!.data.moduleId).toBe("my-module");
  });

  it("positions nodes via dagre (non-overlapping coordinates for multi-node IR)", () => {
    const ir: PipelineIRLike = {
      name: "p",
      stages: [
        {
          name: "a", type: "agent",
          inputs: [],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "p" },
        },
        {
          name: "b", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [],
          config: { promptRef: "p" },
        },
      ],
      wires: [{
        from: { source: "stage", stage: "a", port: "x" },
        to: { stage: "b", port: "x" },
      }],
      externalInputs: [],
    };
    const { nodes } = irToFlow(ir);
    expect(nodes[0]!.position.x).not.toBe(nodes[1]!.position.x);
    // LR layout puts `a` left of `b`.
    const a = nodes.find((n) => n.id === "a")!;
    const b = nodes.find((n) => n.id === "b")!;
    expect(a.position.x).toBeLessThan(b.position.x);
  });
});
