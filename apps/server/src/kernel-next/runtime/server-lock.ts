// Server-instance mutex via PID file.
//
// This product is local-single-user by design: exactly one server
// process serves one user. Two server instances pointing at the same
// DATA_DIR would race on kernel-next.db writes. We prevent that here.
//
// Mechanism: O_CREAT|O_EXCL|O_WRONLY on {DATA_DIR}/kernel-next.lock,
// write current pid, hold the file open until shutdown. On EEXIST,
// check whether the prior pid is live via process.kill(pid, 0) and
// take over if dead.
//
// NOT using flock(2): unreliable on NFS. DATA_DIR must live on local
// disk (documented in README).

import {
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  readFileSync,
  existsSync,
} from "node:fs";

export type AcquireResult =
  | { ok: true; release: { path: string; fd: number } }
  | { ok: false; reason: "already_held_alive"; pid: number }
  | { ok: false; reason: "io_error"; detail: string };

export function acquireServerLock(path: string): AcquireResult {
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, String(process.pid));
    } catch (err) {
      closeSync(fd);
      try { unlinkSync(path); } catch { /* best effort */ }
      return { ok: false, reason: "io_error", detail: (err as Error).message };
    }
    return { ok: true, release: { path, fd } };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      return { ok: false, reason: "io_error", detail: (err as Error).message };
    }
    return takeoverIfStale(path);
  }
}

function takeoverIfStale(path: string): AcquireResult {
  let priorPid = 0;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) priorPid = parsed;
  } catch {
    // unreadable lock file — treat as stale
  }
  if (priorPid > 0) {
    try {
      process.kill(priorPid, 0);
      return { ok: false, reason: "already_held_alive", pid: priorPid };
    } catch {
      // ESRCH: process is dead; fall through to takeover
    }
  }
  try { unlinkSync(path); } catch { /* best effort */ }
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, String(process.pid));
    return { ok: true, release: { path, fd } };
  } catch (err) {
    return { ok: false, reason: "io_error", detail: (err as Error).message };
  }
}

export function releaseServerLock(release: { path: string; fd: number }): void {
  try { closeSync(release.fd); } catch { /* ignore */ }
  if (existsSync(release.path)) {
    try { unlinkSync(release.path); } catch { /* ignore */ }
  }
}
