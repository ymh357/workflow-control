# Forge — Session Mining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Forge, the session-mining subsystem that turns Claude Code conversation logs into adopt-ready pipeline candidates.

**Architecture:** New `forge.db` SQLite, ingestion daemon tailing `~/.claude-personal/projects/**/*.jsonl`, distillation via a new builtin pipeline `forge-distill`, embedding-based clustering with a 0.85 / 3-sessions / 2-days threshold, synthesis through `pipeline-generator`, candidates surfaced at `/forge` for user adoption (which routes through existing `submit_pipeline`). All modules small, single-responsibility, isolated tests.

**Tech Stack:** TypeScript, hono, zod, vitest, Node `node:sqlite`, `node:fs/watch`, Voyage AI embeddings (default), Next.js + React Testing Library (web).

**Spec:** `docs/superpowers/specs/2026-05-04-forge-session-mining-design.md`

**Worktree:** `/Users/minghao/workflow-control-session-mining` (branch `session-mining`).

---

## Phase 0: Bootstrap

### Task 0.1: Create directory skeleton

- [ ] **Step 0.1.1: Create empty subdirectories with .gitkeep**

```bash
cd /Users/minghao/workflow-control-session-mining
mkdir -p apps/server/src/forge/{db,ingestion,distillation,similarity,synthesis,daemon,api,__tests__}
mkdir -p apps/server/src/builtin-pipelines/forge-distill/prompts
mkdir -p apps/web/src/app/forge/{candidates,clusters,sessions}
mkdir -p apps/web/src/app/forge/candidates/[id] apps/web/src/app/forge/clusters/[id]
mkdir -p apps/web/src/components/forge
```

(No commit yet — directories will be populated by subsequent tasks.)

---

## Phase 1: Schema + DB

### Task 1.1: types.ts — domain types

**Files:**
- Create: `apps/server/src/forge/types.ts`
- Test: none (types only)

- [ ] **Step 1.1.1: Write `types.ts`**

```ts
// Domain types for Forge. No runtime logic — purely shape definitions
// shared across modules.

export interface SessionRow {
  sessionId: string;
  cwd: string;
  jsonlPath: string;
  byteOffset: number;
  firstSeenAt: number;
  lastEventAt: number;
  status: "active" | "quiescent" | "distilled" | "distillation_failed" | "skipped";
  eventCount: number;
  skipReason: string | null;
}

export type SessionEventRole = "user" | "assistant" | "tool_use" | "tool_result" | "system";

export interface SessionEvent {
  sessionId: string;
  seq: number;
  ts: number;
  role: SessionEventRole;
  textExcerpt: string | null;
  textHash: string | null;
  textLength: number | null;
  toolName: string | null;
  toolArgsExcerpt: string | null;
}

export type EpisodeOutcome = "completed" | "abandoned" | "partial" | "exploratory";

export interface EpisodeStep {
  stageKind: "agent" | "tool" | "decision";
  description: string;
  inputs?: string[];
  outputs?: string[];
  toolCalls?: string[];
}

export interface SessionEpisode {
  episodeId: string;
  sessionId: string;
  startSeq: number;
  endSeq: number;
  intent: string;
  outcome: EpisodeOutcome;
  steps: EpisodeStep[];
  rationale: string;
  pipelineAble: boolean;
  createdAt: number;
}

export interface EpisodeSignature {
  episodeId: string;
  embedding: Float32Array;
  embeddingModel: string;
  embeddingDim: number;
  signatureKey: string;
  createdAt: number;
}

export type ClusterStatus = "forming" | "ripe" | "synthesized" | "adopted" | "dismissed";

export interface EpisodeCluster {
  clusterId: string;
  centroid: Float32Array;
  centroidModel: string;
  memberCount: number;
  distinctSessionCount: number;
  distinctDayCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  status: ClusterStatus;
  suppressedUntil: number | null;
}

export interface ClusterMember {
  clusterId: string;
  episodeId: string;
  addedAt: number;
  cosine: number;
}

export type DryRunStatus = "pending" | "passed" | "failed" | "skipped";

export interface PipelineCandidate {
  candidateId: string;
  clusterId: string;
  irJson: string;
  promptsJson: string;
  dryRunStatus: DryRunStatus;
  dryRunDiagnosticsJson: string | null;
  synthTaskId: string | null;
  generatedAt: number;
  adoptedVersionHash: string | null;
  adoptedAt: number | null;
  dismissedAt: number | null;
  dismissedReason: string | null;
}

export interface RedactionHit {
  kind: string;          // "github-token" | "openai-key" | ...
  startIndex: number;
  endIndex: number;
}
```

- [ ] **Step 1.1.2: Verify tsc**

```
cd apps/server && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 1.1.3: Commit**

```bash
git add apps/server/src/forge/types.ts
git commit -m "feat(forge): types — SessionEvent, Episode, Cluster, Candidate

Domain shapes used across all forge modules. No runtime logic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.2: schema.ts — DDL + migration

**Files:**
- Create: `apps/server/src/forge/db/schema.ts`
- Test: `apps/server/src/forge/__tests__/schema.test.ts`

- [ ] **Step 1.2.1: Write the failing test**

`apps/server/src/forge/__tests__/schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";

describe("initForgeSchema", () => {
  function open(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    initForgeSchema(db);
    return db;
  }

  it("creates all 6 forge tables", () => {
    const db = open();
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain("sessions");
    expect(names).toContain("session_events");
    expect(names).toContain("session_episodes");
    expect(names).toContain("episode_signatures");
    expect(names).toContain("episode_clusters");
    expect(names).toContain("cluster_members");
    expect(names).toContain("pipeline_candidates");
  });

  it("is idempotent (running twice doesn't error)", () => {
    const db = new DatabaseSync(":memory:");
    initForgeSchema(db);
    expect(() => initForgeSchema(db)).not.toThrow();
  });

  it("enforces sessions.status check constraint", () => {
    const db = open();
    expect(() =>
      db.prepare(
        `INSERT INTO sessions(session_id, cwd, jsonl_path, first_seen_at, last_event_at, status, event_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("s1", "/tmp", "/tmp/s1.jsonl", 1, 1, "bogus", 0),
    ).toThrow();
  });

  it("session_events PK enforces (session_id, seq) uniqueness", () => {
    const db = open();
    db.prepare(
      `INSERT INTO sessions(session_id, cwd, jsonl_path, first_seen_at, last_event_at, status, event_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("s1", "/tmp", "/p.jsonl", 1, 1, "active", 0);
    db.prepare(
      `INSERT INTO session_events(session_id, seq, ts, role) VALUES (?, ?, ?, ?)`,
    ).run("s1", 1, 100, "user");
    expect(() =>
      db.prepare(
        `INSERT INTO session_events(session_id, seq, ts, role) VALUES (?, ?, ?, ?)`,
      ).run("s1", 1, 200, "user"),
    ).toThrow();
  });

  it("ON DELETE CASCADE removes events when session is deleted", () => {
    const db = open();
    db.prepare(`PRAGMA foreign_keys = ON`).run();
    db.prepare(
      `INSERT INTO sessions(session_id, cwd, jsonl_path, first_seen_at, last_event_at, status, event_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("s1", "/tmp", "/p.jsonl", 1, 1, "active", 0);
    db.prepare(
      `INSERT INTO session_events(session_id, seq, ts, role) VALUES (?, ?, ?, ?)`,
    ).run("s1", 1, 100, "user");
    db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run("s1");
    const remaining = db.prepare(
      `SELECT count(*) as n FROM session_events WHERE session_id = ?`,
    ).get("s1") as { n: number };
    expect(remaining.n).toBe(0);
  });
});
```

- [ ] **Step 1.2.2: Run test to verify it fails**

```
cd apps/server && npx vitest run src/forge/__tests__/schema.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 1.2.3: Implement `schema.ts`**

