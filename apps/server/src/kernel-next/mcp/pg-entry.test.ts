import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { handleStartPipelineGenerator } from "./pg-entry.js";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

describe("handleStartPipelineGenerator — input validation", () => {
  it("rejects empty description", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const res = await handleStartPipelineGenerator(
      { description: "" },
      { db, broadcaster, runner: vi.fn() as any, loader: vi.fn() as any, model: "claude-haiku-4-5" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("INVALID_DESCRIPTION");
    if (res.error === "INVALID_DESCRIPTION") {
      expect(res.reason).toBe("empty");
    }
  });

  it("rejects whitespace-only description", async () => {
    const db = freshDb();
    const res = await handleStartPipelineGenerator(
      { description: "   \n\t  " },
      { db, broadcaster: new KernelNextBroadcaster(), runner: vi.fn() as any, loader: vi.fn() as any, model: "m" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("INVALID_DESCRIPTION");
  });

  it("rejects description over 8000 chars", async () => {
    const db = freshDb();
    const res = await handleStartPipelineGenerator(
      { description: "x".repeat(8001) },
      { db, broadcaster: new KernelNextBroadcaster(), runner: vi.fn() as any, loader: vi.fn() as any, model: "m" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("INVALID_DESCRIPTION");
    if (res.error === "INVALID_DESCRIPTION") {
      expect(res.reason).toBe("too_long");
    }
  });
});
