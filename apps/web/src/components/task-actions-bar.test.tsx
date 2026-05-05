// Coverage for the propose-fix integration in TaskActionsBar.
//
// The "Modify pipeline" button:
//  - On a failed/has-failed-stage task, fetches /propose-fix on click
//    and renders one suggestion card per non-info entry.
//  - Clicking a card pre-fills the modificationGoal textarea.
//  - On a healthy task, no fetch fires (no suggestions surface).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rawRender, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

import { TaskActionsBar } from "./task-actions-bar";
import { ToastProvider } from "./toast";

const render = (ui: ReactNode) => rawRender(<ToastProvider>{ui}</ToastProvider>);

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TaskActionsBar — propose-fix integration", () => {
  it("renders suggestion cards on a failed task and pre-fills goal on click", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        ok: true,
        taskId: "t1",
        found: true,
        versionHash: "h",
        suggestions: [
          {
            kind: "error_in_stream",
            targetStage: "persisting",
            severity: "error",
            description: "stage 'persisting' agent stream contained an error marker; review the prompt + tool contract",
            rationale: "agent_execution_details.agent_stream_json showed a `[error]` block at line 14",
          },
          {
            kind: "stuck_open",
            targetStage: "evidenceGather",
            severity: "warn",
            description: "attempt left in 'running' state — likely a missing write_port or premature timeout",
            rationale: "stage_attempts.status='running' more than 30m without heartbeat",
          },
          {
            kind: "interrupted",
            targetStage: "intro",
            severity: "info",
            description: "this stage was interrupted by a downstream failure (transitive)",
            rationale: "supersede provenance points to upstream root cause",
          },
        ],
      }),
    } as unknown as Response);
    // apiFetch wraps the body in { ok, status, data, ... } — we
    // simulate that by returning the JSON envelope directly.

    render(
      <TaskActionsBar
        taskId="t1"
        topState="failed"
        hasFailedStage
        pipelineName="my-pipeline"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /modify pipeline/i }));

    // The fetch call goes out for /propose-fix.
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/kernel/tasks/t1/propose-fix"),
        expect.anything(),
      );
    });

    // Two cards (error + warn) are visible; the info-severity one is filtered out.
    await waitFor(() => {
      expect(screen.getByText(/Suggested modifications/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/agent stream contained an error marker/i)).toBeInTheDocument();
    expect(screen.getByText(/likely a missing write_port/i)).toBeInTheDocument();
    expect(screen.queryByText(/transitive/i)).not.toBeInTheDocument();

    // Click the first suggestion. The textarea should be pre-filled.
    fireEvent.click(screen.getByText(/agent stream contained an error marker/i));
    const textarea = screen.getByLabelText(/modification goal/i) as HTMLTextAreaElement;
    expect(textarea.value).toContain("Fix stage 'persisting'");
    expect(textarea.value).toContain("error marker");
    expect(textarea.value).toContain("Rationale:");
  });

  it("does NOT fetch propose-fix on a healthy (non-failed) task", () => {
    render(
      <TaskActionsBar
        taskId="t-healthy"
        topState="running"
        hasFailedStage={false}
        pipelineName="my-pipeline"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /modify pipeline/i }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("renders gracefully when propose-fix returns no suggestions", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        ok: true,
        taskId: "t2",
        found: true,
        versionHash: null,
        suggestions: [],
      }),
    } as unknown as Response);

    render(
      <TaskActionsBar
        taskId="t2"
        topState="failed"
        hasFailedStage
        pipelineName="my-pipeline"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /modify pipeline/i }));

    // Modal still opens; no suggestions section appears.
    await waitFor(() => {
      expect(screen.getByLabelText(/modification goal/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Suggested modifications/i)).not.toBeInTheDocument();
  });
});
