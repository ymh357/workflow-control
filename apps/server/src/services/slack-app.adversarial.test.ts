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

async function initApp() {
  mockLoadSystemSettings.mockReturnValue({
    slack: { bot_token: "xoxb-test", app_token: "xapp-test" },
  });
  await initSlackApp();
}

describe("slack-app — adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actionHandlers.clear();
    viewHandlers.clear();
  });

  it("gate_approve with missing action.value defaults to empty string taskId", async () => {
    await initApp();
    mockConfirmGate.mockReturnValue({ ok: false, message: "not found" });

    const args = makeArgs({ action: { value: undefined } });
    await actionHandlers.get("gate_approve")!(args);

    expect(mockConfirmGate).toHaveBeenCalledWith("");
  });

  it("gate_feedback_modal with malformed private_metadata is handled gracefully", async () => {
    await initApp();

    const viewArgs = {
      ack: vi.fn(),
      view: {
        private_metadata: "not valid json",
        state: { values: { feedback_block: { feedback_input: { value: "test" } } } },
      },
      client: { conversations: { history: vi.fn() }, chat: { update: vi.fn() } },
    };

    // After security hardening, malformed JSON is caught and the handler returns gracefully
    await expect(viewHandlers.get("gate_feedback_modal")!(viewArgs)).resolves.not.toThrow();
    expect(viewArgs.ack).toHaveBeenCalled();
  });

  it("answer_option_* with malformed JSON in action.value is handled gracefully", async () => {
    await initApp();

    let optionHandler: Function | undefined;
    for (const [key, handler] of actionHandlers) {
      if (key instanceof RegExp && key.test("answer_option_0")) {
        optionHandler = handler;
        break;
      }
    }

    const args = makeArgs({ action: { value: "not json" } });
    // After security hardening, malformed JSON is caught and the handler returns gracefully
    await expect(optionHandler!(args)).resolves.not.toThrow();
    expect(args.ack).toHaveBeenCalled();
  });

  it("updateMessage handles missing channel gracefully", async () => {
    await initApp();
    mockConfirmGate.mockReturnValue({ ok: true });

    const args = makeArgs({
      body: { channel: null, message: { ts: "1234" } },
    });
    // Should not throw even with null channel
    await actionHandlers.get("gate_approve")!(args);
    expect(args.client.chat.update).not.toHaveBeenCalled();
  });

  it("updateMessage handles missing message.ts gracefully", async () => {
    await initApp();
    mockConfirmGate.mockReturnValue({ ok: true });

    const args = makeArgs({
      body: { channel: { id: "C123" }, message: null },
    });
    await actionHandlers.get("gate_approve")!(args);
    expect(args.client.chat.update).not.toHaveBeenCalled();
  });

  it("send_message_modal with empty message sends empty string to sendMessage", async () => {
    await initApp();
    mockSendMessage.mockResolvedValue({ ok: true });

    const viewArgs = {
      ack: vi.fn(),
      view: {
        private_metadata: JSON.stringify({ taskId: "t1", channel: "C1", messageTs: "123" }),
        state: { values: { message_block: { message_input: { value: null } } } },
      },
      client: {
        conversations: {
          history: vi.fn().mockResolvedValue({
            messages: [{ text: "orig", blocks: [] }],
          }),
        },
        chat: { update: vi.fn() },
      },
    };

    await viewHandlers.get("send_message_modal")!(viewArgs);
    // value is null, so ?? "" gives empty string
    expect(mockSendMessage).toHaveBeenCalledWith("t1", "");
  });

  it("removeButtonsAndAppend handles empty messages array from history", async () => {
    await initApp();
    mockConfirmGate.mockReturnValue({ ok: true });

    const args = makeArgs();
    args.client.conversations.history.mockResolvedValue({ messages: [] });

    await actionHandlers.get("gate_approve")!(args);
    // Should not crash; chat.update should not be called since msg is undefined
    expect(args.client.chat.update).not.toHaveBeenCalled();
  });

  it("conversations.history API error is caught and logged", async () => {
    await initApp();
    mockConfirmGate.mockReturnValue({ ok: true });

    const args = makeArgs();
    args.client.conversations.history.mockRejectedValue(new Error("Slack API error"));

    // Should not throw — error is caught in removeButtonsAndAppend
    await expect(actionHandlers.get("gate_approve")!(args)).resolves.not.toThrow();
  });
});
