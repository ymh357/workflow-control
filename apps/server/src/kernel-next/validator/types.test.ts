// Integration tests for validator/types.ts.
//
// These invoke real tsc via a subprocess. Each test pays ~1-3s.
// We use the monorepo-resolved tsc binary to avoid npx network lookup.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTypes } from "./types.js";
import type { PipelineIR } from "../ir/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve tsc binary from apps/server/node_modules/.bin/tsc.
function resolveTscPath(): string {
  // Walk up to apps/server/
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, "node_modules", ".bin", "tsc");
    if (existsSync(cand)) return cand;
    dir = dirname(dir);
  }
  throw new Error("tsc binary not found");
}

const TSC_PATH = resolveTscPath();

function validIR(): PipelineIR {
  return {
    name: "valid",
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: {} },
      { name: "B", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "y", type: "string" }],
        config: {} },
    ],
    wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
  };
}

describe("validator/types (tsc subprocess)", () => {
  beforeAll(() => {
    // Sanity check — if tsc isn't resolvable, tests can't run.
    expect(existsSync(TSC_PATH)).toBe(true);
  });

  it("accepts a type-correct pipeline", { timeout: 15_000 }, () => {
    const res = validateTypes(validIR(), { tscPath: TSC_PATH });
    expect(res.ok).toBe(true);
  });

  it("rejects a pipeline with a wire type mismatch and reports the specific wire", { timeout: 15_000 }, () => {
    // B.x expects number, but we wire from A.x which now produces string.
    const ir: PipelineIR = {
      name: "bad-types",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "string" }], config: {} },
        { name: "B", type: "agent",
          inputs: [{ name: "x", type: "number" }],
          outputs: [],
          config: {} },
      ],
      wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
    };
    const res = validateTypes(ir, { tscPath: TSC_PATH });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const mismatch = res.diagnostics.find((d) => d.code === "WIRE_TYPE_MISMATCH");
    expect(mismatch).toBeDefined();
    expect(mismatch!.context!.wire).toEqual({
      from: { stage: "A", port: "x" },
      to: { stage: "B", port: "x" },
    });
    // tsc reports "Type 'string' is not assignable to type 'number'".
    expect(mismatch!.context!.fromType).toBe("string");
    expect(mismatch!.context!.toType).toBe("number");
  });

  it("reports multiple mismatches independently for a pipeline with multiple bad wires", { timeout: 15_000 }, () => {
    const ir: PipelineIR = {
      name: "multi-bad",
      stages: [
        { name: "A", type: "agent", inputs: [],
          outputs: [{ name: "x", type: "string" }, { name: "y", type: "boolean" }],
          config: {} },
        { name: "B", type: "agent",
          inputs: [{ name: "x", type: "number" }, { name: "y", type: "number" }],
          outputs: [],
          config: {} },
      ],
      wires: [
        { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
        { from: { stage: "A", port: "y" }, to: { stage: "B", port: "y" } },
      ],
    };
    const res = validateTypes(ir, { tscPath: TSC_PATH });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const wires = res.diagnostics
      .filter((d) => d.code === "WIRE_TYPE_MISMATCH")
      .map((d) => {
        const w = d.context!.wire as { from: { stage: string; port: string }; to: { stage: string; port: string } };
        return `${w.from.stage}.${w.from.port}->${w.to.stage}.${w.to.port}`;
      });
    expect(wires.sort()).toEqual(["A.x->B.x", "A.y->B.y"]);
  });
});
