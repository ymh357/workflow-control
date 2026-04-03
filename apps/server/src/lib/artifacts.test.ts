import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import {
  writeArtifact,
  readArtifact,
  appendProgress,
  stageCompleted,
  artifactExists,
} from "./artifacts.js";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

async function makeTmp(): Promise<string> {
  tmpDir = await mkdtemp(join(os.tmpdir(), "artifacts-test-"));
  return tmpDir;
}

describe("writeArtifact / readArtifact", () => {
  it("writes and reads a file under .workflow/", async () => {
    const dir = await makeTmp();
    await writeArtifact(dir, "plan.json", '{"ok":true}');
    const content = await readArtifact(dir, "plan.json");
    expect(content).toBe('{"ok":true}');
  });

  it("creates nested directories automatically", async () => {
    const dir = await makeTmp();
    await writeArtifact(dir, "sub/deep/file.txt", "hello");
    const content = await readArtifact(dir, "sub/deep/file.txt");
    expect(content).toBe("hello");
  });

  it("throws on path traversal with ../", async () => {
    const dir = await makeTmp();
    await expect(writeArtifact(dir, "../../etc/passwd", "x")).rejects.toThrow(
      "Path traversal detected",
    );
  });

  it("throws on path traversal with absolute path components", async () => {
    const dir = await makeTmp();
    await expect(writeArtifact(dir, "../outside", "x")).rejects.toThrow(
      "Path traversal detected",
    );
  });

  it("readArtifact throws when file does not exist", async () => {
    const dir = await makeTmp();
    await expect(readArtifact(dir, "nope.txt")).rejects.toThrow();
  });
});

describe("appendProgress / stageCompleted", () => {
  it("appends timestamped entries and detects completion", async () => {
    const dir = await makeTmp();
    await appendProgress(dir, "design completed");
    const completed = await stageCompleted(dir, "design");
    expect(completed).toBe(true);
  });

  it("returns false for non-completed stage", async () => {
    const dir = await makeTmp();
    await appendProgress(dir, "design started");
    const completed = await stageCompleted(dir, "design");
    expect(completed).toBe(false);
  });

  it("returns false when progress.txt does not exist", async () => {
    const dir = await makeTmp();
    const completed = await stageCompleted(dir, "design");
    expect(completed).toBe(false);
  });

  it("handles multiple entries", async () => {
    const dir = await makeTmp();
    await appendProgress(dir, "design started");
    await appendProgress(dir, "design completed");
    await appendProgress(dir, "implement started");
    expect(await stageCompleted(dir, "design")).toBe(true);
    expect(await stageCompleted(dir, "implement")).toBe(false);
  });
});

describe("artifactExists", () => {
  it("returns true for existing file", async () => {
    const dir = await makeTmp();
    await writeArtifact(dir, "test.txt", "data");
    expect(await artifactExists(dir, "test.txt")).toBe(true);
  });

  it("returns false for non-existing file", async () => {
    const dir = await makeTmp();
    expect(await artifactExists(dir, "missing.txt")).toBe(false);
  });

  it("returns false on path traversal (error is caught internally)", async () => {
    const dir = await makeTmp();
    // artifactExists catches all errors including path traversal, returning false
    expect(await artifactExists(dir, "../../etc/passwd")).toBe(false);
  });
});
