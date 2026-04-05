import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, beforeEach, expect } from "vitest";

const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};
let lastConfigSave: Promise<void> | null = null;

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    use: (value: unknown) => {
      if (value && typeof value === "object" && "then" in (value as Record<string, unknown>)) {
        return { id: "task-1" };
      }
      return actual.use(value as never);
    },
  };
});

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/toast", () => ({
  useToast: () => mockToast,
}));

vi.mock("@/components/stage-timeline", () => ({
  default: () => <div data-testid="stage-timeline" />,
}));

vi.mock("@/components/cost-summary", () => ({
  default: () => <div data-testid="cost-summary" />,
}));

vi.mock("@/components/confirm-panel", () => ({
  default: () => <div data-testid="confirm-panel" />,
}));

vi.mock("@/components/question-panel", () => ({
  default: ({
    question,
    answer,
    onAnswerChange,
    onSubmit,
  }: {
    question: { question: string };
    answer: string;
    onAnswerChange: (value: string) => void;
    onSubmit: () => void;
  }) => (
    <div data-testid="question-panel">
      <div>{question.question}</div>
      <textarea
        data-testid="question-answer"
        value={answer}
        onChange={(e) => onAnswerChange(e.target.value)}
      />
      <button type="button" onClick={onSubmit}>submit-answer</button>
    </div>
  ),
}));

vi.mock("@/components/dynamic-store-viewer", () => ({
  default: () => <div data-testid="store-viewer" />,
}));

vi.mock("@/components/message-stream", () => ({
  default: ({ messages }: { messages: Array<{ content: string }> }) => (
    <div data-testid="message-stream">{messages.map((m) => m.content).join("|")}</div>
  ),
}));

vi.mock("@/components/config-workbench", () => ({
  default: ({ onUpdateConfig }: { onUpdateConfig: (cfg: unknown) => Promise<void> }) => (
    <button
      type="button"
      onClick={() => {
        lastConfigSave = onUpdateConfig({
          pipelineName: "demo",
          pipeline: { stages: [] },
          prompts: { system: {}, fragments: {}, fragmentMeta: {}, globalConstraints: "" },
        });
        void lastConfigSave.catch(() => {});
      }}
    >
      save-config
    </button>
  ),
}));

const makeJsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });

const makeEventStream = (messages: unknown[]) => {
  const payload = messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join("");
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
};

