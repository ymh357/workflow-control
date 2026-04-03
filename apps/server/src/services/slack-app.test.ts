import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfirmGate = vi.hoisted(() => vi.fn());
const mockRejectGate = vi.hoisted(() => vi.fn());
const mockSendMessage = vi.hoisted(() => vi.fn());
const mockQuestionManager = vi.hoisted(() => ({ answer: vi.fn() }));
const mockLoadSystemSettings = vi.hoisted(() => vi.fn());
const mockStart = vi.hoisted(() => vi.fn());
const mockStop = vi.hoisted(() => vi.fn());

const actionHandlers = vi.hoisted(() => new Map<string | RegExp, Function>());
const viewHandlers = vi.hoisted(() => new Map<string, Function>());

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock("../actions/task-actions.js", () => ({
  confirmGate: (...args: unknown[]) => mockConfirmGate(...args),
  rejectGate: (...args: unknown[]) => mockRejectGate(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));

vi.mock("../lib/question-manager.js", () => ({
  questionManager: mockQuestionManager,
}));

vi.mock("../lib/config-loader.js", () => ({
  loadSystemSettings: () => mockLoadSystemSettings(),
}));

vi.mock("@slack/bolt", () => ({
  App: class {
    action(id: string | RegExp, handler: Function) { actionHandlers.set(id, handler); }
    view(id: string, handler: Function) { viewHandlers.set(id, handler); }
    start() { return mockStart(); }
    stop() { return mockStop(); }
  },
}));

import { initSlackApp, stopSlackApp } from "./slack-app.js";

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    ack: vi.fn(),
    action: { value: "task-1" },
    body: {
      channel: { id: "C123" },
      message: { ts: "1234.5678" },
      trigger_id: "trigger-1",
    },
    client: {
      views: { open: vi.fn() },
      conversations: {
        history: vi.fn().mockResolvedValue({
          messages: [{ text: "original", blocks: [{ type: "section" }, { type: "actions" }] }],
        }),
      },
      chat: { update: vi.fn() },
    },
    ...overrides,
  };
}

describe("slack-app", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actionHandlers.clear();
    viewHandlers.clear();
  });

  it("does not create app when tokens are missing", async () => {
    mockLoadSystemSettings.mockReturnValue({ slack: {} });
    await initSlackApp();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("initializes and starts the app when tokens are present", async () => {
    mockLoadSystemSettings.mockReturnValue({
      slack: { bot_token: "xoxb-test", app_token: "xapp-test" },
    });
    await initSlackApp();
    expect(mockStart).toHaveBeenCalled();
    expect(actionHandlers.size).toBeGreaterThan(0);
  });

  it("gate_approve calls confirmGate and acks", async () => {
    mockLoadSystemSettings.mockReturnValue({
      slack: { bot_token: "xoxb-test", app_token: "xapp-test" },
    });
    await initSlackApp();

    mockConfirmGate.mockReturnValue({ ok: true });
    const args = makeArgs();
    await actionHandlers.get("gate_approve")!(args);

    expect(args.ack).toHaveBeenCalled();
    expect(mockConfirmGate).toHaveBeenCalledWith("task-1");
  });

  it("gate_approve shows failure text when confirmGate fails", async () => {
    mockLoadSystemSettings.mockReturnValue({
      slack: { bot_token: "xoxb-test", app_token: "xapp-test" },
    });
    await initSlackApp();

    mockConfirmGate.mockReturnValue({ ok: false, message: "no gate" });
    const args = makeArgs();
    await actionHandlers.get("gate_approve")!(args);

    expect(args.client.chat.update).toHaveBeenCalled();
    const updateCall = args.client.chat.update.mock.calls[0][0];
    const resultBlock = updateCall.blocks.find((b: any) => b.text?.text?.includes("Approve failed"));
    expect(resultBlock).toBeDefined();
  });

  it("gate_reject calls rejectGate with empty options", async () => {
    mockLoadSystemSettings.mockReturnValue({
      slack: { bot_token: "xoxb-test", app_token: "xapp-test" },
    });
    await initSlackApp();

    mockRejectGate.mockReturnValue({ ok: true });
    const args = makeArgs();
    await actionHandlers.get("gate_reject")!(args);

    expect(args.ack).toHaveBeenCalled();
    expect(mockRejectGate).toHaveBeenCalledWith("task-1", {});
  });

  it("gate_feedback opens a modal with correct callback_id", async () => {
    mockLoadSystemSettings.mockReturnValue({
      slack: { bot_token: "xoxb-test", app_token: "xapp-test" },
    });
    await initSlackApp();

    const args = makeArgs();
    await actionHandlers.get("gate_feedback")!(args);

    expect(args.ack).toHaveBeenCalled();
    expect(args.client.views.open).toHaveBeenCalled();
    const viewArg = args.client.views.open.mock.calls[0][0];
    expect(viewArg.view.callback_id).toBe("gate_feedback_modal");
  });

  it("gate_feedback_modal view submission calls rejectGate with feedback", async () => {
    mockLoadSystemSettings.mockReturnValue({
      slack: { bot_token: "xoxb-test", app_token: "xapp-test" },
    });
    await initSlackApp();

    mockRejectGate.mockReturnValue({ ok: true });
    const viewArgs = {
      ack: vi.fn(),
      view: {
        private_metadata: JSON.stringify({ taskId: "task-1", channel: "C123", messageTs: "1234.5678" }),
        state: { values: { feedback_block: { feedback_input: { value: "fix it" } } } },
      },
      client: {
        conversations: {
          history: vi.fn().mockResolvedValue({
            messages: [{ text: "orig", blocks: [{ type: "section" }] }],
          }),
        },
        chat: { update: vi.fn() },
      },
    };

    await viewHandlers.get("gate_feedback_modal")!(viewArgs);

    expect(viewArgs.ack).toHaveBeenCalled();
    expect(mockRejectGate).toHaveBeenCalledWith("task-1", { feedback: "fix it" });
  });

  it("answer_option_* routes option to questionManager", async () => {
    mockLoadSystemSettings.mockReturnValue({
      slack: { bot_token: "xoxb-test", app_token: "xapp-test" },
    });
    await initSlackApp();

    let optionHandler: Function | undefined;
    for (const [key, handler] of actionHandlers) {
      if (key instanceof RegExp && key.test("answer_option_1")) {
        optionHandler = handler;
        break;
      }
    }
    expect(optionHandler).toBeDefined();

    const args = makeArgs({
      action: { value: JSON.stringify({ questionId: "q-1", taskId: "task-1", option: "yes" }) },
    });
    await optionHandler!(args);

    expect(mockQuestionManager.answer).toHaveBeenCalledWith("q-1", "yes", "task-1");
  });

  it("stopSlackApp stops the app", async () => {
    mockLoadSystemSettings.mockReturnValue({
      slack: { bot_token: "xoxb-test", app_token: "xapp-test" },
    });
    await initSlackApp();
    await stopSlackApp();

    expect(mockStop).toHaveBeenCalled();
  });

  it("stopSlackApp is a no-op when app is null", async () => {
    mockLoadSystemSettings.mockReturnValue({
      slack: { bot_token: "xoxb-test", app_token: "xapp-test" },
    });
    await initSlackApp();
    await stopSlackApp();
    mockStop.mockClear();

    await stopSlackApp();
    expect(mockStop).not.toHaveBeenCalled();
  });
});
