import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import StageCard from "./stage-card";
import type { Stage } from "./stage-card";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      agent: "Agent",
      gate: "Gate",
      script: "Script",
      condition: "Condition",
      pipelineCall: "Pipeline",
      foreach: "Foreach",
      readsLabel: "reads:",
      writesLabel: "writes:",
      noDataFlow: "no data flow",
      branches: "branches",
      approvalGate: "approval gate",
      moveUp: "Move up",
      moveDown: "Move down",
      removeStage: "Remove stage",
    };
    return map[key] ?? key;
  },
}));

const noop = () => {};
const defaultProps = {
  index: 0,
  isSelected: false,
  issues: [],
  onSelect: noop,
  onMoveUp: noop,
  onMoveDown: noop,
  onRemove: noop,
  isFirst: true,
  isLast: true,
};

function makeStage(overrides: Partial<Stage> & { name: string; type: Stage["type"] }): Stage {
  return { ...overrides } as Stage;
}

describe("StageCard", () => {
  describe("agent type", () => {
    it("shows writes data flow", () => {
      const stage = makeStage({
        name: "analyze",
        type: "agent",
        runtime: { engine: "llm" as any, writes: ["analysis", "summary"] },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("writes:")).toBeInTheDocument();
      expect(screen.getByText("analysis, summary")).toBeInTheDocument();
    });

    it("shows reads data flow", () => {
      const stage = makeStage({
        name: "implement",
        type: "agent",
        runtime: { engine: "llm" as any, reads: { plan: "analysis.plan" }, writes: [] },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("reads:")).toBeInTheDocument();
      expect(screen.getByText("analysis.plan")).toBeInTheDocument();
    });

    it("shows 'no data flow' when no reads/writes", () => {
      const stage = makeStage({
        name: "bare",
        type: "agent",
        runtime: { engine: "llm" as any },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("no data flow")).toBeInTheDocument();
    });
  });

  describe("condition type", () => {
    it("renders branch routing list", () => {
      const stage = makeStage({
        name: "router",
        type: "condition",
        runtime: {
          engine: "condition" as any,
          branches: [
            { when: "score > 80", to: "pass" },
            { default: true, to: "fail" },
          ],
        },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("score > 80")).toBeInTheDocument();
      expect(screen.getByText("pass")).toBeInTheDocument();
      expect(screen.getByText("default")).toBeInTheDocument();
      expect(screen.getByText("fail")).toBeInTheDocument();
    });

    it("truncates long when expressions at 18 chars", () => {
      const stage = makeStage({
        name: "router",
        type: "condition",
        runtime: {
          engine: "condition" as any,
          branches: [
            { when: "store.analysis.risk_level == 'critical'", to: "alert" },
            { default: true, to: "skip" },
          ],
        },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      // "store.analysis.risk_level == 'critical'" truncated at 18 → "store.analysis.ris..."
      expect(screen.getByText("store.analysis.ris...")).toBeInTheDocument();
      expect(screen.getByText("alert")).toBeInTheDocument();
    });

    it("shows '0 branches' when no branches defined", () => {
      const stage = makeStage({
        name: "empty-cond",
        type: "condition",
        runtime: { engine: "condition" as any },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("0 branches")).toBeInTheDocument();
    });
  });

  describe("human_confirm type", () => {
    it("shows reject target", () => {
      const stage = makeStage({
        name: "gate",
        type: "human_confirm",
        runtime: { engine: "human_gate" as any, on_reject_to: "analyze" },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("analyze")).toBeInTheDocument();
    });

    it("shows 'error' as default reject target", () => {
      const stage = makeStage({
        name: "gate",
        type: "human_confirm",
        runtime: { engine: "human_gate" as any },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("error")).toBeInTheDocument();
    });

    it("shows max feedback loops when configured", () => {
      const stage = makeStage({
        name: "gate",
        type: "human_confirm",
        runtime: { engine: "human_gate" as any, on_reject_to: "prev", max_feedback_loops: 5 },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("max 5 feedback loops")).toBeInTheDocument();
    });
  });

  describe("pipeline type", () => {
    it("shows sub-pipeline name", () => {
      const stage = makeStage({
        name: "call-sub",
        type: "pipeline",
        runtime: { engine: "pipeline" as any, pipeline_name: "code-review" },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("code-review")).toBeInTheDocument();
    });

    it("shows reads when present", () => {
      const stage = makeStage({
        name: "call-sub",
        type: "pipeline",
        runtime: { engine: "pipeline" as any, pipeline_name: "sub", reads: { src: "analysis.data" } },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("sub")).toBeInTheDocument();
      expect(screen.getByText(/reads:.*analysis\.data/)).toBeInTheDocument();
    });
  });

  describe("foreach type", () => {
    it("shows items and pipeline name", () => {
      const stage = makeStage({
        name: "batch",
        type: "foreach",
        runtime: {
          engine: "foreach" as any,
          items: "store.files",
          pipeline_name: "review-pipe",
        },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("store.files")).toBeInTheDocument();
      expect(screen.getByText("review-pipe")).toBeInTheDocument();
    });

    it("shows concurrency and error mode", () => {
      const stage = makeStage({
        name: "batch",
        type: "foreach",
        runtime: {
          engine: "foreach" as any,
          items: "store.list",
          pipeline_name: "proc",
          max_concurrency: 3,
          on_item_error: "continue",
        },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText("x3")).toBeInTheDocument();
      expect(screen.getByText("[continue]")).toBeInTheDocument();
    });

    it("shows collect_to target", () => {
      const stage = makeStage({
        name: "batch",
        type: "foreach",
        runtime: {
          engine: "foreach" as any,
          items: "store.list",
          pipeline_name: "proc",
          collect_to: "results",
        },
      });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText(/results/)).toBeInTheDocument();
    });
  });

  describe("type badge", () => {
    it.each([
      ["agent", "Agent"],
      ["script", "Script"],
      ["human_confirm", "Gate"],
      ["condition", "Condition"],
      ["pipeline", "Pipeline"],
      ["foreach", "Foreach"],
    ] as const)("renders correct badge for %s", (type, label) => {
      const stage = makeStage({ name: "test", type, runtime: { engine: "llm" as any } });
      render(<StageCard {...defaultProps} stage={stage} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });
});
