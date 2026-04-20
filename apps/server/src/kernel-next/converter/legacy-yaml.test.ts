import { describe, it, expect } from "vitest";
import { convertLegacyYaml } from "./legacy-yaml.js";

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
