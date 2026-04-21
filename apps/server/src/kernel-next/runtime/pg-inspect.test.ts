import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { convertLegacyYaml } from "../converter/legacy-yaml.js";

describe("pg wire inspection", () => {
  it("has no dup (to_stage, to_port)", () => {
    const yaml = readFileSync(
      path.resolve(__dirname, "../../builtin-pipelines/pipeline-generator/pipeline.yaml"),
      "utf8",
    );
    const r = convertLegacyYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seen = new Map<string, any>();
    const dups: Array<{ key: string; from1: any; from2: any }> = [];
    for (const w of r.ir.wires) {
      const key = `${w.to.stage}.${w.to.port}`;
      if (seen.has(key)) {
        dups.push({ key, from1: seen.get(key).from, from2: w.from });
      } else {
        seen.set(key, w);
      }
    }
    if (dups.length > 0) {
      console.log("DUPS:", JSON.stringify(dups, null, 2));
    }
    console.log("total wires:", r.ir.wires.length);
    expect(dups).toHaveLength(0);
  });
});
