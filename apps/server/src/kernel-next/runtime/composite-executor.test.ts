// CompositeStageExecutor: dispatches to per-type delegates.

import { describe, it, expect } from "vitest";
import { CompositeStageExecutor } from "./composite-executor.js";
import type {
  ExecuteStageArgs,
  ExecuteStageResult,
  StageExecutor,
} from "./executor.js";
import type { PipelineIR } from "../ir/schema.js";

class RecordingExecutor implements StageExecutor {
  public calls: string[] = [];
  constructor(private readonly label: string) {}
  async executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
    this.calls.push(`${this.label}:${args.stageName}`);
    return { attemptId: `${this.label}-${args.stageName}`, attemptIdx: 1, status: "success" };
  }
}

function ir(): PipelineIR {
  return {
    name: "mix",
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
      { name: "S", type: "script", inputs: [], outputs: [], config: { source: "registry", moduleId: "m" } },
      {
        name: "G",
        type: "gate",
        inputs: [],
        outputs: [],
        config: {
          question: { text: "?" },
          routing: { routes: { yes: "A" } },
        },
      },
    ],
    wires: [],
  };
}

function args(stageName: string): ExecuteStageArgs {
  return {
    ir: ir(),
    stageName,
    taskId: "t",
    versionHash: "h",
    portValues: {},
    handlers: {},
    // portRuntime is unused by RecordingExecutor — cast through unknown.
    portRuntime: undefined as never,
  };
}

describe("CompositeStageExecutor", () => {
  it("dispatches agent stages to the agent delegate", async () => {
    const agent = new RecordingExecutor("agent");
    const script = new RecordingExecutor("script");
    const comp = new CompositeStageExecutor({ agent, script });

    const r = await comp.executeStage(args("A"));
    expect(r.attemptId).toBe("agent-A");
    expect(agent.calls).toEqual(["agent:A"]);
    expect(script.calls).toEqual([]);
  });

  it("dispatches script stages to the script delegate", async () => {
    const agent = new RecordingExecutor("agent");
    const script = new RecordingExecutor("script");
    const comp = new CompositeStageExecutor({ agent, script });

    const r = await comp.executeStage(args("S"));
    expect(r.attemptId).toBe("script-S");
    expect(script.calls).toEqual(["script:S"]);
    expect(agent.calls).toEqual([]);
  });

  it("throws when no delegate is registered for the stage type", async () => {
    const comp = new CompositeStageExecutor({
      agent: new RecordingExecutor("agent"),
      script: new RecordingExecutor("script"),
      // gate intentionally absent
    });
    await expect(comp.executeStage(args("G"))).rejects.toThrow(
      /no executor registered for stage type 'gate'/,
    );
  });

  it("throws if the stage name is not in the IR", async () => {
    const comp = new CompositeStageExecutor({
      agent: new RecordingExecutor("agent"),
    });
    await expect(comp.executeStage(args("ZZZ"))).rejects.toThrow(
      /'ZZZ' not in IR/,
    );
  });
});
