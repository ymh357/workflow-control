import { describe, it, expect } from "vitest";
import { generateCIWorkflow } from "./ci-template.js";

describe("generateCIWorkflow", () => {
  const yaml = generateCIWorkflow();

  it("contains workflow name", () => {
    expect(yaml).toContain("name: workflow-control CI/CD");
  });

  it("contains pull_request trigger on main", () => {
    expect(yaml).toContain("pull_request:");
    expect(yaml).toContain("branches: [main]");
  });

  it("contains push trigger on main", () => {
    expect(yaml).toContain("push:");
  });

  it("contains ci job with build and test steps", () => {
    expect(yaml).toContain("ci:");
    expect(yaml).toContain("pnpm install --frozen-lockfile");
    expect(yaml).toContain("pnpm build");
    expect(yaml).toContain("pnpm test || true");
    expect(yaml).toContain("pnpm lint || true");
  });

  it("contains post-merge job", () => {
    expect(yaml).toContain("post-merge:");
  });

  it("contains Notion status update step", () => {
    expect(yaml).toContain("Update Notion status");
  });

  it("contains Slack notification step", () => {
    expect(yaml).toContain("Slack notification");
    expect(yaml).toContain("SLACK_BOT_TOKEN");
  });

  it("uses actions/checkout@v4", () => {
    expect(yaml).toContain("actions/checkout@v4");
  });

  it("uses node 20", () => {
    expect(yaml).toContain("node-version: 20");
  });
});
