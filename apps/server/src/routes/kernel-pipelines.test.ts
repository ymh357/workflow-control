// Tests for kernel-pipelines inventory routes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { diamondIR } from "../kernel-next/generator-mock/mini-generator.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelPipelinesRoute } from "./kernel-pipelines.js";

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelPipelinesRoute);
  return app;
}

describe("GET /api/kernel/pipelines", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    __setKernelNextDbForTest(undefined);
    db.close();
  });

  it("returns empty list when no pipelines exist", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pipelines: [] });
  });

  it("returns pipelines with their latest version", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines"));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      pipelines: Array<{ name: string; latestVersion: string; latestCreatedAt: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.pipelines).toHaveLength(1);
    expect(body.pipelines[0]!.name).toBe(diamondIR().name);
    expect(body.pipelines[0]!.latestVersion).toBe(submitted.versionHash);
  });

  it("returns the newest version when multiple versions exist for one pipeline", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const first = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!first.ok) throw new Error("submit 1 failed");

    const firstPromptRef = Object.keys(diamondPrompts())[0]!;
    const proposed = svc.propose({
      currentVersion: first.versionHash,
      patch: { ops: [] },
      actor: "ai:test",
      prompts: { [firstPromptRef]: "updated body" },
    });
    if (!proposed.ok) throw new Error("propose failed");

    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines"));
    const body = await res.json() as {
      ok: boolean;
      pipelines: Array<{ name: string; latestVersion: string }>;
    };
    expect(body.pipelines).toHaveLength(1);
    expect(body.pipelines[0]!.latestVersion).toBe(proposed.proposedVersion);
  });
});

describe("GET /api/kernel/pipelines/:versionHash", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    __setKernelNextDbForTest(undefined);
    db.close();
  });

  it("returns 404 for unknown version", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/deadbeef"));
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("VERSION_NOT_FOUND");
  });

  it("returns ir + prompts + parentHash + createdAt for a known version", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://t/api/kernel/pipelines/${encodeURIComponent(submitted.versionHash)}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      ir: { name: string; stages: Array<{ name: string; type: string }> };
      prompts: Record<string, string>;
      parentHash: string | null;
      createdAt: number;
    };
    expect(body.ok).toBe(true);
    expect(body.ir.name).toBe(diamondIR().name);
    expect(Object.keys(body.prompts).length).toBe(Object.keys(diamondPrompts()).length);
    expect(body.parentHash).toBeNull();
    expect(body.createdAt).toBeGreaterThan(0);
  });
});

describe("REST POST /api/kernel/pipelines/env-probe", () => {
  it("reports per-key process.env presence without leaking values", async () => {
    process.env.WFCTL_TEST_PRESENT = "real-value";
    delete process.env.WFCTL_TEST_ABSENT;
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/env-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envKeys: ["WFCTL_TEST_PRESENT", "WFCTL_TEST_ABSENT"] }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: true; status: Record<string, boolean> };
    expect(body.ok).toBe(true);
    expect(body.status.WFCTL_TEST_PRESENT).toBe(true);
    expect(body.status.WFCTL_TEST_ABSENT).toBe(false);
    expect(JSON.stringify(body)).not.toContain("real-value");
    delete process.env.WFCTL_TEST_PRESENT;
  });

  it("treats empty-string env values as absent", async () => {
    process.env.WFCTL_TEST_EMPTY = "";
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/env-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envKeys: ["WFCTL_TEST_EMPTY"] }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: Record<string, boolean> };
    expect(body.status.WFCTL_TEST_EMPTY).toBe(false);
    delete process.env.WFCTL_TEST_EMPTY;
  });

  it("returns 400 on missing envKeys array", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/env-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed JSON", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/env-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    }));
    expect(res.status).toBe(400);
  });
});
