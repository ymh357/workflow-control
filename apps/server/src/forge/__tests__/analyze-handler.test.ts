// Tests for the analyze handler. We don't run the real distillation
// (would require a Claude SDK call); instead we verify the handler's
// branching logic by short-circuiting at distill time.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { initForgeSchema } from "../db/schema.js";
import { analyze } from "../api/analyze-handler.js";

let kernelDb: DatabaseSync;
let forgeDb: DatabaseSync;
let dir: string;

beforeEach(() => {
  kernelDb = new DatabaseSync(":memory:");
  initKernelNextSchema(kernelDb);
  forgeDb = new DatabaseSync(":memory:");
  initForgeSchema(forgeDb);
  dir = mkdtempSync(join(tmpdir(), "fa-"));
});

describe("analyze", () => {
  it("returns NO_SESSION_FOUND when no source provided and projects-root empty", async () => {
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir },
      {},
    );
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("NO_SESSION_FOUND");
  });

  it("returns LOAD_FAILED when jsonlPath does not exist", async () => {
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir },
      { jsonlPath: "/path/does/not/exist.jsonl" },
    );
    expect(r.kind).toBe("error");
  });

  it("returns no-pattern when session has too few events", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const p = join(projDir, "abc.jsonl");
    writeFileSync(p,
      JSON.stringify({ sessionId: "abc", message: { role: "user", content: "hi" } }) + "\n",
    );
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distillTimeoutMs: 1000, distillPollIntervalMs: 10 },
      { jsonlPath: p },
    );
    // 1 event < 3 → distill returns empty episodes → no-pattern
    expect(r.kind).toBe("no-pattern");
  });

  it("returns DISTILL_SUBMIT_FAILED when forge-distill not registered AND session has enough events", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const p = join(projDir, "abc.jsonl");
    const lines = [
      { sessionId: "abc", message: { role: "user", content: "first message" } },
      { sessionId: "abc", message: { role: "assistant", content: "responding" } },
      { sessionId: "abc", message: { role: "user", content: "follow up" } },
      { sessionId: "abc", message: { role: "assistant", content: "more help" } },
    ];
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distillTimeoutMs: 1000, distillPollIntervalMs: 10 },
      { jsonlPath: p },
    );
    // forge-distill builtin is not submitted to kernelDb → distill submit fails.
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("DISTILL_SUBMIT_FAILED");
  });

  it("auto-detects most recent session under projects-root when no input provided", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const p = join(projDir, "abc.jsonl");
    writeFileSync(p,
      JSON.stringify({ sessionId: "abc", message: { role: "user", content: "hi" } }) + "\n",
    );
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distillTimeoutMs: 1000, distillPollIntervalMs: 10 },
      {}, // no sessionId, no jsonlPath
    );
    expect(r.kind).toBe("no-pattern");
    if (r.kind === "no-pattern") expect(r.jsonlPath).toBe(p);
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
