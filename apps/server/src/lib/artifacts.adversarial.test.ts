import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, symlink, mkdir as fsMkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import {
  writeArtifact,
  readArtifact,
  artifactExists,
  appendProgress,
} from "./artifacts.js";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

async function makeTmp(): Promise<string> {
  tmpDir = await mkdtemp(join(os.tmpdir(), "artifacts-adversarial-"));
  return tmpDir;
}

describe("path traversal attacks", () => {
  it("blocks simple ../", async () => {
    const dir = await makeTmp();
    await expect(readArtifact(dir, "../../../etc/passwd")).rejects.toThrow(
      "Path traversal detected",
    );
  });

  it("blocks URL-encoded dots ..%2F..%2F", async () => {
    const dir = await makeTmp();
    // If URL encoding is NOT decoded, this becomes a literal filename (no traversal).
    // But if the system later serves files by name, a file literally named "..%2F" is suspicious.
    // The key question: does this throw or silently create a weird file?
    // We expect it should throw for safety, but it likely WON'T since resolve treats %2F as literal.
    await expect(
      writeArtifact(dir, "..%2F..%2F..%2Fetc%2Fpasswd", "pwned"),
    ).rejects.toThrow("Path traversal");
  });

  it("blocks backslash traversal ..\\..\\etc\\passwd", async () => {
    const dir = await makeTmp();
    // On POSIX, backslash is a valid filename char. On Windows, it's a separator.
    // resolve() on macOS/Linux treats \\ as literal chars, so this won't be detected as traversal.
    // We expect this SHOULD throw for defense-in-depth, but it likely won't on macOS.
    await expect(
      readArtifact(dir, "..\\..\\etc\\passwd"),
    ).rejects.toThrow("Path traversal");
  });

  it("blocks null byte injection", async () => {
    const dir = await makeTmp();
    // Null byte in filename - Node.js should reject this at the fs level
    await expect(
      writeArtifact(dir, "legit.txt\x00.jpg", "data"),
    ).rejects.toThrow();
  });

  it("blocks absolute path /etc/passwd", async () => {
    const dir = await makeTmp();
    await expect(readArtifact(dir, "/etc/passwd")).rejects.toThrow(
      "Path traversal detected",
    );
  });

  it("blocks double-dot in middle that resolves outside: a/../b/../../etc/passwd", async () => {
    const dir = await makeTmp();
    await expect(
      readArtifact(dir, "a/../b/../../etc/passwd"),
    ).rejects.toThrow("Path traversal detected");
  });

  it("blocks write with path traversal ../evil.txt", async () => {
    const dir = await makeTmp();
    await expect(
      writeArtifact(dir, "../evil.txt", "malicious content"),
    ).rejects.toThrow("Path traversal detected");
  });

  it("blocks path traversal in artifactExists", async () => {
    const dir = await makeTmp();
    // artifactExists catches errors and returns false, but the path traversal
    // error from workflowPath should still be thrown (not caught).
    // Actually looking at the code, artifactExists has try/catch that returns false.
    // So path traversal is silently swallowed - is that the intended behavior?
    // The existing test expects false. Let's verify the error IS thrown before catch.
    // This test checks that workflowPath throws (which gets caught).
    // Not a vulnerability per se, but let's confirm it doesn't actually access the file.
    await expect(artifactExists(dir, "../../etc/passwd")).resolves.toBe(false);
  });

  it("blocks appendProgress path traversal via crafted worktreePath", async () => {
    const dir = await makeTmp();
    // What if worktreePath itself is crafted? The function trusts it.
    // appendProgress always writes to "progress.txt" so relativePath is fixed.
    // But a malicious worktreePath could point anywhere.
    // This isn't really a path traversal in relativePath, but worth noting.
    await expect(
      appendProgress("/tmp/../../etc", "pwned"),
    ).rejects.toThrow();
  });
});

