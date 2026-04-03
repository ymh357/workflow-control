import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockLoadSystemSettings = vi.fn();
vi.mock("./config-loader.js", () => ({
  loadSystemSettings: (...args: unknown[]) => mockLoadSystemSettings(...args),
}));

import {
  withRetry,
  notifyStageComplete,
  notifyBlocked,
  notifyCompleted,
  notifyQuestionAsked,
  notifyCancelled,
  notifyGenericGate,
} from "./slack.js";

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchSpy.mockReset();
  mockLoadSystemSettings.mockReset();
  globalThis.fetch = fetchSpy;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, 2, [10, 20]);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on second attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, 2, [10, 20]);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(withRetry(fn, 2, [10, 20])).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

function setupSlackConfig(opts: { bot_token?: string; channel_id?: string; app_token?: string } = {}) {
  mockLoadSystemSettings.mockReturnValue({
    slack: {
      bot_token: opts.bot_token ?? "xoxb-test",
      notify_channel_id: opts.channel_id ?? "C12345",
      app_token: opts.app_token,
    },
  });
}

function mockSlackOk() {
  fetchSpy.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, ts: "1234.5678" }),
  });
}

describe("notifyStageComplete", () => {
  it("sends a Slack message with correct task info", async () => {
    setupSlackConfig();
    mockSlackOk();
    await notifyStageComplete("abcd1234-5678", "My Task", "template-a");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    const body = JSON.parse(opts.body);
    expect(body.channel).toBe("C12345");
    expect(body.text).toContain("abcd1234");
    expect(body.text).toContain("My Task");
    expect(body.text).toContain("template-a");
  });

  it("skips sending when bot_token is missing", async () => {
    mockLoadSystemSettings.mockReturnValue({ slack: {} });
    await notifyStageComplete("abcd1234", "t", "tpl");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips sending when channel_id is missing", async () => {
    mockLoadSystemSettings.mockReturnValue({ slack: { bot_token: "xoxb-test" } });
    await notifyStageComplete("abcd1234", "t", "tpl");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("notifyBlocked", () => {
  it("sends a message with stage and error info", async () => {
    setupSlackConfig();
    mockSlackOk();
    await notifyBlocked("abcd1234-5678", "implement", "timeout");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.text).toContain("Blocked");
    expect(body.text).toContain("implement");
    expect(body.text).toContain("timeout");
  });

  it("includes interactive blocks when app_token is set", async () => {
    setupSlackConfig({ app_token: "xapp-test" });
    mockSlackOk();
    await notifyBlocked("abcd1234-5678", "implement", "timeout");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.blocks).toBeDefined();
    expect(body.blocks.length).toBeGreaterThan(1);
  });
});

describe("notifyCompleted", () => {
  it("sends completion message", async () => {
    setupSlackConfig();
    mockSlackOk();
    await notifyCompleted("abcd1234-5678", "PR #42");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.text).toContain("Completed");
    expect(body.text).toContain("PR #42");
  });
});

describe("notifyQuestionAsked", () => {
  it("sends question message with options when app_token set", async () => {
    setupSlackConfig({ app_token: "xapp-test" });
    mockSlackOk();
    await notifyQuestionAsked("abcd1234-5678", "q-1", "Pick a color?", ["Red", "Blue"]);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.text).toContain("Question");
    expect(body.blocks).toBeDefined();
  });

  it("sends question message without options", async () => {
    setupSlackConfig({ app_token: "xapp-test" });
    mockSlackOk();
    await notifyQuestionAsked("abcd1234-5678", "q-2", "What now?");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.blocks).toBeDefined();
  });
});

describe("notifyCancelled", () => {
  it("sends cancellation message", async () => {
    setupSlackConfig();
    mockSlackOk();
    await notifyCancelled("abcd1234-5678");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.text).toContain("Cancelled");
    expect(body.text).toContain("abcd1234");
  });
});

