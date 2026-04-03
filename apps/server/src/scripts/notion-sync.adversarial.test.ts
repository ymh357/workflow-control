import { describe, it, expect, vi, beforeEach } from "vitest";

const mockScriptRegistration = vi.fn();

vi.mock("../lib/scripts.js", () => ({
  scriptRegistration: (...args: any[]) => mockScriptRegistration(...args),
}));

import { notionSyncScript } from "./notion-sync.js";

function makeParams(overrides: Record<string, any> = {}) {
  return {
    taskId: "task-10",
    context: {
      branch: "feature/task-10-x",
      worktreePath: "/tmp/wt",
      store: {},
      ...overrides.context,
    } as any,
    settings: { notion: { sprint_board_id: "db-1" } } as any,
    inputs: overrides.inputs,
    args: overrides.args,
  };
}

describe("notionSyncScript – adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScriptRegistration.mockResolvedValue({ notionPageId: "page-abc" });
  });

  it("passes undefined worktreePath when context has no worktreePath", async () => {
    const params = makeParams();
    delete params.context.worktreePath;
    await notionSyncScript.handler(params);

    expect(mockScriptRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: undefined }),
    );
  });

  it("propagates rejection from scriptRegistration", async () => {
    mockScriptRegistration.mockRejectedValue(new Error("Notion API 401"));
    await expect(notionSyncScript.handler(makeParams())).rejects.toThrow("Notion API 401");
  });

  it("handles null inputs gracefully (defaults analysis to {})", async () => {
    const params = makeParams();
    params.inputs = null as any;
    await notionSyncScript.handler(params);

    expect(mockScriptRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ analysis: {} }),
    );
  });

  it("passes empty settings object without crashing", async () => {
    const params = makeParams();
    params.settings = {} as any;
    await notionSyncScript.handler(params);

    expect(mockScriptRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ settings: {} }),
    );
  });

  it("passes args with extra unexpected keys through to notionStatusLabel", async () => {
    await notionSyncScript.handler(
      makeParams({ args: { notion_status_label: "Done", extra: "ignored" } }),
    );

    expect(mockScriptRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ notionStatusLabel: "Done" }),
    );
  });

  it("defaults branch to empty string when context.branch is null", async () => {
    await notionSyncScript.handler(
      makeParams({ context: { store: {}, branch: null, worktreePath: "" } }),
    );
    // null ?? "" => "" because null triggers ??
    expect(mockScriptRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "" }),
    );
  });
});