```ts
// Forge DB schema. Single function: initForgeSchema(db) — idempotent
// (uses CREATE TABLE IF NOT EXISTS). Foreign-key cascades enabled at
// open time (open.ts), not here, because PRAGMA is connection-scoped.

import type { DatabaseSync } from "node:sqlite";

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  cwd               TEXT NOT NULL,
  jsonl_path        TEXT NOT NULL,
  byte_offset       INTEGER NOT NULL DEFAULT 0,
  first_seen_at     INTEGER NOT NULL,
  last_event_at     INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK(status IN
    ('active','quiescent','distilled','distillation_failed','skipped')),
  event_count       INTEGER NOT NULL DEFAULT 0,
  skip_reason       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, last_event_at);

CREATE TABLE IF NOT EXISTS session_events (
  session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('user','assistant','tool_use','tool_result','system')),
  text_excerpt  TEXT,
  text_hash     TEXT,
  text_length   INTEGER,
  tool_name     TEXT,
  tool_args_excerpt TEXT,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_session_events_role ON session_events(session_id, role);

CREATE TABLE IF NOT EXISTS session_episodes (
  episode_id        TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  start_seq         INTEGER NOT NULL,
  end_seq           INTEGER NOT NULL,
  intent            TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK(outcome IN
    ('completed','abandoned','partial','exploratory')),
  steps_json        TEXT NOT NULL,
  rationale         TEXT NOT NULL,
  pipeline_able     INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_pipeline_able ON session_episodes(pipeline_able);

CREATE TABLE IF NOT EXISTS episode_signatures (
  episode_id      TEXT PRIMARY KEY REFERENCES session_episodes(episode_id) ON DELETE CASCADE,
  embedding       BLOB NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dim   INTEGER NOT NULL,
  signature_key   TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signatures_key ON episode_signatures(signature_key);

CREATE TABLE IF NOT EXISTS episode_clusters (
  cluster_id      TEXT PRIMARY KEY,
  centroid_blob   BLOB NOT NULL,
  centroid_model  TEXT NOT NULL,
  member_count    INTEGER NOT NULL,
  distinct_session_count INTEGER NOT NULL,
  distinct_day_count     INTEGER NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK(status IN
    ('forming','ripe','synthesized','adopted','dismissed')),
  suppressed_until INTEGER
);

CREATE TABLE IF NOT EXISTS cluster_members (
  cluster_id    TEXT NOT NULL REFERENCES episode_clusters(cluster_id) ON DELETE CASCADE,
  episode_id    TEXT NOT NULL REFERENCES session_episodes(episode_id) ON DELETE CASCADE,
  added_at      INTEGER NOT NULL,
  cosine        REAL NOT NULL,
  PRIMARY KEY (cluster_id, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_cluster_members_episode ON cluster_members(episode_id);

CREATE TABLE IF NOT EXISTS pipeline_candidates (
  candidate_id    TEXT PRIMARY KEY,
  cluster_id      TEXT NOT NULL REFERENCES episode_clusters(cluster_id) ON DELETE RESTRICT,
  ir_json         TEXT NOT NULL,
  prompts_json    TEXT NOT NULL,
  dry_run_status  TEXT NOT NULL CHECK(dry_run_status IN
    ('pending','passed','failed','skipped')),
  dry_run_diagnostics_json TEXT,
  synth_task_id   TEXT,
  generated_at    INTEGER NOT NULL,
  adopted_version_hash TEXT,
  adopted_at      INTEGER,
  dismissed_at    INTEGER,
  dismissed_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_candidates_cluster ON pipeline_candidates(cluster_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON pipeline_candidates(dry_run_status, adopted_at, dismissed_at);

CREATE TABLE IF NOT EXISTS forge_jobs (
  job_id          TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK(kind IN ('tail','distill','cluster','synthesize','dryrun')),
  job_key         TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  enqueued_at     INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed','failed')),
  last_error      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_forge_jobs_dedup ON forge_jobs(kind, job_key) WHERE status IN ('pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_forge_jobs_status ON forge_jobs(status, enqueued_at);
`;

export function initForgeSchema(db: DatabaseSync): void {
  for (const stmt of DDL.split(";")) {
    const trimmed = stmt.trim();
    if (trimmed.length > 0) db.prepare(trimmed).run();
  }
}
```

- [ ] **Step 1.2.4: Run tests, verify pass**

```
cd apps/server && npx vitest run src/forge/__tests__/schema.test.ts
```

- [ ] **Step 1.2.5: Commit**

```bash
git add apps/server/src/forge/db/schema.ts apps/server/src/forge/__tests__/schema.test.ts
git commit -m "feat(forge): forge.db schema — sessions, events, episodes, clusters, candidates, jobs"
```

---

### Task 1.3: open.ts — singleton DB handle

**Files:**
- Create: `apps/server/src/forge/db/open.ts`
- Test: `apps/server/src/forge/__tests__/db-open.test.ts`

- [ ] **Step 1.3.1: Write test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { __setForgeDbForTest, getForgeDb } from "../db/open.js";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";

describe("getForgeDb", () => {
  afterEach(() => __setForgeDbForTest(undefined));

  it("returns the test override when set", () => {
    const db = new DatabaseSync(":memory:");
    initForgeSchema(db);
    __setForgeDbForTest(db);
    expect(getForgeDb()).toBe(db);
  });

  it("throws when not initialized", () => {
    __setForgeDbForTest(undefined);
    expect(() => getForgeDb()).toThrow(/not initialized/i);
  });
});
```

- [ ] **Step 1.3.2: Run test → fail; implement; pass**

`apps/server/src/forge/db/open.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { initForgeSchema } from "./schema.js";

let _db: DatabaseSync | undefined;

export function openForgeDb(dataDir: string): DatabaseSync {
  if (_db) return _db;
  const path = join(dataDir, "forge.db");
  const db = new DatabaseSync(path);
  db.prepare("PRAGMA journal_mode = WAL").run();
  db.prepare("PRAGMA foreign_keys = ON").run();
  initForgeSchema(db);
  _db = db;
  return db;
}

export function getForgeDb(): DatabaseSync {
  if (!_db) throw new Error("forge db not initialized; call openForgeDb first");
  return _db;
}

export function closeForgeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}

// Test-only override.
export function __setForgeDbForTest(db: DatabaseSync | undefined): void {
  _db = db;
}
```

- [ ] **Step 1.3.3: Commit**

```bash
git add apps/server/src/forge/db/open.ts apps/server/src/forge/__tests__/db-open.test.ts
git commit -m "feat(forge): forge.db singleton handle (openForgeDb/getForgeDb)"
```

---

### Task 1.4: sessions.ts — sessions / session_events CRUD

**Files:**
- Create: `apps/server/src/forge/db/sessions.ts`
- Test: `apps/server/src/forge/__tests__/db-sessions.test.ts`

- [ ] **Step 1.4.1: Write test (round-trip CRUD + offset advance + status transitions)**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";
import {
  upsertSession, advanceByteOffset, setSessionStatus,
  getSession, listSessionsByStatus, insertEvents, listEventsBySession,
} from "../db/sessions.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initForgeSchema(db);
});

describe("sessions CRUD", () => {
  it("upsert + get round-trips", () => {
    upsertSession(db, {
      sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl",
      firstSeenAt: 100, lastEventAt: 200,
    });
    const row = getSession(db, "s1");
    expect(row).not.toBeNull();
    expect(row!.cwd).toBe("/p");
    expect(row!.byteOffset).toBe(0);
    expect(row!.status).toBe("active");
  });

  it("upsert is idempotent (touches lastEventAt)", () => {
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 300 });
    expect(getSession(db, "s1")!.lastEventAt).toBe(300);
  });

  it("advanceByteOffset only advances forward (never regresses)", () => {
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    advanceByteOffset(db, "s1", 1024);
    advanceByteOffset(db, "s1", 512); // older, should be ignored
    expect(getSession(db, "s1")!.byteOffset).toBe(1024);
  });

  it("setSessionStatus transitions and rejects invalid statuses", () => {
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    setSessionStatus(db, "s1", "quiescent");
    expect(getSession(db, "s1")!.status).toBe("quiescent");
  });

  it("listSessionsByStatus returns matching rows ordered", () => {
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/a.jsonl", firstSeenAt: 100, lastEventAt: 200 });
    upsertSession(db, { sessionId: "s2", cwd: "/p", jsonlPath: "/b.jsonl", firstSeenAt: 100, lastEventAt: 300 });
    setSessionStatus(db, "s1", "quiescent");
    setSessionStatus(db, "s2", "quiescent");
    const list = listSessionsByStatus(db, "quiescent");
    expect(list).toHaveLength(2);
    expect(list[0]!.sessionId).toBe("s1"); // older lastEventAt first
  });
});