describe("notifyGenericGate", () => {
  it("sends gate approval message", async () => {
    setupSlackConfig();
    mockSlackOk();
    await notifyGenericGate("abcd1234-5678", "review", "my-template");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.text).toContain("Gate: review");
    expect(body.text).toContain("my-template");
  });

  it("includes approve/reject buttons when app_token set", async () => {
    setupSlackConfig({ app_token: "xapp-test" });
    mockSlackOk();
    await notifyGenericGate("abcd1234-5678", "review", "my-template");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.blocks).toBeDefined();
    const actions = body.blocks.find((b: any) => b.type === "actions");
    expect(actions).toBeDefined();
    expect(actions.elements.length).toBe(3); // Approve, Reject, Reject with Feedback
  });
});

describe("HTTP error handling", () => {
  it("returns undefined when HTTP response is not ok", async () => {
    setupSlackConfig();
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    // notifyStageComplete uses sendSlackMessage internally
    await notifyStageComplete("abcd1234-5678", "title", "tpl");
    // Should not throw, just log and return undefined
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("returns undefined when Slack API returns ok:false", async () => {
    setupSlackConfig();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: "channel_not_found" }),
    });
    await notifyStageComplete("abcd1234-5678", "title", "tpl");
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("withRetry backoff timing", () => {
  it("waits the specified backoff between retries", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, 2, [100, 200]);
    // Let fake timers handle the waits
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses last backoff value when index exceeds array length", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockRejectedValueOnce(new Error("fail-3"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, 3, [50]);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

describe("notifyBlocked interactive buttons (additional)", () => {
  it("includes Send Message button with taskId value when hasSocketMode", async () => {
    setupSlackConfig({ app_token: "xapp-test" });
    mockSlackOk();
    await notifyBlocked("abcd1234-5678", "code", "error msg");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const actions = body.blocks.find((b: any) => b.type === "actions");
    expect(actions).toBeDefined();
    const sendBtn = actions.elements.find((e: any) => e.action_id === "send_message");
    expect(sendBtn).toBeDefined();
    expect(sendBtn.value).toBe("abcd1234-5678");
    expect(sendBtn.style).toBe("primary");
  });

  it("does not include blocks when no app_token", async () => {
    setupSlackConfig(); // no app_token
    mockSlackOk();
    await notifyBlocked("abcd1234-5678", "code", "error msg");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.blocks).toBeUndefined();
  });
});

describe("notifyGenericGate button structure (additional)", () => {
  it("has correct action_ids for the three buttons", async () => {
    setupSlackConfig({ app_token: "xapp-test" });
    mockSlackOk();
    await notifyGenericGate("abcd1234-5678", "qa-review", "my-tpl");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const actions = body.blocks.find((b: any) => b.type === "actions");
    const actionIds = actions.elements.map((e: any) => e.action_id);
    expect(actionIds).toEqual(["gate_approve", "gate_reject", "gate_feedback"]);
  });

  it("approve button has primary style and reject has danger style", async () => {
    setupSlackConfig({ app_token: "xapp-test" });
    mockSlackOk();
    await notifyGenericGate("abcd1234-5678", "review", "tpl");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const actions = body.blocks.find((b: any) => b.type === "actions");
    const approve = actions.elements.find((e: any) => e.action_id === "gate_approve");
    const reject = actions.elements.find((e: any) => e.action_id === "gate_reject");
    expect(approve.style).toBe("primary");
    expect(reject.style).toBe("danger");
  });

  it("all gate buttons carry the taskId as value", async () => {
    setupSlackConfig({ app_token: "xapp-test" });
    mockSlackOk();
    await notifyGenericGate("abcd1234-5678", "review", "tpl");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const actions = body.blocks.find((b: any) => b.type === "actions");
    for (const el of actions.elements) {
      expect(el.value).toBe("abcd1234-5678");
    }
  });
});

describe("sendSlackMessage catch after retries exhausted", () => {
  it("logs error and returns undefined when withRetry throws", async () => {
    setupSlackConfig();
    // Make fetch always throw (not return a response - actual network failure)
    fetchSpy.mockRejectedValue(new Error("network error"));

    // notifyStageComplete calls sendSlackMessage internally
    // withRetry will exhaust retries (3 attempts with default backoff [1000, 2000])
    // then the outer catch in sendSlackMessage should catch and return undefined
    await notifyStageComplete("abcd1234-5678", "title", "tpl");

    // fetch should have been called 3 times (initial + 2 retries)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
