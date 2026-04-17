import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual, join: vi.fn((...args: string[]) => args.join("/")) };
});

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { publishToGitHub } from "./github.js";
import type { PublishOptions } from "./github.js";

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
    const a = args as string[];
    if (a.includes("auth")) return "Logged in";
    if (a.some((x: string) => x === ".sha")) return "";
    if (a.includes("PUT")) return "{}";
    return "";
  });
});

describe("publishToGitHub", () => {
  // Minimal manifest fields required by updateRemoteIndex — it dereferences
  // manifest.name/version/type/description/author/tags when upserting the
  // registry index entry. Undefined manifest throws early inside that fn.
  const makeManifest = (overrides: Partial<PublishOptions["manifest"]> = {}): PublishOptions["manifest"] => ({
    name: "my-pkg",
    version: "1.0.0",
    type: "pipeline" as const,
    description: "test",
    author: "tester",
    tags: [],
    files: [],
    ...overrides,
  });

  const baseOpts: PublishOptions = {
    packageDir: "/tmp/my-pkg",
    packageName: "my-pkg",
    files: ["pipelines/main.yaml"],
    manifest: makeManifest(),
  };

  it("throws when gh auth fails", async () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      if ((args as string[]).includes("auth")) throw new Error("not logged in");
      return "";
    });

    await expect(publishToGitHub(baseOpts)).rejects.toThrow(
      "GitHub CLI (gh) is not authenticated",
    );
  });

  it("checks authentication before reading files", async () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      if ((args as string[]).includes("auth")) throw new Error("no auth");
      return "";
    });

    await expect(publishToGitHub(baseOpts)).rejects.toThrow();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it("reads manifest and all listed files", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("file-content");

    await publishToGitHub(baseOpts);

    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync).toHaveBeenCalledWith("/tmp/my-pkg/manifest.yaml", "utf-8");
    expect(fs.readFileSync).toHaveBeenCalledWith("/tmp/my-pkg/pipelines/main.yaml", "utf-8");
  });

  it("uploads manifest and all files via gh api", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("yaml-content");

    await publishToGitHub({
      packageDir: "/pkg",
      packageName: "test-pkg",
      files: ["a.yaml", "b.yaml"],
      manifest: makeManifest({ name: "test-pkg" }),
    });

    expect(fs.readFileSync).toHaveBeenCalledTimes(3);
  });

  it("includes sha when file already exists", async () => {
    const sha = "abc123";
    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (a.includes("auth")) return "Logged in";
      if (a.some((x: string) => x === ".sha")) return sha;
      return "{}";
    });
    vi.mocked(fs.readFileSync).mockReturnValue("content");

    await publishToGitHub(baseOpts);

    const putCalls = mockExecFileSync.mock.calls.filter(
      (call) => (call[1] as string[]).includes("PUT"),
    );
    const callsWithSha = putCalls.filter((call) =>
      (call[1] as string[]).some((arg: string) => arg === `sha=${sha}`),
    );
    expect(callsWithSha.length).toBeGreaterThan(0);
  });

  it("handles empty files array", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("manifest-only");

    await publishToGitHub({ packageDir: "/pkg", packageName: "minimal", files: [], manifest: makeManifest({ name: "minimal" }) });

    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("propagates readFileSync errors", async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await expect(publishToGitHub(baseOpts)).rejects.toThrow("ENOENT");
  });

  it("base64-encodes file content", async () => {
    const content = "name: test";
    vi.mocked(fs.readFileSync).mockReturnValue(content);

    await publishToGitHub({ packageDir: "/p", packageName: "enc", files: [], manifest: makeManifest({ name: "enc" }) });

    const expected = Buffer.from(content, "utf-8").toString("base64");
    const putCalls = mockExecFileSync.mock.calls.filter(
      (call) => (call[1] as string[]).includes("PUT"),
    );
    const hasB64 = putCalls.some((call) =>
      (call[1] as string[]).some((arg: string) => arg.includes(`content=${expected}`)),
    );
    expect(hasB64).toBe(true);
  });
});
