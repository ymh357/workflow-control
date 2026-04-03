import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadDynamicScript = vi.fn();

vi.mock("../lib/script-loader.js", () => ({
  loadDynamicScript: (...args: any[]) => mockLoadDynamicScript(...args),
}));

// Import fresh for each test via dynamic re-import won't work cleanly,
// so we test the exported singleton and reset its state manually.
import { scriptRegistry } from "./registry.js";
import type { AutomationScript } from "./types.js";

function makeScript(id: string): AutomationScript {
  return {
    metadata: { id, name: id, description: `desc-${id}`, helpMd: "" },
    handler: vi.fn(async () => ({ ok: true })),
  };
}

describe("ScriptRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear internal map by re-registering known keys won't work;
    // we rely on unique ids per test instead.
  });

  it("registers and retrieves a script by id", () => {
    const script = makeScript("test_register_1");
    scriptRegistry.register(script);
    expect(scriptRegistry.get("test_register_1")).toBe(script);
  });

  it("returns undefined for unknown id", () => {
    expect(scriptRegistry.get("nonexistent_xyz")).toBeUndefined();
  });

  it("getAllScripts includes registered scripts", () => {
    const script = makeScript("test_all_scripts_1");
    scriptRegistry.register(script);
    const all = scriptRegistry.getAllScripts();
    expect(all.some((s) => s.metadata.id === "test_all_scripts_1")).toBe(true);
  });

  it("getAllMetadata returns metadata array", () => {
    const script = makeScript("test_meta_1");
    scriptRegistry.register(script);
    const metas = scriptRegistry.getAllMetadata();
    expect(metas.some((m) => m.id === "test_meta_1")).toBe(true);
    expect(metas.find((m) => m.id === "test_meta_1")?.description).toBe("desc-test_meta_1");
  });

  it("getOrLoadDynamic returns built-in script without loading", async () => {
    const script = makeScript("test_builtin_1");
    scriptRegistry.register(script);

    const result = await scriptRegistry.getOrLoadDynamic("test_builtin_1");
    expect(result).toBe(script);
    expect(mockLoadDynamicScript).not.toHaveBeenCalled();
  });

  it("getOrLoadDynamic loads dynamic script when not built-in", async () => {
    const dynamicFn = vi.fn(async () => ({ dynamic: true }));
    mockLoadDynamicScript.mockResolvedValue(dynamicFn);

    const result = await scriptRegistry.getOrLoadDynamic("my_dynamic_script");
    expect(result).toBeDefined();
    expect(result!.metadata.id).toBe("my_dynamic_script");
    expect(mockLoadDynamicScript).toHaveBeenCalledWith("my_dynamic_script");
  });

  it("getOrLoadDynamic returns undefined when dynamic script not found", async () => {
    mockLoadDynamicScript.mockResolvedValue(undefined);

    const result = await scriptRegistry.getOrLoadDynamic("missing_dynamic");
    expect(result).toBeUndefined();
  });

  it("dynamic wrapper handler delegates to loaded function", async () => {
    const dynamicFn = vi.fn(async () => ({ result: 42 }));
    mockLoadDynamicScript.mockResolvedValue(dynamicFn);

    const wrapped = await scriptRegistry.getOrLoadDynamic("dyn_delegate_1");
    const handlerResult = await wrapped!.handler({
      taskId: "t1",
      context: { worktreePath: "/wt", store: { key: "val" } } as any,
      settings: {} as any,
      args: { a: 1 },
      inputs: { b: 2 },
    });

    expect(dynamicFn).toHaveBeenCalledWith({
      cwd: "/wt",
      store: { key: "val" },
      args: { a: 1, b: 2 },
      taskId: "t1",
    });
    expect(handlerResult).toEqual({ result: 42 });
  });
});