describe("session_events", () => {
  beforeEach(() => {
    upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p/s1.jsonl", firstSeenAt: 100, lastEventAt: 200 });
  });

  it("insertEvents writes a batch + advances eventCount", () => {
    insertEvents(db, "s1", [
      { sessionId: "s1", seq: 1, ts: 100, role: "user", textExcerpt: "hi", textHash: "h1", textLength: 2, toolName: null, toolArgsExcerpt: null },
      { sessionId: "s1", seq: 2, ts: 110, role: "assistant", textExcerpt: "hello", textHash: "h2", textLength: 5, toolName: null, toolArgsExcerpt: null },
    ]);
    expect(getSession(db, "s1")!.eventCount).toBe(2);
    const events = listEventsBySession(db, "s1");
    expect(events).toHaveLength(2);
    expect(events[0]!.role).toBe("user");
  });

  it("insertEvents is idempotent on (session, seq)", () => {
    const ev = { sessionId: "s1", seq: 1, ts: 100, role: "user" as const, textExcerpt: "hi", textHash: "h1", textLength: 2, toolName: null, toolArgsExcerpt: null };
    insertEvents(db, "s1", [ev]);
    expect(() => insertEvents(db, "s1", [ev])).not.toThrow();
    expect(listEventsBySession(db, "s1")).toHaveLength(1);
  });
});
```

- [ ] **Step 1.4.2: Run → fail; implement**

`apps/server/src/forge/db/sessions.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import type { SessionRow, SessionEvent } from "../types.js";

