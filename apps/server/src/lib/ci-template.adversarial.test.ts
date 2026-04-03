import { describe, it, expect } from "vitest";
import { generateCIWorkflow } from "./ci-template.js";

describe("ci-template adversarial", () => {
  const yaml = generateCIWorkflow();

  it("output is valid YAML-like string with no raw unescaped template literals", () => {
    // The template uses \\$ for GitHub Actions ${{ }} syntax
    // Ensure these are properly escaped as ${{ not raw ${
    expect(yaml).toContain("${{");
    expect(yaml).not.toMatch(/\$\{[^{]/); // no single-brace interpolation
  });

  it("CI job only runs on pull_request events", () => {
    // The ci job has: if: github.event_name == 'pull_request'
    expect(yaml).toContain("if: github.event_name == 'pull_request'");
  });

  it("post-merge job only runs on push to main", () => {
    expect(yaml).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
  });

  it("test and lint commands use || true to not fail the build", () => {
    expect(yaml).toContain("pnpm test || true");
    expect(yaml).toContain("pnpm lint || true");
  });

  it("output ends with a newline", () => {
    expect(yaml.endsWith("\n")).toBe(true);
  });

  it("Notion status update is conditional on NOTION_TOKEN env", () => {
    expect(yaml).toContain("if: env.NOTION_TOKEN != ''");
  });

  it("uses Chinese status label for Notion update", () => {
    expect(yaml).toContain("已完成");
  });

  it("idempotent: multiple calls produce identical output", () => {
    const yaml2 = generateCIWorkflow();
    expect(yaml).toBe(yaml2);
  });
});
