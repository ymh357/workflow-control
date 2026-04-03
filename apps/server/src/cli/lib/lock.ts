import * as fs from "node:fs";
import * as path from "node:path";
import { LOCK_FILE_NAME, LOCK_VERSION } from "./constants.js";
import type { LockFile, LockFileEntry } from "./types.js";

const LOCK_PATH = path.resolve(
  import.meta.dirname,
  `../../../${LOCK_FILE_NAME}`,
);

export function readLock(): LockFile {
  if (!fs.existsSync(LOCK_PATH)) {
    return { lockVersion: LOCK_VERSION, packages: {} };
  }
  try {
    const raw = fs.readFileSync(LOCK_PATH, "utf-8");
    return JSON.parse(raw) as LockFile;
  } catch {
    return { lockVersion: LOCK_VERSION, packages: {} };
  }
}

export function writeLock(lock: LockFile): void {
  fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}

export function addToLock(
  lock: LockFile,
  name: string,
  entry: LockFileEntry,
): LockFile {
  return {
    ...lock,
    packages: { ...lock.packages, [name]: entry },
  };
}

export function removeFromLock(lock: LockFile, name: string): LockFile {
  const { [name]: _, ...rest } = lock.packages;
  return { ...lock, packages: rest };
}
