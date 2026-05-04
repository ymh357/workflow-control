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
import { decodeProjectDir } from "./watcher.js";
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
  const cwd = decodeProjectDir(dirName);
  const sessionId = basename(jsonlPath).replace(/\.jsonl$/, "");

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
  if (!existsSync(projectsRoot)) return null;
  const { readdir } = await import("node:fs/promises");
  const subdirs = await readdir(projectsRoot, { withFileTypes: true });
  let best: { path: string; mtime: number } | null = null;
  for (const dirent of subdirs) {
    if (!dirent.isDirectory()) continue;
    const projDir = join(projectsRoot, dirent.name);
    const files = await readdir(projDir);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(projDir, f);
      const st = await stat(p);
      if (!best || st.mtimeMs > best.mtime) {
        best = { path: p, mtime: st.mtimeMs };
      }
    }
  }
  return best?.path ?? null;
}

// keep export for unused-symbol audit; readFile imported for future
// full-read fallback when we want to bypass tail offsets.
void readFile;
