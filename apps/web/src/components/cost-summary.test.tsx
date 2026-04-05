import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CostSummary from "./cost-summary";
import type { StageCostInfo } from "./stage-timeline";

// Mock next-intl
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Mock @/lib/utils
vi.mock("@/lib/utils", () => ({
  humanizeKey: (key: string) => key.replace(/_/g, " "),
  formatDuration: (ms: number) => `${ms}ms`,
}));

describe("CostSummary", () => {
  describe("basic rendering", () => {
    it("returns null when totalCostUsd is 0 and no stage costs", () => {
      const { container } = render(
        <CostSummary totalCostUsd={0} stageCosts={{}} />
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders cost button with formatted totalCostUsd", () => {
      render(
        <CostSummary totalCostUsd={1.5} stageCosts={{}} />
      );
      expect(screen.getByRole("button")).toHaveTextContent("$1.50");
    });

    it("renders when totalCostUsd is 0 but stageCosts has entries", () => {
      const stageCosts: Record<string, StageCostInfo> = {
        analyze: { costUsd: 0.001, durationMs: 500 },
      };
      render(
        <CostSummary totalCostUsd={0} stageCosts={stageCosts} />
      );
      expect(screen.getByRole("button")).toBeInTheDocument();
    });
  });

  describe("expand/collapse", () => {
    it("shows stage table when button is clicked", () => {
      const stageCosts: Record<string, StageCostInfo> = {
        analyze: { costUsd: 0.005, durationMs: 1000 },
        implement: { costUsd: 0.010, durationMs: 2000 },
      };
      render(
        <CostSummary totalCostUsd={0.015} stageCosts={stageCosts} />
      );

      expect(screen.queryByText("analyze")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button"));

      expect(screen.getByText("analyze")).toBeInTheDocument();
      expect(screen.getByText("implement")).toBeInTheDocument();
    });

    it("hides stage table when button is clicked again", () => {
      const stageCosts: Record<string, StageCostInfo> = {
        analyze: { costUsd: 0.005, durationMs: 1000 },
      };
      render(
        <CostSummary totalCostUsd={0.005} stageCosts={stageCosts} />
      );

      const btn = screen.getByRole("button");
      fireEvent.click(btn);
      expect(screen.getByText("analyze")).toBeInTheDocument();

      fireEvent.click(btn);
      expect(screen.queryByText("analyze")).not.toBeInTheDocument();
    });
  });

  describe("stage costs table", () => {
    it("renders one row per stage entry when expanded", () => {
      const stageCosts: Record<string, StageCostInfo> = {
        stage_a: { costUsd: 0.001, durationMs: 100 },
        stage_b: { costUsd: 0.002, durationMs: 200 },
        stage_c: { costUsd: 0.003, durationMs: 300 },
      };
      render(
        <CostSummary totalCostUsd={0.006} stageCosts={stageCosts} />
      );

      fireEvent.click(screen.getByRole("button"));

      expect(screen.getByText("stage a")).toBeInTheDocument();
      expect(screen.getByText("stage b")).toBeInTheDocument();
      expect(screen.getByText("stage c")).toBeInTheDocument();
    });

    it("displays cost formatted to 3 decimal places per stage", () => {
      const stageCosts: Record<string, StageCostInfo> = {
        analyze: { costUsd: 0.005, durationMs: 500 },
      };
      render(
        <CostSummary totalCostUsd={0.005} stageCosts={stageCosts} />
      );

      fireEvent.click(screen.getByRole("button"));

      expect(screen.getByText("$0.005")).toBeInTheDocument();
    });
  });

  describe("model breakdown", () => {
    it("shows model breakdown toggle when modelBreakdown data exists", () => {
      const stageCosts: Record<string, StageCostInfo> = {
        analyze: {
          costUsd: 0.01,
          durationMs: 1000,
          tokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 150,
            modelBreakdown: [
              {
                modelName: "claude-3-sonnet",
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 0,
                totalTokens: 150,
                costUsd: 0.01,
              },
            ],
          },
        },
      };
      render(
        <CostSummary totalCostUsd={0.01} stageCosts={stageCosts} />
      );

      fireEvent.click(screen.getByRole("button"));

      expect(screen.getByText(/modelBreakdown/)).toBeInTheDocument();
    });
  });
});