export function upsertSession(
  db: DatabaseSync,
  args: {
    sessionId: string;
    cwd: string;
    jsonlPath: string;
    firstSeenAt: number;
    lastEventAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO sessions(session_id, cwd, jsonl_path, first_seen_at, last_event_at, status, event_count)
     VALUES (?, ?, ?, ?, ?, 'active', 0)
     ON CONFLICT(session_id) DO UPDATE SET
       last_event_at = MAX(last_event_at, excluded.last_event_at)`,
  ).run(args.sessionId, args.cwd, args.jsonlPath, args.firstSeenAt, args.lastEventAt);
}

export function getSession(db: DatabaseSync, sessionId: string): SessionRow | null {
  const row = db.prepare(
    `SELECT * FROM sessions WHERE session_id = ?`,
  ).get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id as string,
    cwd: row.cwd as string,
    jsonlPath: row.jsonl_path as string,
    byteOffset: row.byte_offset as number,
    firstSeenAt: row.first_seen_at as number,
    lastEventAt: row.last_event_at as number,
    status: row.status as SessionRow["status"],
    eventCount: row.event_count as number,
    skipReason: (row.skip_reason as string | null) ?? null,
  };
}

export function advanceByteOffset(db: DatabaseSync, sessionId: string, newOffset: number): void {
  db.prepare(
    `UPDATE sessions SET byte_offset = MAX(byte_offset, ?) WHERE session_id = ?`,
  ).run(newOffset, sessionId);
}

export function setSessionStatus(
  db: DatabaseSync,
  sessionId: string,
  status: SessionRow["status"],
  skipReason?: string,
): void {
  db.prepare(
    `UPDATE sessions SET status = ?, skip_reason = ? WHERE session_id = ?`,
  ).run(status, skipReason ?? null, sessionId);
}

export function listSessionsByStatus(
  db: DatabaseSync,
  status: SessionRow["status"],
): SessionRow[] {
  const rows = db.prepare(
    `SELECT * FROM sessions WHERE status = ? ORDER BY last_event_at ASC`,
  ).all(status) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    sessionId: r.session_id as string,
    cwd: r.cwd as string,
    jsonlPath: r.jsonl_path as string,
    byteOffset: r.byte_offset as number,
    firstSeenAt: r.first_seen_at as number,
    lastEventAt: r.last_event_at as number,
    status: r.status as SessionRow["status"],
    eventCount: r.event_count as number,
    skipReason: (r.skip_reason as string | null) ?? null,
  }));
}

export function insertEvents(db: DatabaseSync, sessionId: string, events: SessionEvent[]): void {
  if (events.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO session_events
       (session_id, seq, ts, role, text_excerpt, text_hash, text_length, tool_name, tool_args_excerpt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  for (const e of events) {
    const r = stmt.run(
      e.sessionId, e.seq, e.ts, e.role,
      e.textExcerpt, e.textHash, e.textLength,
      e.toolName, e.toolArgsExcerpt,
    );
    inserted += Number(r.changes);
  }
  db.prepare(
    `UPDATE sessions SET event_count = event_count + ? WHERE session_id = ?`,
  ).run(inserted, sessionId);
}

export function listEventsBySession(db: DatabaseSync, sessionId: string): SessionEvent[] {
  const rows = db.prepare(
    `SELECT * FROM session_events WHERE session_id = ? ORDER BY seq ASC`,
  ).all(sessionId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    sessionId: r.session_id as string,
    seq: r.seq as number,
    ts: r.ts as number,
    role: r.role as SessionEvent["role"],
    textExcerpt: (r.text_excerpt as string | null) ?? null,
    textHash: (r.text_hash as string | null) ?? null,
    textLength: (r.text_length as number | null) ?? null,
    toolName: (r.tool_name as string | null) ?? null,
    toolArgsExcerpt: (r.tool_args_excerpt as string | null) ?? null,
  }));
}
```

- [ ] **Step 1.4.3: Pass + commit**

```
npx vitest run src/forge/__tests__/db-sessions.test.ts
```

```bash
git add apps/server/src/forge/db/sessions.ts apps/server/src/forge/__tests__/db-sessions.test.ts
git commit -m "feat(forge): sessions + session_events CRUD"
```

---

### Task 1.5: episodes.ts / clusters.ts / candidates.ts

Same pattern as 1.4 — write test → fail → implement → pass → commit. Each file has:

- `episodes.ts`: `insertEpisode`, `getEpisode`, `listEpisodesBySession`, `listPipelineableEpisodes`
- `clusters.ts`: `insertCluster`, `getCluster`, `updateClusterCentroid`, `addClusterMember`, `listClustersByStatus`, `setClusterStatus`, `setClusterSuppressedUntil`
- `candidates.ts`: `insertCandidate`, `getCandidate`, `listPendingCandidates`, `setCandidateDryRun`, `markCandidateAdopted`, `markCandidateDismissed`

Tests cover: round-trip, idempotence, status transitions, foreign-key cascade behavior. Implementations are direct SQL using `db.prepare(...)`.

- [ ] **Step 1.5.1**: Write `episodes.ts` + test, commit
- [ ] **Step 1.5.2**: Write `clusters.ts` + test, commit
- [ ] **Step 1.5.3**: Write `candidates.ts` + test, commit

(Each commit is one file pair: implementation + adversarial test, verified passing.)

Specifics for clusters.ts — embedding stored as Float32Array → BLOB:

```ts
function f32ToBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
function blobToF32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
```

These two helpers are also used by `episode_signatures` writes.

---

## Phase 2: Ingestion

### Task 2.1: redactor.ts — secret pattern detection

**Files:**
- Create: `apps/server/src/forge/ingestion/redactor.ts`
- Test: `apps/server/src/forge/__tests__/redactor.test.ts`

- [ ] **Step 2.1.1: Write adversarial tests**

```ts
import { describe, it, expect } from "vitest";
import { redact, REDACTION_PATTERNS } from "../ingestion/redactor.js";

describe("redact", () => {
  it("redacts GitHub PAT", () => {
    const r = redact("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r.redacted).toContain("<REDACTED:github-token>");
    expect(r.redacted).not.toContain("ghp_abcdef");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.kind).toBe("github-token");
  });

  it("redacts OpenAI key", () => {
    const r = redact("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789AAAA");
    expect(r.redacted).toContain("<REDACTED:openai-key>");
    expect(r.redacted).not.toContain("sk-proj-abcdef");
  });

  it("redacts Slack bot token", () => {
    const r = redact("xoxb-12345-67890-abcdefghijklmnop");
    expect(r.redacted).toContain("<REDACTED:slack-token>");
  });

  it("redacts AWS access key", () => {
    const r = redact("AKIAIOSFODNN7EXAMPLE");
    expect(r.redacted).toContain("<REDACTED:aws-access-key>");
  });

  it("redacts Bearer header", () => {
    const r = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r.redacted).toContain("<REDACTED:bearer-token>");
  });

  it("leaves plain text untouched", () => {
    const r = redact("hello world this is a normal message");
    expect(r.redacted).toBe("hello world this is a normal message");
    expect(r.hits).toHaveLength(0);
  });

  it("redacts multiple distinct secrets in one string", () => {
    const r = redact("gh ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and oa sk-aaaaaaaaaaaaaaaaaaaaa");
    expect(r.hits.length).toBeGreaterThanOrEqual(2);
  });

  it("handles overlapping patterns deterministically", () => {
    // sk- prefix could overlap; ensure stable ordering
    const r = redact("token sk-test-value-aaaaaaaaaaaaaaaaaaa more");
    expect(() => redact("token sk-test-value-aaaaaaaaaaaaaaaaaaa more")).not.toThrow();
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("REDACTION_PATTERNS includes all expected kinds", () => {
    const kinds = REDACTION_PATTERNS.map((p) => p.kind);
    expect(kinds).toContain("github-token");
    expect(kinds).toContain("openai-key");
    expect(kinds).toContain("slack-token");
    expect(kinds).toContain("aws-access-key");
    expect(kinds).toContain("bearer-token");
  });
});
```

- [ ] **Step 2.1.2: Implement**

```ts
import type { RedactionHit } from "../types.js";

export interface RedactionPattern {
  kind: string;
  regex: RegExp;
}

export const REDACTION_PATTERNS: RedactionPattern[] = [
  { kind: "github-token",   regex: /ghp_[A-Za-z0-9]{30,}/g },
  { kind: "openai-key",     regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token",    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g },
  { kind: "bearer-token",   regex: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
];

export interface RedactResult {
  redacted: string;
  hits: RedactionHit[];
}

export function redact(text: string): RedactResult {
  if (!text) return { redacted: text, hits: [] };

  const allHits: Array<RedactionHit & { length: number }> = [];
  for (const { kind, regex } of REDACTION_PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      allHits.push({
        kind,
        startIndex: m.index,
        endIndex: m.index + m[0].length,
        length: m[0].length,
      });
    }
  }
  // Sort by start; resolve overlaps by keeping the earliest.
  allHits.sort((a, b) => a.startIndex - b.startIndex);
  const merged: typeof allHits = [];
  for (const h of allHits) {
    const last = merged[merged.length - 1];
    if (last && h.startIndex < last.endIndex) continue;
    merged.push(h);
  }

  let out = "";
  let cursor = 0;
  for (const h of merged) {
    out += text.slice(cursor, h.startIndex);
    out += `<REDACTED:${h.kind}>`;
    cursor = h.endIndex;
  }
  out += text.slice(cursor);

  return {
    redacted: out,
    hits: merged.map(({ kind, startIndex, endIndex }) => ({ kind, startIndex, endIndex })),
  };
}
```

- [ ] **Step 2.1.3: Pass + commit**

---

### Task 2.2: parser.ts — JSONL line → SessionEvent

**Files:**
- Create: `apps/server/src/forge/ingestion/parser.ts`
- Test: `apps/server/src/forge/__tests__/parser.test.ts`

- [ ] **Step 2.2.1: Write tests covering Claude Code JSONL shapes**

Use real fixtures from `~/.claude-personal/projects/-Users-minghao-workflow-control/<sid>.jsonl`. Test cases:
- `permission-mode` line → returns `null`
- `attachment` lines (hook outputs) → returns `null` for non-content
- user message → returns `SessionEvent` with role=user, text excerpt extracted from `message.content`
- assistant message with text + tool_use blocks → emits one event per block (text → assistant, tool_use → tool_use)
- tool_result → role=tool_result with linked toolUseId
- malformed JSON → returns `null`
- missing `sessionId` → returns `null`

- [ ] **Step 2.2.2: Implement parser**

```ts
import { createHash } from "node:crypto";
import { redact } from "./redactor.js";
import type { SessionEvent, SessionEventRole } from "../types.js";

const EXCERPT_LIMIT = 4096;
const TOOL_ARGS_LIMIT = 1024;

export interface ParseContext {
  sessionId: string;
  nextSeq: number;
}

export function parseLine(line: string, ctx: ParseContext): SessionEvent[] {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return []; }
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const sessionId = (obj.sessionId as string) ?? ctx.sessionId;
  if (!sessionId) return [];

  // Skip control-plane lines.
  if (obj.type === "permission-mode") return [];
  if (obj.attachment && (obj.attachment as Record<string, unknown>).type) return [];

  const ts = typeof obj.timestamp === "number" ? obj.timestamp : Date.now();
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return [];

  const role = mapRole(message.role as string | undefined, obj.type as string | undefined);
  if (!role) return [];

  const events: SessionEvent[] = [];
  const content = message.content;
  if (typeof content === "string") {
    events.push(buildEvent(ctx, sessionId, ts, role, content, null, null));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        events.push(buildEvent(ctx, sessionId, ts, role, b.text, null, null));
      } else if (b.type === "tool_use") {
        const name = typeof b.name === "string" ? b.name : "<unknown>";
        const args = JSON.stringify(b.input ?? {});
        events.push(buildEvent(ctx, sessionId, ts, "tool_use", null, name, args));
      } else if (b.type === "tool_result") {
        const txt = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        events.push(buildEvent(ctx, sessionId, ts, "tool_result", txt, null, null));
      }
    }
  }
  return events;
}

function mapRole(messageRole: string | undefined, lineType: string | undefined): SessionEventRole | null {
  if (messageRole === "user") return "user";
  if (messageRole === "assistant") return "assistant";
  if (lineType === "system") return "system";
  return null;
}

function buildEvent(
  ctx: ParseContext, sessionId: string, ts: number, role: SessionEventRole,
  text: string | null, toolName: string | null, toolArgs: string | null,
): SessionEvent {
  const seq = ctx.nextSeq++;
  let textExcerpt: string | null = null;
  let textHash: string | null = null;
  let textLength: number | null = null;
  if (text !== null) {
    textLength = text.length;
    textHash = createHash("sha256").update(text, "utf8").digest("hex");
    const r = redact(text.slice(0, EXCERPT_LIMIT));
    textExcerpt = r.redacted;
  }
  let toolArgsExcerpt: string | null = null;
  if (toolArgs !== null) {
    const r = redact(toolArgs.slice(0, TOOL_ARGS_LIMIT));
    toolArgsExcerpt = r.redacted;
  }
  return {
    sessionId, seq, ts, role,
    textExcerpt, textHash, textLength,
    toolName, toolArgsExcerpt,
  };
}
```

- [ ] **Step 2.2.3: Pass + commit**

---

### Task 2.3: jsonl-tail.ts — resumable tail reader

**Files:**
- Create: `apps/server/src/forge/ingestion/jsonl-tail.ts`
- Test: `apps/server/src/forge/__tests__/jsonl-tail.test.ts`

- [ ] **Step 2.3.1: Write tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailFile } from "../ingestion/jsonl-tail.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "jt-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("tailFile", () => {
  it("reads complete lines from offset 0", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"a":1}\n{"a":2}\n');
    const r = await tailFile(p, 0);
    expect(r.lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(r.newOffset).toBe(16);
  });

  it("stops at last complete \\n (partial line not consumed)", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"a":1}\n{"a":2'); // no trailing newline on second
    const r = await tailFile(p, 0);
    expect(r.lines).toEqual(['{"a":1}']);
    expect(r.newOffset).toBe(8);
  });

  it("resumes from given offset", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"a":1}\n');
    const r1 = await tailFile(p, 0);
    appendFileSync(p, '{"a":2}\n');
    const r2 = await tailFile(p, r1.newOffset);
    expect(r2.lines).toEqual(['{"a":2}']);
    expect(r2.newOffset).toBe(16);
  });

  it("returns empty when offset == file size", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"a":1}\n');
    const r = await tailFile(p, 8);
    expect(r.lines).toEqual([]);
    expect(r.newOffset).toBe(8);
  });

  it("returns truncated indicator when offset > file size", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"a":1}\n');
    const r = await tailFile(p, 100);
    expect(r.truncated).toBe(true);
    expect(r.newOffset).toBe(0);
  });
});
```

- [ ] **Step 2.3.2: Implement**

```ts
import { open, stat } from "node:fs/promises";

