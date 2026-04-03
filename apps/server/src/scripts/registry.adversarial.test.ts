import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadDynamicScript = vi.fn();

vi.mock("../lib/script-loader.js", () => ({
  loadDynamicScript: (...args: any[]) => mockLoadDynamicScript(...args),
}));

import { scriptRegistry } from "./registry.js";
import type { AutomationScript } from "./types.js";

function makeScript(id: string): AutomationScript {
  return {
    metadata: { id, name: id, description: `desc-${id}`, helpMd: "" },
    handler: vi.fn(async () => ({ ok: true })),
  };
}

describe("ScriptRegistry – adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-registering same id overwrites the previous script", () => {
    const script1 = makeScript("adv_overwrite_1");
    const script2 = makeScript("adv_overwrite_1");
    script2.metadata.description = "replaced";

    scriptRegistry.register(script1);
    scriptRegistry.register(script2);

    expect(scriptRegistry.get("adv_overwrite_1")).toBe(script2);
    expect(scriptRegistry.get("adv_overwrite_1")!.metadata.description).toBe("replaced");
  });

  it("get with empty string returns undefined (not a crash)", () => {
    expect(scriptRegistry.get("")).toBeUndefined();
  });

  it("dynamic wrapper uses process.cwd() when context.worktreePath is falsy", async () => {
    const dynamicFn = vi.fn(async () => ({}));
    mockLoadDynamicScript.mockResolvedValue(dynamicFn);

    const wrapped = await scriptRegistry.getOrLoadDynamic("adv_no_wt");
    await wrapped!.handler({
      taskId: "t1",
      context: { worktreePath: "", store: null } as any,
      settings: {} as any,
      args: {},
      inputs: {},
    });

    expect(dynamicFn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: process.cwd(), store: {} }),
    );
  });

  it("dynamic wrapper merges args and inputs, with inputs overriding args", async () => {
    const dynamicFn = vi.fn(async () => ({}));
    mockLoadDynamicScript.mockResolvedValue(dynamicFn);

    const wrapped = await scriptRegistry.getOrLoadDynamic("adv_merge_args");
    await wrapped!.handler({
      taskId: "t1",
      context: { worktreePath: "/wt", store: {} } as any,
      settings: {} as any,
      args: { shared: "from-args", argsOnly: "a" },
      inputs: { shared: "from-inputs", inputsOnly: "b" },
    });

    expect(dynamicFn).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { shared: "from-inputs", argsOnly: "a", inputsOnly: "b" },
      }),
    );
  });

  it("dynamic wrapper passes undefined args/inputs as empty merged object", async () => {
    const dynamicFn = vi.fn(async () => ({}));
    mockLoadDynamicScript.mockResolvedValue(dynamicFn);

    const wrapped = await scriptRegistry.getOrLoadDynamic("adv_undef_args");
    await wrapped!.handler({
      taskId: "t1",
      context: { worktreePath: "/wt", store: {} } as any,
      settings: {} as any,
    });

    expect(dynamicFn).toHaveBeenCalledWith(
      expect.objectContaining({ args: {} }),
    );
  });

  it("getOrLoadDynamic propagates errors from loadDynamicScript", async () => {
    mockLoadDynamicScript.mockRejectedValue(new Error("load failure"));

    await expect(scriptRegistry.getOrLoadDynamic("adv_error_load")).rejects.toThrow("load failure");
  });

  it("dynamic script metadata uses id for both id and name fields", async () => {
    mockLoadDynamicScript.mockResolvedValue(vi.fn(async () => ({})));

    const wrapped = await scriptRegistry.getOrLoadDynamic("adv_meta_check");
    expect(wrapped!.metadata.id).toBe("adv_meta_check");
    expect(wrapped!.metadata.name).toBe("adv_meta_check");
    expect(wrapped!.metadata.description).toBe("Dynamic script: adv_meta_check");
    expect(wrapped!.metadata.helpMd).toBe("");
  });

  it("getAllMetadata returns objects without handler reference (metadata only)", () => {
    const script = makeScript("adv_meta_only");
    scriptRegistry.register(script);
    const metas = scriptRegistry.getAllMetadata();
    const found = metas.find((m) => m.id === "adv_meta_only");
    expect(found).toBeDefined();
    expect(found).not.toHaveProperty("handler");
  });
});
