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
  notifyBlocked,
  notifyQuestionAsked,
  notifyStageComplete,
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

function setupSlackConfig(opts: { bot_token?: string; channel_id?: string; app_token?: string } = {}) {
  mockLoadSystemSettings.mockReturnValue({
    slack: {
      bot_token: opts.bot_token ?? "xoxb-test",
      notify_channel_id: opts.channel_id ?? "C12345",
      app_token: opts.app_token,
    },
  });
}

describe("withRetry adversarial", () => {
  it("with maxRetries=0, calls fn exactly once then throws", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(withRetry(fn, 0, [10])).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("with empty backoff array, uses undefined (NaN) delay but still retries", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");
    // Empty backoff: backoffMs[0] is undefined, backoffMs[backoffMs.length - 1] is also undefined
    // setTimeout(r, undefined) behaves like setTimeout(r, 0)
    const result = await withRetry(fn, 1, []);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates non-Error thrown values", async () => {
    const fn = vi.fn().mockRejectedValue("string error");
    await expect(withRetry(fn, 0, [])).rejects.toBe("string error");
  });
});

describe("sendSlackMessage adversarial (via notify functions)", () => {
  it("calls loadSystemSettings on every invocation (no caching)", async () => {
    setupSlackConfig();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, ts: "1" }),
    });

    await notifyStageComplete("t1", "title", "tpl");
    await notifyStageComplete("t2", "title", "tpl");

    // loadSystemSettings is called in both sendSlackMessage AND hasSocketMode (for notifyBlocked/gate)
    // For notifyStageComplete, it's called once per invocation in sendSlackMessage
    expect(mockLoadSystemSettings.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("handles Slack API returning ok:false with no error field", async () => {
    setupSlackConfig();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false }), // no error field
    });

    // Should not throw
    await notifyStageComplete("t1", "title", "tpl");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("handles fetch returning ok:true but json() throws", async () => {
    setupSlackConfig();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => { throw new Error("JSON parse failed"); },
    });

    // withRetry will retry, all fail, then outer catch handles it
    await notifyStageComplete("t1", "title", "tpl");
    // 3 attempts (initial + 2 retries)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe("notifyQuestionAsked adversarial", () => {
  it("truncates long questions to 200 chars in text field", async () => {
    setupSlackConfig();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, ts: "1" }),
    });

    const longQuestion = "x".repeat(500);
    await notifyQuestionAsked("abcd1234-5678", "q-1", longQuestion);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    // The text uses question.slice(0, 200)
    expect(body.text).not.toContain("x".repeat(201));
  });

  it("truncates option text to 75 chars for Slack button limits", async () => {
    setupSlackConfig({ app_token: "xapp-test" });
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, ts: "1" }),
    });

    const longOption = "o".repeat(100);
    await notifyQuestionAsked("abcd1234-5678", "q-1", "Pick one", [longOption]);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const actions = body.blocks.find((b: any) => b.type === "actions");
    expect(actions.elements[0].text.text.length).toBeLessThanOrEqual(75);
  });

  it("answer button value contains JSON with questionId and question", async () => {
    setupSlackConfig({ app_token: "xapp-test" });
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, ts: "1" }),
    });

    await notifyQuestionAsked("abcd1234-5678", "q-special", "What?");

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const actions = body.blocks.find((b: any) => b.type === "actions");
    const value = JSON.parse(actions.elements[0].value);
    expect(value.questionId).toBe("q-special");
    expect(value.taskId).toBe("abcd1234-5678");
    expect(value.question).toBe("What?");
  });
});

describe("notifyBlocked adversarial", () => {
  it("error message with special characters is HTML-escaped for Slack mrkdwn", async () => {
    setupSlackConfig();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, ts: "1" }),
    });

    const dangerousError = 'Error: "quotes" & <angle> `backtick`';
    await notifyBlocked("abcd1234-5678", "stage", dangerousError);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    // escapeSlackMrkdwn replaces & < > with HTML entities
    expect(body.text).toContain("&amp;");
    expect(body.text).toContain("&lt;angle&gt;");
    expect(body.text).not.toContain(" & ");
    expect(body.text).not.toContain("<angle>");
  });
});

describe("WEB_BASE_URL configuration", () => {
  it("uses WEB_BASE_URL from environment for task links", async () => {
    const original = process.env.WEB_BASE_URL;
    process.env.WEB_BASE_URL = "https://my-app.example.com";

    setupSlackConfig();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, ts: "1" }),
    });

    await notifyStageComplete("abcd1234-5678", "title", "tpl");

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.text).toContain("https://my-app.example.com/task/abcd1234-5678");

    if (original === undefined) delete process.env.WEB_BASE_URL;
    else process.env.WEB_BASE_URL = original;
  });
});
