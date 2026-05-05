// Coverage for the dashboard widgets in /kernel-next.
// Focus on the data-derivation parts (stats math + render branching);
// the table itself is exercised end-to-end by other tests.

import { describe, it, expect, vi } from "vitest";
import { render as rawRender, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
// next/link is fine without mock — RTL renders <a> tags.

import { OnboardingCard, DashboardWidget } from "./page";
import { ToastProvider } from "../../components/toast";

const render = (ui: ReactNode) => rawRender(<ToastProvider>{ui}</ToastProvider>);

const baseTask = {
  taskId: "t",
  pipelineName: "p",
  versionHash: "h",
  status: "completed" as const,
  currentStage: null,
  gateId: null,
  gateStage: null,
  startedAt: Date.now(),
  endedAt: null,
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  attemptCount: 1,
};

describe("OnboardingCard", () => {
  it("renders three concrete starting points (smoke-test, /forge, pipeline-generator)", () => {
    render(<OnboardingCard />);
    expect(screen.getByText(/Verify the engine works/i)).toBeInTheDocument();
    // smoke-test name appears multiple times (in description + curl example).
    expect(screen.getAllByText(/smoke-test/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Mine your existing Claude Code work/i)).toBeInTheDocument();
    expect(screen.getByText(/Author a new pipeline/i)).toBeInTheDocument();
    // Forge page link is present.
    const forgeLink = screen.getByRole("link", { name: "/forge" });
    expect(forgeLink).toHaveAttribute("href", "/forge");
  });
});

describe("DashboardWidget", () => {
  it("returns null when no tasks fall in the 7-day window", () => {
    const ancient = { ...baseTask, startedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 };
    const { container } = render(<DashboardWidget tasks={[ancient]} />);
    // Component renders a null body so the wrapping ToastProvider
    // produces no ARIA section. Use the role query to stay specific.
    expect(screen.queryByRole("region", { name: /Last 7 days/i })).not.toBeInTheDocument();
    void container; // silence unused var
  });

  it("shows success rate green when >=90% complete", () => {
    const tasks = [
      { ...baseTask, taskId: "a", status: "completed" as const },
      { ...baseTask, taskId: "b", status: "completed" as const },
      { ...baseTask, taskId: "c", status: "completed" as const },
      { ...baseTask, taskId: "d", status: "completed" as const },
      { ...baseTask, taskId: "e", status: "completed" as const },
      { ...baseTask, taskId: "f", status: "completed" as const },
      { ...baseTask, taskId: "g", status: "completed" as const },
      { ...baseTask, taskId: "h", status: "completed" as const },
      { ...baseTask, taskId: "i", status: "completed" as const },
      { ...baseTask, taskId: "j", status: "failed" as const },
    ];
    render(<DashboardWidget tasks={tasks} />);
    const pct = screen.getByText("90%");
    expect(pct).toBeInTheDocument();
    // Green class — pin to text-success-fg.
    expect(pct.className).toMatch(/text-success-fg/);
  });

  it("shows red when success rate <60%", () => {
    const tasks = [
      { ...baseTask, taskId: "a", status: "completed" as const },
      { ...baseTask, taskId: "b", status: "failed" as const },
      { ...baseTask, taskId: "c", status: "failed" as const },
    ];
    render(<DashboardWidget tasks={tasks} />);
    // 1 / (1+2) = 33%
    const pct = screen.getByText("33%");
    expect(pct.className).toMatch(/text-danger-fg/);
  });

  it("excludes cancelled and still-running tasks from success rate denominator", () => {
    const tasks = [
      { ...baseTask, taskId: "ok", status: "completed" as const },
      { ...baseTask, taskId: "cancel", status: "cancelled" as const },
      { ...baseTask, taskId: "live", status: "running" as const },
    ];
    render(<DashboardWidget tasks={tasks} />);
    // 1 completed / 1 denom (failed=0, cancelled+running excluded) → 100%
    expect(screen.getByText("100%")).toBeInTheDocument();
    // Total counts include all 3.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("hides the success rate panel when there are no completed-or-failed tasks", () => {
    const tasks = [
      { ...baseTask, taskId: "live", status: "running" as const },
      { ...baseTask, taskId: "live2", status: "gated" as const },
    ];
    render(<DashboardWidget tasks={tasks} />);
    // No success rate column shows up.
    expect(screen.queryByText(/Success rate/i)).not.toBeInTheDocument();
    // But the widget itself still renders (Total + live count visible).
    expect(screen.getByText(/Last 7 days/i)).toBeInTheDocument();
  });

  it("ranks top pipelines by completed-task count, descending, capped at 3", () => {
    const tasks: typeof baseTask[] = [];
    // alpha completed 5x
    for (let i = 0; i < 5; i++) {
      tasks.push({ ...baseTask, taskId: `a${i}`, pipelineName: "alpha", status: "completed" });
    }
    // beta completed 3x
    for (let i = 0; i < 3; i++) {
      tasks.push({ ...baseTask, taskId: `b${i}`, pipelineName: "beta", status: "completed" });
    }
    // gamma completed 2x
    tasks.push({ ...baseTask, taskId: "g1", pipelineName: "gamma", status: "completed" });
    tasks.push({ ...baseTask, taskId: "g2", pipelineName: "gamma", status: "completed" });
    // delta completed 1x — should NOT appear (capped at top 3)
    tasks.push({ ...baseTask, taskId: "d1", pipelineName: "delta", status: "completed" });

    render(<DashboardWidget tasks={tasks} />);
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();
    expect(screen.queryByText("delta")).not.toBeInTheDocument();
    expect(screen.getByText("×5")).toBeInTheDocument();
    expect(screen.getByText("×3")).toBeInTheDocument();
  });
});
