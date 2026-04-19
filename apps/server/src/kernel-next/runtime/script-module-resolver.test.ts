import { describe, it, expect } from "vitest";
import { TrivialScriptModuleResolver, type ScriptModule } from "./script-module-resolver.js";

const double: ScriptModule = {
  run: (inputs) => ({ out: (inputs.x as number) * 2 }),
};

describe("TrivialScriptModuleResolver", () => {
  it("returns the registered module for a known id", () => {
    const r = new TrivialScriptModuleResolver({ modules: { double } });
    expect(r.resolve("double")).toBe(double);
  });

  it("returns undefined for unknown ids", () => {
    const r = new TrivialScriptModuleResolver({ modules: { double } });
    expect(r.resolve("missing")).toBeUndefined();
  });

  it("copies the modules map on construction (later mutation is ignored)", () => {
    const mods: Record<string, ScriptModule> = { double };
    const r = new TrivialScriptModuleResolver({ modules: mods });
    mods.later = { run: () => ({}) };
    expect(r.resolve("later")).toBeUndefined();
  });
});
