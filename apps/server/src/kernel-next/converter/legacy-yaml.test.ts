import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convertLegacyYaml } from "./legacy-yaml.js";
import { smokeTestIR } from "../builtins/smoke-test.js";
import { versionHash } from "../ir/canonical.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("convertLegacyYaml", () => {
  it("returns ok:false with YAML_PARSE_ERROR for malformed YAML", () => {
    const r = convertLegacyYaml("not: [valid: yaml");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("YAML_PARSE_ERROR");
    }
  });

  it("returns ok:false with LEGACY_SCHEMA_INVALID when YAML root is not an object", () => {
    const r = convertLegacyYaml("- just\n- a\n- list");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]!.code).toBe("LEGACY_SCHEMA_INVALID");
    }
  });
});

describe("convertLegacyYaml golden (smoke-test)", () => {
  it("produces an IR whose versionHash equals smokeTestIR()", () => {
    const yamlPath = resolve(
      __dirname, "../../builtin-pipelines/smoke-test/pipeline.yaml",
    );
    const yamlText = readFileSync(yamlPath, "utf-8");
    const r = convertLegacyYaml(yamlText, { yamlFilePath: yamlPath });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(versionHash(r.ir)).toBe(versionHash(smokeTestIR()));
      expect(r.promptRoot).toMatch(/smoke-test\/prompts$/);
    }
  });
});

describe("convertLegacyYaml golden (tech-research-collector)", () => {
  it("converts successfully with externalInputs + warnings", () => {
    const yamlPath = resolve(
      __dirname, "../../builtin-pipelines/tech-research-collector/pipeline.yaml",
    );
    const yamlText = readFileSync(yamlPath, "utf-8");
    const r = convertLegacyYaml(yamlText, { yamlFilePath: yamlPath });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ir.externalInputs).toEqual([
        { name: "pipelineConfig", type: "unknown" },
        { name: "projectContext", type: "unknown" },
      ]);
      expect(r.ir.stages).toHaveLength(1);
      expect(r.ir.stages[0]!.name).toBe("collectTargetSources");
      expect(r.warnings.some((w) => w.code === "LEGACY_FIELD_IGNORED")).toBe(true);
    }
  });
});