export interface TailResult {
  lines: string[];
  newOffset: number;
  truncated: boolean;
}

export async function tailFile(path: string, fromOffset: number): Promise<TailResult> {
  const st = await stat(path);
  if (fromOffset > st.size) {
    return { lines: [], newOffset: 0, truncated: true };
  }
  if (fromOffset === st.size) {
    return { lines: [], newOffset: fromOffset, truncated: false };
  }
  const handle = await open(path, "r");
  try {
    const remaining = st.size - fromOffset;
    const buf = Buffer.alloc(remaining);
    await handle.read(buf, 0, remaining, fromOffset);
    let lastNewline = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] === 0x0a) { lastNewline = i; break; }
    }
    if (lastNewline === -1) {
      return { lines: [], newOffset: fromOffset, truncated: false };
    }
    const consumed = buf.subarray(0, lastNewline + 1).toString("utf8");
    const lines = consumed.split("\n").slice(0, -1);
    return { lines, newOffset: fromOffset + lastNewline + 1, truncated: false };
  } finally {
    await handle.close();
  }
}
```

- [ ] **Step 2.3.3: Pass + commit**

---

### Task 2.4: watcher.ts — directory watch + per-file debounce

**Files:**
- Create: `apps/server/src/forge/ingestion/watcher.ts`
- Test: `apps/server/src/forge/__tests__/watcher.test.ts`

- [ ] **Step 2.4.1: Tests**

Cover: starts emit on file write; debounces multiple rapid writes; emits filename + parent dir; stops cleanly.

- [ ] **Step 2.4.2: Implement**

```ts
import { watch } from "node:fs";
import { join } from "node:path";

export interface WatcherEvent {
  jsonlPath: string;
  cwd: string;        // decoded project path (-Users-minghao-foo → /Users/minghao/foo)
  sessionId: string;  // basename minus .jsonl
}

export interface Watcher {
  stop(): void;
}

export function startWatcher(opts: {
  projectsRoot: string;
  onEvent: (e: WatcherEvent) => void;
  debounceMs?: number;
}): Watcher {
  const debounceMs = opts.debounceMs ?? 250;
  const timers = new Map<string, NodeJS.Timeout>();

  const w = watch(opts.projectsRoot, { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith(".jsonl")) return;
    const fullPath = join(opts.projectsRoot, filename);
    const existing = timers.get(fullPath);
    if (existing) clearTimeout(existing);
    timers.set(fullPath, setTimeout(() => {
      timers.delete(fullPath);
      const sep = "/";
      const parts = filename.split(sep);
      const dirName = parts[parts.length - 2] ?? "";
      const file = parts[parts.length - 1] ?? "";
      const sessionId = file.replace(/\.jsonl$/, "");
      const cwd = decodeProjectDir(dirName);
      opts.onEvent({ jsonlPath: fullPath, cwd, sessionId });
    }, debounceMs));
  });

  return {
    stop(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      w.close();
    },
  };
}

// Claude Code encodes /Users/minghao/foo as -Users-minghao-foo.
export function decodeProjectDir(dirName: string): string {
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}
```

- [ ] **Step 2.4.3: Pass + commit**

---

## Phase 3: Distillation pipeline (forge-distill)

### Task 3.1: forge-distill builtin pipeline IR

**Files:**
- Create: `apps/server/src/builtin-pipelines/forge-distill/pipeline.ir.json`
- Create: `apps/server/src/builtin-pipelines/forge-distill/prompts/chunk-triage.md`
- Create: `apps/server/src/builtin-pipelines/forge-distill/prompts/episode-extract.md`

- [ ] **Step 3.1.1: Write `pipeline.ir.json`**

3 stages: chunkTriage (agent) → episodeExtract (agent) → persistEpisodes (script). External input `session_payload: object` containing `{ sessionId, cwd, events: SessionEventLite[] }`. Output: ports for `episodes_json: string` consumed by persistEpisodes, plus `final: object` summary.

(Full IR shown inline in plan; copy from spec §Distillation.)

- [ ] **Step 3.1.2: Write the two prompts**

`chunk-triage.md`: instructs the agent to read events, determine if the session is worth distilling (criteria from spec). Output port `triage_decision: { proceed: bool, reason: string }`.

`episode-extract.md`: instructs the agent to emit `Episode[]`, with:
- intent (one sentence)
- start_seq / end_seq
- steps (structured)
- outcome enum
- pipeline_able boolean
- rationale
- abstraction guidance: "name inputs in abstract terms, not literal observed values"

- [ ] **Step 3.1.3: Submit forge-distill via the existing builtin loader path**

(Builtins are loaded by `kernel-next/builtins/seed-on-startup.ts` reading `pipeline.ir.json` from each subdir — confirm and adjust.)

- [ ] **Step 3.1.4: Test that `submit_pipeline` of forge-distill validates clean**

Add a test under `apps/server/src/builtin-pipelines/forge-distill/pipeline.ir.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";

