import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import StageTimeline from "./stage-timeline";
import type { PipelineStageEntry } from "@/lib/pipeline-types";

// Mock ResizeObserver (React Flow requirement)
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// Mock @/lib/utils
vi.mock("@/lib/utils", () => ({
  humanizeKey: (key: string) => key.replace(/-/g, " ").replace(/_/g, " "),
  formatDuration: (ms: number) => `${ms}ms`,
}));

// Mock React Flow since it requires DOM APIs not available in jsdom
vi.mock("@/components/flow/pipeline-flow-graph", () => ({
  default: ({ entries, mode, currentStatus, compact, onStageClick }: any) => (
    <div data-testid="mock-flow-graph" data-mode={mode} data-status={currentStatus} data-compact={compact}>
      {entries?.map((e: any) => (
        <div
          key={e.name ?? e.parallel?.name}
          data-testid={`flow-node-${e.name ?? e.parallel?.name}`}
          onClick={() => onStageClick?.(e.name ?? e.parallel?.name)}
        >
          {e.name ?? e.parallel?.name}
        </div>
      ))}
    </div>
  ),
}));

function makeStage(name: string, type: "agent" | "script" | "human_confirm" | "condition" | "pipeline" | "foreach" = "agent"): PipelineStageEntry {
  return { name, type };
}

describe("StageTimeline", () => {
  it("returns null when pipelineStages is empty", () => {
    const { container } = render(
      <StageTimeline currentStatus="idle" stageCosts={{}} pipelineStages={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when pipelineStages is undefined", () => {
    const { container } = render(
      <StageTimeline currentStatus="idle" stageCosts={{}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders container with flow graph when stages provided", () => {
    const stages: PipelineStageEntry[] = [
      makeStage("analyze"),
      makeStage("implement"),
    ];
    render(
      <StageTimeline currentStatus="analyze" stageCosts={{}} pipelineStages={stages} />,
    );
    expect(screen.getByTestId("stage-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("mock-flow-graph")).toBeInTheDocument();
  });

  it("passes compact and runtime mode to flow graph", () => {
    const stages: PipelineStageEntry[] = [makeStage("step")];
    render(
      <StageTimeline currentStatus="step" stageCosts={{}} pipelineStages={stages} />,
    );
    const graph = screen.getByTestId("mock-flow-graph");
    expect(graph.dataset.mode).toBe("runtime");
    expect(graph.dataset.compact).toBe("true");
  });

  it("calls onStageClick when a node is clicked", () => {
    const onStageClick = vi.fn();
    const stages: PipelineStageEntry[] = [makeStage("step-a")];
    render(
      <StageTimeline
        currentStatus="step-a"
        stageCosts={{}}
        pipelineStages={stages}
        onStageClick={onStageClick}
      />,
    );
    screen.getByTestId("flow-node-step-a").click();
    expect(onStageClick).toHaveBeenCalledWith("step-a");
  });
});
