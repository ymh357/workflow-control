import { readFile as fsRead, writeFile as fsWrite, appendFile, access, mkdir, realpath } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";

const WORKFLOW_DIR = ".workflow";

function workflowPath(worktreePath: string, relativePath: string): string {
  if (!relativePath || relativePath === "." || relativePath === "..") {
    throw new Error(`Invalid artifact path: "${relativePath}"`);
  }
  if (relativePath.includes("\n") || relativePath.includes("\r")) {
    throw new Error(`Invalid artifact path: contains newline characters`);
  }
  const base = resolve(worktreePath, WORKFLOW_DIR);
  const full = resolve(base, relativePath);
  const rel = relative(base, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  return full;
}

async function assertNoSymlinkEscape(fullPath: string, worktreePath: string): Promise<void> {
  try {
    const real = await realpath(fullPath);
    const realBase = await realpath(resolve(worktreePath, WORKFLOW_DIR));
    const realRel = relative(realBase, real);
    if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) {
      throw new Error(`Symlink escape detected: resolved to ${real}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist yet — check the nearest existing ancestor
      let current = dirname(fullPath);
      const base = resolve(worktreePath, WORKFLOW_DIR);
      while (current.length >= base.length) {
        try {
          const realCurrent = await realpath(current);
          const realBase = await realpath(base);
          const rel = relative(realBase, realCurrent);
          if (rel.startsWith("..") || isAbsolute(rel)) {
            throw new Error(`Symlink escape detected: ancestor ${current} resolved to ${realCurrent}`);
          }
          return; // ancestor checks out
        } catch (innerErr) {
          if ((innerErr as NodeJS.ErrnoException).code === "ENOENT") {
            current = dirname(current);
            continue;
          }
          throw innerErr;
        }
      }
      return;
    }
    throw err;
  }
}

export async function writeArtifact(
  worktreePath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = workflowPath(worktreePath, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await assertNoSymlinkEscape(fullPath, worktreePath);

  // Verify parent directory is not a symlink (TOCTOU mitigation)
  try {
    const parentStat = lstatSync(dirname(fullPath));
    if (parentStat.isSymbolicLink()) {
      throw new Error(`Artifact parent directory is a symlink: ${dirname(fullPath)}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await fsWrite(fullPath, content, "utf-8");
}

export async function readArtifact(
  worktreePath: string,
  relativePath: string,
): Promise<string> {
  const fullPath = workflowPath(worktreePath, relativePath);
  await assertNoSymlinkEscape(fullPath, worktreePath);
  return fsRead(fullPath, "utf-8");
}

export async function appendProgress(
  worktreePath: string,
  entry: string,
): Promise<void> {
  const fullPath = workflowPath(worktreePath, "progress.txt");
  await mkdir(dirname(fullPath), { recursive: true });
  const line = `${new Date().toISOString()} ${entry}\n`;
  await appendFile(fullPath, line, "utf-8");
}

export async function stageCompleted(
  worktreePath: string,
  stage: string,
): Promise<boolean> {
  try {
    const content = await fsRead(workflowPath(worktreePath, "progress.txt"), "utf-8");
    return content.split("\n").some(line => line.endsWith(" " + stage + " completed"));
  } catch {
    return false;
  }
}

export async function artifactExists(
  worktreePath: string,
  relativePath: string,
): Promise<boolean> {
  try {
    await access(workflowPath(worktreePath, relativePath));
    return true;
  } catch {
    return false;
  }
}