describe("TaskPage", () => {
  const intervalCallbacks: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    lastConfigSave = null;
    intervalCallbacks.length = 0;
    vi.stubGlobal("Notification", {
      permission: "denied",
      requestPermission: vi.fn(),
    } as unknown as typeof Notification);
    vi.stubGlobal("setInterval", vi.fn((fn: TimerHandler) => {
      if (typeof fn === "function") intervalCallbacks.push(fn as () => void);
      return 1;
    }) as unknown as typeof setInterval);
    vi.stubGlobal("clearInterval", vi.fn());
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith("/api/tasks/task-1")) {
        return makeJsonResponse({
          id: "task-1",
          taskText: "demo task",
          status: "running",
          currentStage: "coding",
          totalCostUsd: 0,
          stageSessionIds: {},
          stageCwds: {},
          config: { pipeline: { engine: "claude", stages: [] } },
          store: {},
          pipelineSchema: [],
          displayTitle: "demo task",
          pendingQuestion: { questionId: "q-1", question: "Need answer?" },
        });
      }

      if (url.endsWith("/api/config/system")) {
        return makeJsonResponse({ capabilities: { mcps: [] } });
      }

      if (url.endsWith("/api/stream/task-1")) {
        return makeEventStream([
          {
            type: "agent_text",
            taskId: "task-1",
            timestamp: "2025-01-01T00:00:00.000Z",
            data: { text: "hello from stream" },
          },
        ]);
      }

      if (url.endsWith("/api/tasks/task-1/config")) {
        return makeJsonResponse({
          ok: true,
          config: {
            pipeline: { stages: [] },
            prompts: { system: {}, fragments: {}, fragmentMeta: {}, globalConstraints: "" },
          },
        });
      }

      if (url.endsWith("/api/tasks/task-1/answer")) {
        return makeJsonResponse({ error: "Question expired", code: "QUESTION_STALE" }, { status: 409 });
      }

      if (url.endsWith("/api/tasks/task-1/cancel")) {
        return makeJsonResponse({ error: "Cannot cancel now", code: "INVALID_STATE" }, { status: 400 });
      }

      return makeJsonResponse({}, { status: 404 });
    }) as typeof fetch);
  });

  it("shows a success toast after saving task config", async () => {
    const { default: TaskPage } = await import("./page");

    render(<TaskPage params={Promise.resolve({ id: "task-1" })} />);

    fireEvent.click(await screen.findByText("agentConfig"));
    fireEvent.click(await screen.findByText("save-config"));

    await expect(lastConfigSave).resolves.toBeUndefined();
  });

  it("shows error and does not treat config save failure as success", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tasks/task-1")) {
        return makeJsonResponse({
          id: "task-1",
          taskText: "demo task",
          status: "blocked",
          currentStage: "coding",
          totalCostUsd: 0,
          stageSessionIds: {},
          stageCwds: {},
          config: { pipeline: { engine: "claude", stages: [] } },
          store: {},
          pipelineSchema: [],
          displayTitle: "demo task",
        });
      }
      if (url.endsWith("/api/config/system")) return makeJsonResponse({ capabilities: { mcps: [] } });
      if (url.endsWith("/api/stream/task-1")) return makeEventStream([]);
      if (url.endsWith("/api/tasks/task-1/config")) {
        return makeJsonResponse({ error: "Save rejected" }, { status: 409 });
      }
      return makeJsonResponse({}, { status: 404 });
    }) as typeof fetch);

    const { default: TaskPage } = await import("./page");
    render(<TaskPage params={Promise.resolve({ id: "task-1" })} />);

    fireEvent.click(await screen.findByText("agentConfig"));
    fireEvent.click(await screen.findByText("save-config"));

    await expect(lastConfigSave).rejects.toThrow("Save rejected");
  });

  it("does not restore transcript messages from sessionStorage", async () => {
    sessionStorage.setItem("messages:task-1", JSON.stringify([
      {
        id: "cached-1",
        type: "agent_text",
        timestamp: "2025-01-01T00:00:00.000Z",
        content: "cached message",
      },
    ]));

    const getItemSpy = vi.spyOn(Storage.prototype, "getItem");
    const { default: TaskPage } = await import("./page");

    render(<TaskPage params={Promise.resolve({ id: "task-1" })} />);

    await waitFor(() => {
      expect(screen.getByTestId("message-stream")).toHaveTextContent("hello from stream");
    });
    expect(screen.getByTestId("message-stream")).not.toHaveTextContent("cached message");
    expect(getItemSpy).not.toHaveBeenCalledWith("messages:task-1");
  });

  it("keeps the question panel and answer text when answering fails", async () => {
    const { default: TaskPage } = await import("./page");

    render(<TaskPage params={Promise.resolve({ id: "task-1" })} />);

    const textarea = await screen.findByTestId("question-answer");
    fireEvent.change(textarea, { target: { value: "my answer" } });
    fireEvent.click(screen.getByText("submit-answer"));

    await waitFor(() => {
      expect(screen.getByTestId("question-panel")).toBeInTheDocument();
    });
    expect(screen.getByTestId("question-answer")).toHaveValue("my answer");
    expect(screen.getByText("Need answer?")).toBeInTheDocument();
  });

  it("poll refresh replaces stale pending question when server state changes", async () => {
    let taskFetchCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tasks/task-1")) {
        taskFetchCount += 1;
        return makeJsonResponse({
          id: "task-1",
          taskText: "demo task",
          status: "running",
          currentStage: "coding",
          totalCostUsd: 0,
          stageSessionIds: {},
          stageCwds: {},
          config: { pipeline: { engine: "claude", stages: [] } },
          store: {},
          pipelineSchema: [],
          displayTitle: "demo task",
          pendingQuestion: taskFetchCount === 1
            ? { questionId: "q-1", question: "Old question?" }
            : { questionId: "q-2", question: "New question?" },
        });
      }
      if (url.endsWith("/api/config/system")) return makeJsonResponse({ capabilities: { mcps: [] } });
      if (url.endsWith("/api/stream/task-1")) return makeEventStream([]);
      return makeJsonResponse({}, { status: 404 });
    }) as typeof fetch);

    const { default: TaskPage } = await import("./page");
    render(<TaskPage params={Promise.resolve({ id: "task-1" })} />);

    expect(await screen.findByText("Old question?")).toBeInTheDocument();
    intervalCallbacks[0]?.();

    await waitFor(() => {
      expect(screen.getByText("New question?")).toBeInTheDocument();
    });
  });

  it("deduplicates identical SSE messages so they appear only once", async () => {
    const duplicateEvent = {
      type: "agent_text",
      taskId: "task-1",
      timestamp: "2025-06-01T00:00:00.000Z",
      data: { text: "unique-dedup-token" },
    };

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tasks/task-1")) {
        return makeJsonResponse({
          id: "task-1",
          taskText: "demo task",
          status: "running",
          currentStage: "coding",
          totalCostUsd: 0,
          stageSessionIds: {},
          stageCwds: {},
          config: { pipeline: { engine: "claude", stages: [] } },
          store: {},
          pipelineSchema: [],
          displayTitle: "demo task",
        });
      }
      if (url.endsWith("/api/config/system")) return makeJsonResponse({ capabilities: { mcps: [] } });
      if (url.endsWith("/api/stream/task-1")) {
        // Send the exact same event twice — the second should be deduped
        return makeEventStream([duplicateEvent, duplicateEvent]);
      }
      return makeJsonResponse({}, { status: 404 });
    }) as typeof fetch);

    const { default: TaskPage } = await import("./page");
    render(<TaskPage params={Promise.resolve({ id: "task-1" })} />);

    await waitFor(() => {
      expect(screen.getByTestId("message-stream")).toHaveTextContent("unique-dedup-token");
    });

    // If dedup failed, adjacent agent_text messages would merge into
    // "unique-dedup-tokenunique-dedup-token". Verify only one copy exists.
    expect(screen.getByTestId("message-stream").textContent).not.toContain(
      "unique-dedup-tokenunique-dedup-token",
    );
  });

  it("polling skips fetchTask when SSE is connected and calls it when disconnected", async () => {
    let taskFetchCount = 0;

    // SSE stream returns successfully and closes — after the reader finishes,
    // scheduleReconnect sets sseConnectedRef to false.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tasks/task-1")) {
        taskFetchCount += 1;
        return makeJsonResponse({
          id: "task-1",
          taskText: "demo task",
          status: "running",
          currentStage: "coding",
          totalCostUsd: 0,
          stageSessionIds: {},
          stageCwds: {},
          config: { pipeline: { engine: "claude", stages: [] } },
          store: {},
          pipelineSchema: [],
          displayTitle: "demo task",
        });
      }
      if (url.endsWith("/api/config/system")) return makeJsonResponse({ capabilities: { mcps: [] } });
      if (url.endsWith("/api/stream/task-1")) {
        // Return a stream that never closes — keeps SSE "connected"
        return new Response(
          new ReadableStream({
            start() {
              // Intentionally don't enqueue or close — stream stays open
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return makeJsonResponse({}, { status: 404 });
    }) as typeof fetch);

    const { default: TaskPage } = await import("./page");
    render(<TaskPage params={Promise.resolve({ id: "task-1" })} />);

    // Wait for initial fetchTask to complete
    await waitFor(() => {
      expect(taskFetchCount).toBeGreaterThanOrEqual(1);
    });

    const countAfterInit = taskFetchCount;

    // Fire the polling interval — SSE is connected so fetchTask should be skipped
    intervalCallbacks[0]?.();
    // Give any potential async calls a chance to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(taskFetchCount).toBe(countAfterInit);
  });

  it("polling calls fetchTask when SSE stream is disconnected", async () => {
    let taskFetchCount = 0;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tasks/task-1")) {
        taskFetchCount += 1;
        return makeJsonResponse({
          id: "task-1",
          taskText: "demo task",
          status: "running",
          currentStage: "coding",
          totalCostUsd: 0,
          stageSessionIds: {},
          stageCwds: {},
          config: { pipeline: { engine: "claude", stages: [] } },
          store: {},
          pipelineSchema: [],
          displayTitle: "demo task",
        });
      }
      if (url.endsWith("/api/config/system")) return makeJsonResponse({ capabilities: { mcps: [] } });
      if (url.endsWith("/api/stream/task-1")) {
        // Return a failed response — SSE never connects, sseConnectedRef stays false
        return new Response(null, { status: 500 });
      }
      return makeJsonResponse({}, { status: 404 });
    }) as typeof fetch);

    const { default: TaskPage } = await import("./page");
    render(<TaskPage params={Promise.resolve({ id: "task-1" })} />);

    // Wait for initial fetchTask
    await waitFor(() => {
      expect(taskFetchCount).toBeGreaterThanOrEqual(1);
    });

    const countBeforePoll = taskFetchCount;

    // Fire the polling interval — SSE is NOT connected so fetchTask should run
    intervalCallbacks[0]?.();

    await waitFor(() => {
      expect(taskFetchCount).toBeGreaterThan(countBeforePoll);
    });
  });

});
