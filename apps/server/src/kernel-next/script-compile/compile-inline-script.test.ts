import { describe, it, expect } from "vitest";
import { compileInlineScript } from "./compile-inline-script.js";

describe("compileInlineScript", () => {
  it("compiles a minimal ScriptModule implementation", () => {
    const source = `
      const mod: ScriptModule = {
        async run(inputs, _ctx) {
          return { out: String(inputs.x) };
        },
      };
      export default mod;
    `;
    const r = compileInlineScript(source);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The emitted JS is ESNext module form — export default survives.
      expect(r.js).toContain("export default");
      expect(r.js).toContain("run");
    }
  });

  it("flags syntax errors with line/column", () => {
    const source = `
      const mod = {
        run(inputs {   // <- missing )
      };
    `;
    const r = compileInlineScript(source);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.length).toBeGreaterThan(0);
      expect(r.diagnostics[0]!.line).toBeGreaterThan(0);
      expect(r.diagnostics[0]!.column).toBeGreaterThan(0);
    }
  });

  it("flags implicit any under strict mode", () => {
    const source = `
      export default {
        run(inputs, ctx) {
          const x = inputs.x;      // ok — Record<string, unknown>
          const y = someUndefined; // ReferenceError at runtime, but TS should catch Cannot find name 'someUndefined'
          return { y };
        },
      };
    `;
    const r = compileInlineScript(source);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.diagnostics.some((d) => d.message.toLowerCase().includes("cannot find name")),
      ).toBe(true);
    }
  });

  it("emits JS preserving imports (so later sandbox + whitelist apply)", () => {
    const source = `
      import { readFile } from "node:fs/promises";
      const mod: ScriptModule = {
        async run(inputs, _ctx) {
          const content = await readFile(inputs.path as string, "utf8");
          return { content };
        },
      };
      export default mod;
    `;
    const r = compileInlineScript(source);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.js).toContain("node:fs/promises");
    }
  });

  it("rejects a module whose run() returns a non-object", () => {
    // The ambient contract declares run's return type. A `return 42`
    // should fail type-checking because `number` is not assignable to
    // Record<string, unknown> / Promise of it.
    const source = `
      const mod: ScriptModule = {
        run() {
          return 42;
        },
      };
      export default mod;
    `;
    const r = compileInlineScript(source);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.diagnostics.some(
          (d) => d.message.toLowerCase().includes("not assignable"),
        ),
      ).toBe(true);
    }
  });
});
