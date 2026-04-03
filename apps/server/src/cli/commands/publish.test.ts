import { describe, it, expect, vi, beforeEach } from "vitest";

class ExitCalled extends Error { code: number; constructor(c: number) { super(`exit(${c})`); this.code = c; } }
const mockExit = vi.fn<(code?: number) => never>().mockImplementation((c) => { throw new ExitCalled(c ?? 0); });

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    resolve: vi.fn((p: string) => `/resolved/${p}`),
    join: vi.fn((...parts: string[]) => parts.join("/")),
  };
});

vi.mock("yaml", () => ({
  parse: vi.fn(),
}));

vi.mock("../lib/github.js", () => ({
  publishToGitHub: vi.fn(),
}));

vi.mock("../lib/constants.js", () => ({
  TYPE_DIR_MAP: {
    pipeline: "pipelines",
    skill: "skills",
    fragment: "prompts/fragments",
    hook: "hooks",
    gate: "gates",
    script: "scripts",
  },
}));

import * as fs from "node:fs";
import * as pathMod from "node:path";
import { parse as parseYaml } from "yaml";
import { publishCommand } from "./publish.js";
import { publishToGitHub } from "../lib/github.js";

describe("publishCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exit = mockExit as unknown as typeof process.exit;
  });

  it("exits when no directory provided", async () => {
    await expect(publishCommand(undefined)).rejects.toThrow(ExitCalled);

    expect(logSpy).toHaveBeenCalledWith("Usage: publish <directory>");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits when directory does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(publishCommand("nonexistent")).rejects.toThrow(ExitCalled);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Directory not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits when path is not a directory", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<typeof fs.statSync>);

    await expect(publishCommand("some-file")).rejects.toThrow(ExitCalled);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Directory not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits when manifest.yaml is missing", async () => {
    vi.mocked(fs.existsSync)
      .mockReturnValueOnce(true) // dir exists
      .mockReturnValueOnce(false); // manifest missing
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

    await expect(publishCommand("my-pkg")).rejects.toThrow(ExitCalled);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("manifest.yaml not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits on YAML parse error", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue("invalid: yaml: content");
    vi.mocked(parseYaml).mockImplementation(() => {
      throw new Error("bad yaml");
    });

    await expect(publishCommand("my-pkg")).rejects.toThrow(ExitCalled);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse manifest.yaml"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits when required fields are missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue("name: test");
    vi.mocked(parseYaml).mockReturnValue({
      name: "test",
      // missing version, type, description, author, tags, files
    });

    await expect(publishCommand("my-pkg")).rejects.toThrow(ExitCalled);

    expect(errorSpy).toHaveBeenCalledWith("Validation errors:");
    expect(errorSpy).toHaveBeenCalledWith("  - Missing required field: version");
    expect(errorSpy).toHaveBeenCalledWith("  - Missing required field: type");
    expect(errorSpy).toHaveBeenCalledWith("  - Missing required field: description");
    expect(errorSpy).toHaveBeenCalledWith("  - Missing required field: author");
    expect(errorSpy).toHaveBeenCalledWith("  - Missing required field: tags");
    expect(errorSpy).toHaveBeenCalledWith("  - Missing required field: files");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits on invalid package type", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue("");
    vi.mocked(parseYaml).mockReturnValue({
      name: "test",
      version: "1.0.0",
      type: "banana",
      description: "a test",
      author: "me",
      tags: ["test"],
      files: ["main.yaml"],
    });

    await expect(publishCommand("my-pkg")).rejects.toThrow(ExitCalled);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid type: "banana"'),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits when files listed in manifest do not exist on disk", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const ps = String(p);
      if (ps.includes("missing.yaml")) return false;
      return true;
    });
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue("");
    vi.mocked(parseYaml).mockReturnValue({
      name: "test",
      version: "1.0.0",
      type: "pipeline",
      description: "desc",
      author: "me",
      tags: ["t"],
      files: ["main.yaml", "missing.yaml"],
    });

    await expect(publishCommand("my-pkg")).rejects.toThrow(ExitCalled);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Missing files: missing.yaml"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("publishes successfully with valid manifest", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue("");
    vi.mocked(parseYaml).mockReturnValue({
      name: "my-pipeline",
      version: "1.0.0",
      type: "pipeline",
      description: "A cool pipeline",
      author: "alice",
      tags: ["ml", "data"],
      files: ["pipeline.yaml"],
    });
    vi.mocked(publishToGitHub).mockResolvedValue(undefined);
    vi.mocked(pathMod.resolve).mockReturnValue("/abs/my-pkg");

    await publishCommand("my-pkg");

    expect(logSpy).toHaveBeenCalledWith("Package validation passed!\n");
    expect(logSpy).toHaveBeenCalledWith("  Name:        my-pipeline");
    expect(logSpy).toHaveBeenCalledWith("  Version:     1.0.0");
    expect(logSpy).toHaveBeenCalledWith("  Type:        pipeline");
    expect(logSpy).toHaveBeenCalledWith("  Author:      alice");
    expect(logSpy).toHaveBeenCalledWith("  Tags:        ml, data");
    expect(logSpy).toHaveBeenCalledWith("  Files:       pipeline.yaml");
    expect(logSpy).toHaveBeenCalledWith(
      "\nPublishing to registry via GitHub API...\n",
    );
    expect(publishToGitHub).toHaveBeenCalledWith({
      packageDir: "/abs/my-pkg",
      packageName: "my-pipeline",
      files: ["pipeline.yaml"],
    });
    expect(logSpy).toHaveBeenCalledWith(
      "\nSuccessfully published my-pipeline@1.0.0 to registry.",
    );
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("exits when publishToGitHub throws", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue("");
    vi.mocked(parseYaml).mockReturnValue({
      name: "my-pkg",
      version: "1.0.0",
      type: "pipeline",
      description: "desc",
      author: "me",
      tags: ["t"],
      files: ["f.yaml"],
    });
    vi.mocked(publishToGitHub).mockRejectedValue(new Error("auth failed"));

    await expect(publishCommand("my-pkg")).rejects.toThrow(ExitCalled);

    expect(errorSpy).toHaveBeenCalledWith("\nPublish failed: auth failed");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("prints dependencies when present in manifest", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue("");
    vi.mocked(parseYaml).mockReturnValue({
      name: "dep-pkg",
      version: "1.0.0",
      type: "pipeline",
      description: "has deps",
      author: "me",
      tags: ["t"],
      files: ["main.yaml"],
      dependencies: {
        skills: ["skill-a", "skill-b"],
        fragments: [],
      },
    });
    vi.mocked(publishToGitHub).mockResolvedValue(undefined);

    await publishCommand("my-pkg");

    expect(logSpy).toHaveBeenCalledWith("  Dependencies:");
    expect(logSpy).toHaveBeenCalledWith("    skills: skill-a, skill-b");
  });
});
