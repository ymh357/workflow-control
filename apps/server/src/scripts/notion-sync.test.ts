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

describe("notionSyncScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScriptRegistration.mockResolvedValue({ notionPageId: "page-abc" });
  });

  it("has correct metadata id and requiredSettings", () => {
    expect(notionSyncScript.metadata.id).toBe("notion_sync");
    expect(notionSyncScript.metadata.requiredSettings).toContain("notion.sprint_board_id");
  });

  it("passes all expected fields to scriptRegistration", async () => {
    await notionSyncScript.handler(makeParams());

    expect(mockScriptRegistration).toHaveBeenCalledWith({
      taskId: "task-10",
      analysis: {},
      branch: "feature/task-10-x",
      worktreePath: "/tmp/wt",
      notionStatusLabel: undefined,
      settings: { notion: { sprint_board_id: "db-1" } },
    });
  });

  it("uses inputs.analysis when provided", async () => {
    const analysis = { title: "Fix bug" };
    await notionSyncScript.handler(makeParams({ inputs: { analysis } }));

    expect(mockScriptRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ analysis }),
    );
  });

  it("passes notion_status_label from args", async () => {
    await notionSyncScript.handler(makeParams({ args: { notion_status_label: "In Progress" } }));

    expect(mockScriptRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ notionStatusLabel: "In Progress" }),
    );
  });

  it("defaults branch to empty string when missing", async () => {
    const params = makeParams();
    delete params.context.branch;
    await notionSyncScript.handler(params);

    expect(mockScriptRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "" }),
    );
  });

  it("returns the result from scriptRegistration", async () => {
    const result = await notionSyncScript.handler(makeParams());
    expect(result).toEqual({ notionPageId: "page-abc" });
  });
});