describe("symlink following attack", () => {
  it("should NOT follow symlinks to files outside the artifact directory", async () => {
    const dir = await makeTmp();
    const workflowDir = join(dir, ".workflow");
    await fsMkdir(workflowDir, { recursive: true });

    // Create a symlink inside .workflow/ pointing to /etc/passwd
    const symlinkPath = join(workflowDir, "evil-link.txt");
    try {
      await symlink("/etc/passwd", symlinkPath);
    } catch {
      // If symlink creation fails (permissions), skip
      return;
    }

    // readArtifact resolves the path to .workflow/evil-link.txt which is inside base dir.
    // But the symlink points to /etc/passwd - the path check passes but the actual
    // file read follows the symlink to /etc/passwd.
    // This SHOULD fail for security, but likely SUCCEEDS (vulnerability!).
    await expect(readArtifact(dir, "evil-link.txt")).rejects.toThrow();
  });
});

describe("edge case inputs", () => {
  it("handles empty filename", async () => {
    const dir = await makeTmp();
    // resolve(base, "") returns base itself. relative(base, base) = "".
    // "" does not start with ".." and is not absolute, so it passes the check.
    // Then it tries to read the .workflow directory as a file - should error.
    // But writeArtifact would try to write to the directory path itself.
    // This is an edge case that should probably be rejected explicitly.
    await expect(writeArtifact(dir, "", "data")).rejects.toThrow();
  });

  it("handles filename that is just a dot", async () => {
    const dir = await makeTmp();
    // resolve(base, ".") returns base. relative(base, base) = "".
    // Same as empty string case.
    await expect(writeArtifact(dir, ".", "data")).rejects.toThrow();
  });

  it("handles very long filename (10000 chars)", async () => {
    const dir = await makeTmp();
    const longName = "a".repeat(10000) + ".txt";
    // Most filesystems have a 255-byte filename limit. This should fail at the OS level.
    await expect(writeArtifact(dir, longName, "data")).rejects.toThrow();
  });

  it("handles special characters in filename that could be shell-dangerous", async () => {
    const dir = await makeTmp();
    // Since the code uses fs APIs (not shell), command injection via filename shouldn't work.
    // But let's verify the file is created with the literal name.
    await writeArtifact(dir, "file;rm -rf /", "safe");
    const content = await readArtifact(dir, "file;rm -rf /");
    expect(content).toBe("safe");
  });

  it("handles filename with newlines", async () => {
    const dir = await makeTmp();
    await expect(
      writeArtifact(dir, "file\nname.txt", "data"),
    ).rejects.toThrow();
  });

  it("handles filename with only spaces", async () => {
    const dir = await makeTmp();
    // A filename of spaces is technically valid on most filesystems
    // but is a bad idea. Should it be rejected?
    await writeArtifact(dir, "   ", "data");
    const content = await readArtifact(dir, "   ");
    expect(content).toBe("data");
  });
});

describe("overwrite protection", () => {
  it("writeArtifact overwrites existing file without warning", async () => {
    const dir = await makeTmp();
    await writeArtifact(dir, "config.json", '{"v":1}');
    await writeArtifact(dir, "config.json", '{"v":2}');
    const content = await readArtifact(dir, "config.json");
    // This test documents that overwrite is silent - not necessarily a bug
    // but worth being aware of. The test passes if overwrite works.
    expect(content).toBe('{"v":2}');
  });
});

describe("race condition: TOCTOU on path check", () => {
  it("documents that path validation and file operation are not atomic", async () => {
    // This is a theoretical TOCTOU issue: between workflowPath() validating
    // the path and the actual fs operation, the directory structure could change
    // (e.g., a symlink could be swapped in). This is hard to test reliably
    // but worth documenting.
    const dir = await makeTmp();
    // Just verify normal operation works - the TOCTOU window exists but
    // is hard to exploit in practice
    await writeArtifact(dir, "safe.txt", "ok");
    expect(await readArtifact(dir, "safe.txt")).toBe("ok");
  });
});
