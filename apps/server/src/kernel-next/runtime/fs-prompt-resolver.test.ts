import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsPromptResolver } from "./fs-prompt-resolver.js";
import type { AgentStage } from "../ir/schema.js";

function makeStage(name: string, promptRef: string): AgentStage {
  return {
    name,
    type: "agent",
    inputs: [],
    outputs: [],
    config: { promptRef },
  };
}

describe("FsPromptResolver", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fs-prompt-"));
    mkdirSync(join(root, "system"), { recursive: true });
    writeFileSync(join(root, "system", "greet.md"), "Hello from greet prompt.", "utf-8");
    writeFileSync(join(root, "bare.md"), "Bare prompt at root.", "utf-8");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a promptRef with implicit .md extension", () => {
    const r = new FsPromptResolver({ rootDir: root });
    const out = r.resolve({
      stage: makeStage("greet", "system/greet"),
      taskId: "t", attemptId: "a", inputs: {},
    });
    expect(out).toBe("Hello from greet prompt.");
  });

  it("accepts a promptRef that already has the .md extension", () => {
    const r = new FsPromptResolver({ rootDir: root });
    const out = r.resolve({
      stage: makeStage("bare", "bare.md"),
      taskId: "t", attemptId: "a", inputs: {},
    });
    expect(out).toBe("Bare prompt at root.");
  });

  it("throws on empty promptRef", () => {
    const r = new FsPromptResolver({ rootDir: root });
    expect(() => r.resolve({
      stage: makeStage("broken", ""),
      taskId: "t", attemptId: "a", inputs: {},
    })).toThrow(/empty promptRef/);
  });

  it("throws with a diagnostic path when the file does not exist", () => {
    const r = new FsPromptResolver({ rootDir: root });
    expect(() => r.resolve({
      stage: makeStage("missing", "system/does-not-exist"),
      taskId: "t", attemptId: "a", inputs: {},
    })).toThrow(/does-not-exist/);
  });

  it("honors a custom extension", () => {
    const r = new FsPromptResolver({ rootDir: root, extension: "" });
    expect(() => r.resolve({
      stage: makeStage("x", "bare.md"),
      taskId: "t", attemptId: "a", inputs: {},
    })).not.toThrow();
  });

  // B2.#29 (2026-04-30 review) regression: a promptRef containing
  // `..` segments must not let a malformed IR escape rootDir and
  // read arbitrary files the kernel UID can see.
  it("rejects a promptRef containing path-traversal segments", () => {
    const r = new FsPromptResolver({ rootDir: root, extension: "" });
    expect(() => r.resolve({
      stage: makeStage("evil", "../../etc/passwd"),
      taskId: "t", attemptId: "a", inputs: {},
    })).toThrow(/escapes rootDir|Path traversal/);
  });

  it("rejects a promptRef that resolves outside rootDir via implicit .md", () => {
    const r = new FsPromptResolver({ rootDir: root });
    expect(() => r.resolve({
      stage: makeStage("evil", "../../../tmp/outside"),
      taskId: "t", attemptId: "a", inputs: {},
    })).toThrow(/escapes rootDir|Path traversal/);
  });
});