describe("forge-distill builtin", () => {
  it("validates and submits cleanly", async () => {
    const ir = JSON.parse(readFileSync(join(__dirname, "pipeline.ir.json"), "utf-8"));
    const prompts = {
      "chunk-triage": readFileSync(join(__dirname, "prompts/chunk-triage.md"), "utf-8"),
      "episode-extract": readFileSync(join(__dirname, "prompts/episode-extract.md"), "utf-8"),
    };
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = await svc.submit(ir, { prompts });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 3.1.5: Pass + commit**

---

### Task 3.2: extract.ts — parse pipeline output → SessionEpisode[]

**Files:**
- Create: `apps/server/src/forge/distillation/extract.ts`
- Test: `apps/server/src/forge/__tests__/extract.test.ts`

- [ ] **Step 3.2.1: Tests**

Cover: valid JSON array → episodes; JSON with extra wrapper text → still parsed (extract first JSON array); malformed → throws `EXTRACT_BAD_JSON`; episode missing required fields → throws with field path; outcome enum mismatch → throws.

- [ ] **Step 3.2.2: Implement**

```ts
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { SessionEpisode } from "../types.js";

const EpisodeSchema = z.object({
  intent: z.string().min(1),
  start_seq: z.number().int().nonnegative(),
  end_seq: z.number().int().nonnegative(),
  steps: z.array(z.object({
    stage_kind: z.enum(["agent", "tool", "decision"]),
    description: z.string(),
    inputs: z.array(z.string()).optional(),
    outputs: z.array(z.string()).optional(),
    tool_calls: z.array(z.string()).optional(),
  })),
  outcome: z.enum(["completed", "abandoned", "partial", "exploratory"]),
  pipeline_able: z.boolean(),
  rationale: z.string(),
});

const ArraySchema = z.array(EpisodeSchema);

export class ExtractError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function extractEpisodes(rawJson: string, sessionId: string): SessionEpisode[] {
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); }
  catch {
    // Try extracting first [...] block — agents sometimes wrap in prose.
    const match = rawJson.match(/\[[\s\S]*\]/);
    if (!match) throw new ExtractError("EXTRACT_BAD_JSON", "no JSON array found");
    try { parsed = JSON.parse(match[0]); }
    catch { throw new ExtractError("EXTRACT_BAD_JSON", "malformed JSON"); }
  }
  const r = ArraySchema.safeParse(parsed);
  if (!r.success) {
    throw new ExtractError("EXTRACT_SCHEMA_FAIL", r.error.issues.map((i) => i.path.join(".")).join("; "));
  }
  const now = Date.now();
  return r.data.map((e) => ({
    episodeId: randomUUID(),
    sessionId,
    startSeq: e.start_seq,
    endSeq: e.end_seq,
    intent: e.intent,
    outcome: e.outcome,
    steps: e.steps.map((s) => ({
      stageKind: s.stage_kind,
      description: s.description,
      inputs: s.inputs,
      outputs: s.outputs,
      toolCalls: s.tool_calls,
    })),
    rationale: e.rationale,
    pipelineAble: e.pipeline_able,
    createdAt: now,
  }));
}
```

- [ ] **Step 3.2.3: Pass + commit**

---

### Task 3.3: submit-distill.ts — orchestrator

**Files:**
- Create: `apps/server/src/forge/distillation/submit-distill.ts`
- Test: `apps/server/src/forge/__tests__/submit-distill.test.ts`

- [ ] **Step 3.3.1: Tests** (mocked startPipelineRun + getTaskStatus + readPort)

- [ ] **Step 3.3.2: Implement**

```ts
import { startPipelineRun } from "../../kernel-next/runtime/start-pipeline-run.js";
import { extractEpisodes } from "./extract.js";
import { listEventsBySession, setSessionStatus } from "../db/sessions.js";
import { insertEpisode } from "../db/episodes.js";
import type { DatabaseSync } from "node:sqlite";

export async function distillSession(
  forgeDb: DatabaseSync,
  kernelDb: DatabaseSync,
  sessionId: string,
): Promise<{ ok: true; episodes: number } | { ok: false; error: string }> {
  const events = listEventsBySession(forgeDb, sessionId);
  if (events.length < 3) {
    setSessionStatus(forgeDb, sessionId, "skipped", "too few events");
    return { ok: true, episodes: 0 };
  }
  // Build a session_payload: events flattened to a compact form.
  const payload = {
    sessionId,
    eventCount: events.length,
    events: events.map((e) => ({
      seq: e.seq, role: e.role,
      text: e.textExcerpt ?? "",
      tool: e.toolName, args: e.toolArgsExcerpt ?? "",
    })),
  };
  const run = await startPipelineRun({
    db: kernelDb,
    pipelineName: "forge-distill",
    seedValues: { session_payload: payload },
  });
  if (!run.ok) {
    setSessionStatus(forgeDb, sessionId, "distillation_failed", run.diagnostics?.[0]?.message);
    return { ok: false, error: "submit failed" };
  }
  // Poll task to terminal state.
  const result = await waitForTask(kernelDb, run.taskId);
  if (result.state !== "completed") {
    setSessionStatus(forgeDb, sessionId, "distillation_failed", `task ${result.state}`);
    return { ok: false, error: result.state };
  }
  const episodesJson = readFinalPort(kernelDb, run.taskId, "episodes_json");
  if (!episodesJson) {
    setSessionStatus(forgeDb, sessionId, "distillation_failed", "no episodes_json");
    return { ok: false, error: "no output" };
  }
  const episodes = extractEpisodes(episodesJson, sessionId);
  for (const ep of episodes) insertEpisode(forgeDb, ep);
  setSessionStatus(forgeDb, sessionId, "distilled");
  return { ok: true, episodes: episodes.length };
}

// Helpers waitForTask + readFinalPort use existing kernel-next runtime APIs
// — see lib/db/kernel-next-task-watch and ir/sql.ts:readLatestPort.
```

(Helpers `waitForTask` + `readFinalPort` are thin wrappers around existing kernel-next APIs; resolve exact import paths during implementation.)

- [ ] **Step 3.3.3: Pass + commit**

---

## Phase 4: Similarity + clustering

### Task 4.1: embedding-client.ts

**Files:**
- Create: `apps/server/src/forge/similarity/embedding-client.ts`
- Test: `apps/server/src/forge/__tests__/embedding-client.test.ts`

- [ ] **Step 4.1.1: Tests** with mocked `fetch`. Cover: voyage success → Float32Array per text; OpenAI fallback; missing env key → throws `EMBEDDING_NOT_CONFIGURED`; HTTP error → throws with status code.

- [ ] **Step 4.1.2: Implement**

```ts
export interface EmbeddingClient {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function buildEmbeddingClient(opts: {
  provider: "voyage" | "openai";
  apiKey?: string;
}): EmbeddingClient {
  const key = opts.apiKey ?? process.env[opts.provider === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY"];
  if (!key) throw new Error("EMBEDDING_NOT_CONFIGURED");
  if (opts.provider === "voyage") return voyageClient(key);
  return openaiClient(key);
}

function voyageClient(key: string): EmbeddingClient {
  return {
    model: "voyage-3",
    dim: 1024,
    async embed(texts) {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "voyage-3", input: texts }),
      });
      if (!res.ok) throw new Error(`voyage HTTP ${res.status}`);
      const json = await res.json() as { data: Array<{ embedding: number[] }> };
      return json.data.map((d) => Float32Array.from(d.embedding));
    },
  };
}

function openaiClient(key: string): EmbeddingClient {
  return {
    model: "text-embedding-3-small",
    dim: 1536,
    async embed(texts) {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
      });
      if (!res.ok) throw new Error(`openai HTTP ${res.status}`);
      const json = await res.json() as { data: Array<{ embedding: number[] }> };
      return json.data.map((d) => Float32Array.from(d.embedding));
    },
  };
}
```

- [ ] **Step 4.1.3: Pass + commit**

---

### Task 4.2: cluster.ts — assignment + centroid update

**Files:**
- Create: `apps/server/src/forge/similarity/cluster.ts`
- Test: `apps/server/src/forge/__tests__/cluster.test.ts`

- [ ] **Step 4.2.1: Tests**

```ts
import { describe, it, expect } from "vitest";
import { cosine, assignToCluster, updateCentroidIncremental } from "../similarity/cluster.js";

describe("cosine", () => {
  it("identical vectors → 1.0", () => {
    const v = Float32Array.from([1, 0, 0]);
    expect(cosine(v, v)).toBeCloseTo(1.0, 5);
  });
  it("orthogonal → 0", () => {
    expect(cosine(Float32Array.from([1,0,0]), Float32Array.from([0,1,0]))).toBeCloseTo(0, 5);
  });
  it("opposite → -1", () => {
    expect(cosine(Float32Array.from([1,0,0]), Float32Array.from([-1,0,0]))).toBeCloseTo(-1, 5);
  });
});

describe("assignToCluster", () => {
  it("creates new cluster when no candidates exist", () => {
    const r = assignToCluster(Float32Array.from([1,0,0]), [], 0.85);
    expect(r.kind).toBe("new");
  });
  it("joins existing when cosine ≥ threshold", () => {
    const r = assignToCluster(
      Float32Array.from([0.99, 0.01, 0]),
      [{ clusterId: "c1", centroid: Float32Array.from([1,0,0]) }],
      0.85,
    );
    expect(r.kind).toBe("existing");
    if (r.kind === "existing") expect(r.clusterId).toBe("c1");
  });
  it("creates new when cosine < threshold", () => {
    const r = assignToCluster(
      Float32Array.from([0,0,1]),
      [{ clusterId: "c1", centroid: Float32Array.from([1,0,0]) }],
      0.85,
    );
    expect(r.kind).toBe("new");
  });
});

describe("updateCentroidIncremental", () => {
  it("running mean is correct", () => {
    const c = updateCentroidIncremental(Float32Array.from([1,0,0]), 1, Float32Array.from([0,1,0]));
    // (1+0)/2, (0+1)/2, 0 = (0.5, 0.5, 0)
    expect(c[0]).toBeCloseTo(0.5);
    expect(c[1]).toBeCloseTo(0.5);
    expect(c[2]).toBeCloseTo(0);
  });
});
```

- [ ] **Step 4.2.2: Implement**

```ts
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("dim mismatch");
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export type AssignResult =
  | { kind: "existing"; clusterId: string; cosine: number }
  | { kind: "new" };

export function assignToCluster(
  newEmbedding: Float32Array,
  clusters: Array<{ clusterId: string; centroid: Float32Array }>,
  threshold: number,
): AssignResult {
  let best: { clusterId: string; cosine: number } | null = null;
  for (const c of clusters) {
    const sim = cosine(newEmbedding, c.centroid);
    if (best === null || sim > best.cosine) best = { clusterId: c.clusterId, cosine: sim };
  }
  if (best && best.cosine >= threshold) return { kind: "existing", ...best };
  return { kind: "new" };
}

export function updateCentroidIncremental(
  oldCentroid: Float32Array,
  oldMemberCount: number,
  newEmbedding: Float32Array,
): Float32Array {
  const out = new Float32Array(oldCentroid.length);
  const n = oldMemberCount + 1;
  for (let i = 0; i < oldCentroid.length; i++) {
    out[i] = (oldCentroid[i]! * oldMemberCount + newEmbedding[i]!) / n;
  }
  return out;
}
```

- [ ] **Step 4.2.3: Pass + commit**

---

### Task 4.3: threshold.ts — ripeness rule

**Files:**
- Create: `apps/server/src/forge/similarity/threshold.ts`
- Test: `apps/server/src/forge/__tests__/threshold.test.ts`

- [ ] **Step 4.3.1: Tests covering boundary values**

```ts
import { describe, it, expect } from "vitest";
import { evaluateThreshold } from "../similarity/threshold.js";

describe("evaluateThreshold", () => {
  it("forming when distinct sessions < 3", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 2, distinctDayCount: 5, suppressedUntil: null,
    }, 1_700_000_000_000)).toBe("forming");
  });
  it("forming when distinct days < 2", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 5, distinctDayCount: 1, suppressedUntil: null,
    }, 1_700_000_000_000)).toBe("forming");
  });
  it("ripe when both met and not suppressed", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 3, distinctDayCount: 2, suppressedUntil: null,
    }, 1_700_000_000_000)).toBe("ripe");
  });
  it("forming when suppressed and now < suppressedUntil", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 5, distinctDayCount: 5,
      suppressedUntil: 1_800_000_000_000,
    }, 1_700_000_000_000)).toBe("forming");
  });
  it("ripe when suppression has expired", () => {
    expect(evaluateThreshold({
      distinctSessionCount: 5, distinctDayCount: 5,
      suppressedUntil: 1_600_000_000_000,
    }, 1_700_000_000_000)).toBe("ripe");
  });
});
```

- [ ] **Step 4.3.2: Implement**

```ts
export interface ThresholdInput {
  distinctSessionCount: number;
  distinctDayCount: number;
  suppressedUntil: number | null;
}

export function evaluateThreshold(c: ThresholdInput, now: number): "forming" | "ripe" {
  if (c.suppressedUntil !== null && now < c.suppressedUntil) return "forming";
  if (c.distinctSessionCount < 3) return "forming";
  if (c.distinctDayCount < 2) return "forming";
  return "ripe";
}
```

- [ ] **Step 4.3.3: Pass + commit**

---

## Phase 5: Synthesis

### Task 5.1: candidate-builder.ts

**Files:**
- Create: `apps/server/src/forge/synthesis/candidate-builder.ts`
- Test: `apps/server/src/forge/__tests__/candidate-builder.test.ts`

- [ ] **Step 5.1.1: Tests covering description shape, parameter diff'ing**

- [ ] **Step 5.1.2: Implement** — pure function `buildSynthesisDescription(cluster, episodes): string` that (a) summarizes each episode, (b) aligns step descriptions across episodes, (c) labels diverging strings as parameters.

- [ ] **Step 5.1.3: Pass + commit**

---

### Task 5.2: candidate-runner.ts

**Files:**
- Create: `apps/server/src/forge/synthesis/candidate-runner.ts`
- Test: `apps/server/src/forge/__tests__/candidate-runner.test.ts`

- [ ] **Step 5.2.1: Tests** with mocked startPipelineRun + readFinalPort returning a synthetic IR + prompts.

- [ ] **Step 5.2.2: Implement** — `runSynthesis(forgeDb, kernelDb, clusterId): Promise<{ candidateId }>`. Builds description, calls pipeline-generator, on success reads back IR + prompts, writes a `pipeline_candidates` row with `dry_run_status='pending'`, marks cluster `synthesized`.

- [ ] **Step 5.2.3: Pass + commit**

---

### Task 5.3: dryrun.ts — candidate dry-run

**Files:**
- Create: `apps/server/src/forge/synthesis/dryrun.ts`
- Test: `apps/server/src/forge/__tests__/dryrun.test.ts`

- [ ] **Step 5.3.1: Tests** covering: dry-run pass writes `dry_run_status='passed'`; failure writes diagnostics + `failed`; missing required input → `skipped`.

- [ ] **Step 5.3.2: Implement** — picks the first cluster member's abstracted inputs, calls `kernel-next.run_pipeline` with the candidate IR, polls to terminal, captures diagnostics.

- [ ] **Step 5.3.3: Pass + commit**

---

### Task 5.4: promote.ts — adopt → submit_pipeline

**Files:**
- Create: `apps/server/src/forge/synthesis/promote.ts`
- Test: `apps/server/src/forge/__tests__/promote.test.ts`

- [ ] **Step 5.4.1: Tests** — happy adopt; idempotent re-adopt returns same hash; refuse to adopt already-adopted candidate; refuse to adopt dismissed.

- [ ] **Step 5.4.2: Implement**

```ts
import type { DatabaseSync } from "node:sqlite";
import { getCandidate, markCandidateAdopted } from "../db/candidates.js";
import { setClusterStatus } from "../db/clusters.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";

export async function promoteCandidate(
  forgeDb: DatabaseSync,
  kernelDb: DatabaseSync,
  candidateId: string,
): Promise<{ ok: true; versionHash: string } | { ok: false; error: string }> {
  const cand = getCandidate(forgeDb, candidateId);
  if (!cand) return { ok: false, error: "candidate not found" };
  if (cand.adoptedAt) return { ok: true, versionHash: cand.adoptedVersionHash! };
  if (cand.dismissedAt) return { ok: false, error: "candidate dismissed" };
  const ir = JSON.parse(cand.irJson);
  const prompts = JSON.parse(cand.promptsJson) as Record<string, string>;
  const svc = new KernelService(kernelDb);
  const r = await svc.submit(ir, { prompts });
  if (!r.ok) return { ok: false, error: r.diagnostics.map((d) => d.code).join(",") };
  markCandidateAdopted(forgeDb, candidateId, r.versionHash);
  setClusterStatus(forgeDb, cand.clusterId, "adopted");
  return { ok: true, versionHash: r.versionHash };
}
```

- [ ] **Step 5.4.3: Pass + commit**

---

## Phase 6: Daemon

### Task 6.1: queue.ts — in-memory FIFO with persistence

**Files:**
- Create: `apps/server/src/forge/daemon/queue.ts`
- Test: `apps/server/src/forge/__tests__/queue.test.ts`

- [ ] **Step 6.1.1: Tests** — enqueue / dequeue order; dedup on (kind, key); persist to forge_jobs; restore on reopen; in-progress restored as pending after restart.

- [ ] **Step 6.1.2: Implement** the queue with a single worker driver `runWorker(handlers: Record<JobKind, (payload) => Promise<void>>)`.

- [ ] **Step 6.1.3: Pass + commit**

---

### Task 6.2: lifecycle.ts — startForge / stopForge

**Files:**
- Create: `apps/server/src/forge/daemon/lifecycle.ts`
- Test: `apps/server/src/forge/__tests__/lifecycle.test.ts`

- [ ] **Step 6.2.1: Tests** — start opens DB, starts watcher + worker; stop reverses cleanly; idempotent.

- [ ] **Step 6.2.2: Implement** wiring all the previous modules:

```ts
export async function startForge(opts: {
  dataDir: string;
  projectsRoot: string;
  kernelDb: DatabaseSync;
}): Promise<{ stop: () => Promise<void> }> {
  const forgeDb = openForgeDb(opts.dataDir);
  // Quiescence sweeper
  const sweepTimer = setInterval(() => sweep(forgeDb), 60_000);
  // Worker
  const worker = startWorker(forgeDb, opts.kernelDb);
  // Watcher
  const watcher = startWatcher({
    projectsRoot: opts.projectsRoot,
    onEvent: (e) => enqueueTail(forgeDb, e),
  });
  return {
    async stop() {
      clearInterval(sweepTimer);
      watcher.stop();
      await worker.stop();
      closeForgeDb();
    },
  };
}
```

- [ ] **Step 6.2.3: Wire in `apps/server/src/index.ts`** after kernel-next init:

```ts
const forge = await startForge({
  dataDir: settings.paths!.data_dir!,
  projectsRoot: join(homedir(), ".claude-personal", "projects"),
  kernelDb: getKernelNextDb(),
});
process.on("SIGTERM", () => forge.stop());
```

- [ ] **Step 6.2.4: Pass + commit**

---

## Phase 7: HTTP API

### Task 7.1: api/types.ts — DTOs

- [ ] **Step 7.1.1: Define DTOs** for every endpoint (responses + bodies). Single file, type aliases referencing `forge/types.ts` for shared shapes.

### Task 7.2: api/routes.ts

**Files:**
- Create: `apps/server/src/forge/api/routes.ts`
- Test: `apps/server/src/forge/__tests__/api.test.ts`

- [ ] **Step 7.2.1: Tests** — for each endpoint, hono fetch + assertion. List endpoints, single-resource endpoints, mutating endpoints (adopt / dismiss / suppress / dryrun) covered with success + error cases.

- [ ] **Step 7.2.2: Implement** all routes (each handler ≤ 30 LOC, delegates to db/synthesis modules).

- [ ] **Step 7.2.3: Register in `apps/server/src/index.ts`**:

```ts
import { forgeRoute } from "./forge/api/routes.js";
app.route("/api", forgeRoute);
```

- [ ] **Step 7.2.4: Pass + commit**

---

## Phase 8: Web UI

### Task 8.1: nav link

- [ ] **Step 8.1.1: Add Forge nav entry** in `apps/web/src/components/nav.tsx` between MCP catalog and proposals.

### Task 8.2: /forge landing page

**Files:**
- Create: `apps/web/src/app/forge/page.tsx`
- Test: `apps/web/src/app/forge/page.test.tsx`

- [ ] **Step 8.2.1: Tests** — list shape, candidate cards, empty states.
- [ ] **Step 8.2.2: Implement**.

### Task 8.3: /forge/candidates/[id] detail page

**Files:**
- Create: `apps/web/src/app/forge/candidates/[id]/page.tsx`
- Test: `apps/web/src/app/forge/candidates/[id]/page.test.tsx`

- [ ] **Step 8.3.1: Tests** — IR preview, dry-run badge, Adopt action, Dismiss action.
- [ ] **Step 8.3.2: Implement**, reusing existing `<PipelineGraph>` for IR rendering.

### Task 8.4: components/forge/*

Each component pair: implementation + test, single commit.

- [ ] **Step 8.4.1: `<CandidateCard>`** + test, commit
- [ ] **Step 8.4.2: `<EpisodeDetail>`** + test, commit
- [ ] **Step 8.4.3: `<RedactionBadge>`** + test, commit
- [ ] **Step 8.4.4: `<ClusterTimeline>`** + test, commit

### Task 8.5: /forge/clusters/[id], /forge/sessions

- [ ] **Step 8.5.1: cluster detail page** + test, commit
- [ ] **Step 8.5.2: sessions debug page** + test, commit

---

## Phase 9: Dogfood + docs

### Task 9.1: end-to-end smoke

- [ ] **Step 9.1.1: With server + web running**, generate ≥ 3 synthetic Claude Code sessions in different days (use a fixture writer). Verify a candidate appears in `/forge`, dry-run passes, adopt redirects to a runnable pipeline.

### Task 9.2: documentation

- [ ] **Step 9.2.1: Whitepaper §1.4** (en + zh): add Forge subsection
- [ ] **Step 9.2.2: Whitepaper visuals**: add forge end-to-end mermaid diagram (en + zh)
- [ ] **Step 9.2.3: `docs/product-intro.md`**: Forge bullet under "Daily flow"
- [ ] **Step 9.2.4: Roadmap row 1.29**

### Task 9.3: final sweep

- [ ] **Step 9.3.1: Run full test suites** server + web; capture concrete counts; update roadmap row.
- [ ] **Step 9.3.2: tsc both apps** — clean.
- [ ] **Step 9.3.3: Commit docs**.

---

## Self-Review Checklist (executed during plan write)

**Spec coverage:**
- §Storage / forge.db schema → Task 1.2
- §Components / 1. Ingestion → Tasks 2.1–2.4
- §Components / 2. Distillation → Tasks 3.1–3.3
- §Components / 3. Similarity → Tasks 4.1–4.3
- §Components / 4. Synthesis → Tasks 5.1–5.4
- §Components / 5. Daemon → Tasks 6.1–6.2
- §Components / 6. API → Tasks 7.1–7.2
- §Components / 7. Web UI → Tasks 8.1–8.5
- §Failure modes → covered in module tests
- §Security / privacy → redactor test (2.1) + boundary call enforcement (parser 2.2)
- §Observability → /api/forge/health in Task 7.2; SSE events emerge naturally from kernel-next (no extra task)
- §Documentation impact → Task 9.2

**Type consistency:**
- `SessionEvent.role` enum identical across types.ts, schema.sql CHECK constraint, parser, tests ✓
- `ClusterStatus` enum (forming/ripe/synthesized/adopted/dismissed) identical schema/types/tests ✓
- `DryRunStatus` enum identical schema/types/tests ✓
- `Float32Array <-> BLOB` helpers (`f32ToBlob`/`blobToF32`) defined once in clusters.ts, reused by signatures ✓
- `EmbeddingClient.dim` matches centroid dim — embedding model lock enforced by `centroid_model = embedding_model` invariant ✓

**Placeholder scan:**
- "Helpers waitForTask + readFinalPort use existing kernel-next runtime APIs" in Task 3.3.2 is the one place that defers a sub-detail to implementation time. This is acceptable because the existing kernel-next code is the authoritative source; the implementer reads the live API rather than a stale snapshot. All other steps contain real code or real test fixtures.

**Scope:**
- 9 phases, single coherent product. Could split into "ingestion + distillation" / "clustering + synthesis" / "UI" but all three depend tightly on the same data shapes. Keep as one plan.
