// On-demand session loader. Used by the user-triggered analyze flow:
// given a JSONL path or sessionId, ensure all events are parsed and
// persisted into forge.db, then return the sessionId. Idempotent —
// re-running for the same session is cheap (resumes from byte_offset).

import { stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { tailFile } from "./jsonl-tail.js";
import { parseLine } from "./parser.js";
import { rawProjectDir } from "./watcher.js";
import {
  upsertSession, advanceByteOffset, getSession, getMaxSeq, insertEvents,
} from "../db/sessions.js";

export interface LoadResult {
  sessionId: string;
  cwd: string;
  jsonlPath: string;
  newEventCount: number;
  totalEventCount: number;
  truncatedFromOffset: boolean;
}

export interface LoadOpts {
  /**
   * When set, only events from the last N entries of the parsed
   * stream are kept for distillation. We still persist every event
   * we read to forge.db (for history); truncation only applies to
   * the *returned* totalEventCount semantics for downstream callers
   * deciding "should I distill the whole thing?"
   */
  maxEvents?: number;
}

export async function loadSession(
  db: DatabaseSync,
  jsonlPath: string,
  _opts: LoadOpts = {},
): Promise<LoadResult> {
  if (!existsSync(jsonlPath)) {
    throw new Error(`SESSION_NOT_FOUND: ${jsonlPath}`);
  }
  const dirName = basename(dirname(jsonlPath));
  // Raw encoded form (e.g. "-private-tmp-workflow-control-..."). We
  // intentionally don't decode; see watcher.rawProjectDir for the
  // rationale (Claude Code's encoding loses literal-hyphen info).
  const cwd = rawProjectDir(dirName);
  // The canonical sessionId comes from the JSONL's first line (Claude
  // Code records its own UUID there). Falling back to the filename
  // basename is for fixtures / renamed files only — and only when the
  // file has no usable sessionId in its content.
  //
  // Why this matters: parser.parseLine() per line sets event.sessionId
  // from `obj.sessionId ?? ctx.sessionId`. If the filename basename
  // differs from the in-file sessionId, the events' sessionId column
  // diverges from the sessions row's session_id, and the FK on
  // session_events fails. (Real-world repro 2026-05-05: copying the
  // session JSONL to /tmp/anything.jsonl then loading it.)
  const filenameSessionId = basename(jsonlPath).replace(/\.jsonl$/, "");
  const inFileSessionId = await peekSessionId(jsonlPath);
  const sessionId = inFileSessionId ?? filenameSessionId;

  const st = await stat(jsonlPath);
  const now = Date.now();
  upsertSession(db, {
    sessionId, cwd, jsonlPath,
    firstSeenAt: now, lastEventAt: now,
  });

  const existing = getSession(db, sessionId)!;
  let offset = existing.byteOffset;
  let truncated = false;

  // If file shrank below stored offset (rotation / clear), reset.
  if (offset > st.size) {
    truncated = true;
    offset = 0;
  }

  const tail = await tailFile(jsonlPath, offset);
  if (tail.truncated) {
    truncated = true;
    offset = 0;
    // Re-read from 0
    const second = await tailFile(jsonlPath, 0);
    return await ingestLines(db, second.lines, sessionId, second.newOffset, truncated);
  }
  return await ingestLines(db, tail.lines, sessionId, tail.newOffset, truncated);
}

async function ingestLines(
  db: DatabaseSync,
  lines: string[],
  sessionId: string,
  newOffset: number,
  truncated: boolean,
): Promise<LoadResult> {
  let nextSeq = getMaxSeq(db, sessionId) + 1;
  const ctx = { sessionId, nextSeq };
  const events = [];
  for (const line of lines) {
    const parsed = parseLine(line, ctx);
    for (const e of parsed) events.push(e);
    nextSeq = ctx.nextSeq;
  }
  insertEvents(db, sessionId, events);
  advanceByteOffset(db, sessionId, newOffset);
  const session = getSession(db, sessionId)!;
  return {
    sessionId,
    cwd: session.cwd,
    jsonlPath: session.jsonlPath,
    newEventCount: events.length,
    totalEventCount: session.eventCount,
    truncatedFromOffset: truncated,
  };
}

/**
 * Read the first 64KB of a JSONL file and return the first sessionId
 * field encountered, or null if no line in that window has one. Used
 * to align our `sessions.session_id` column with what the parser
 * extracts per-event from `obj.sessionId`.
 */
async function peekSessionId(path: string): Promise<string | null> {
  const { open: openFile } = await import("node:fs/promises");
  const handle = await openFile(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const sid = obj.sessionId;
        if (typeof sid === "string" && sid.length > 0) return sid;
      } catch { /* skip */ }
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Resolve a sessionId (from sessions table) to a JSONL path. Used by
 * the analyze handler when the caller knows the sessionId but not the
 * filesystem path.
 */
export function resolveSessionPath(db: DatabaseSync, sessionId: string): string | null {
  const row = getSession(db, sessionId);
  return row?.jsonlPath ?? null;
}

/**
 * Best-effort detection of "the most-recently-active session" under a
 * given projects root. Used by the MCP tool when the agent says
 * "analyze my current session" without specifying which.
 */
export async function findMostRecentSessionFile(projectsRoot: string): Promise<string | null> {
  const list = await listRecentSessionFiles(projectsRoot, 1);
  return list[0] ?? null;
}

/**
 * Return the absolute paths of the N most-recently-modified .jsonl
 * files under `projectsRoot`, ordered newest first. Used by the
 * forge_analyze_recent tool to kick off N parallel analyses without
 * forcing the caller to enumerate session ids.
 *
 * Edge cases: if `projectsRoot` doesn't exist OR contains no .jsonl
 * files, returns []. `count` is treated as a hard upper bound (the
 * actual return may be shorter when fewer sessions exist).
 */
export async function listRecentSessionFiles(
  projectsRoot: string,
  count: number,
): Promise<string[]> {
  if (count <= 0 || !existsSync(projectsRoot)) return [];
  const { readdir } = await import("node:fs/promises");
  const subdirs = await readdir(projectsRoot, { withFileTypes: true });
  const all: Array<{ path: string; mtime: number }> = [];
  for (const dirent of subdirs) {
    if (!dirent.isDirectory()) continue;
    const projDir = join(projectsRoot, dirent.name);
    const files = await readdir(projDir);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(projDir, f);
      const st = await stat(p);
      all.push({ path: p, mtime: st.mtimeMs });
    }
  }
  all.sort((a, b) => b.mtime - a.mtime);
  return all.slice(0, count).map((x) => x.path);
}

// keep export for unused-symbol audit; readFile imported for future
// full-read fallback when we want to bypass tail offsets.
void readFile;
