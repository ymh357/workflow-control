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

describe("GET /api/kernel/pipelines/:versionHash/export", () => {
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

  it("returns a v1 envelope for an existing version", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const app = buildApp();
    const res = await app.fetch(new Request(
      `http://t/api/kernel/pipelines/${submitted.versionHash}/export`,
    ));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain("attachment");
    expect(cd).toContain("filename=");

    const body = await res.json() as Record<string, unknown>;
    expect(body.format).toBe("wfctl-pipeline-export/v1");
    expect(body.source).toMatchObject({
      pipelineName: diamondIR().name,
      versionHash: submitted.versionHash,
    });
    expect(body.ir).toBeDefined();
    // submit() normalizes prompt content (trailing LF added by
    // normalizePromptContent in canonical.ts), so the export reflects
    // the stored normalized form, not the input string.
    const expectedPrompts: Record<string, string> = {};
    for (const [k, v] of Object.entries(diamondPrompts())) {
      expectedPrompts[k] = v.endsWith("\n") ? v : v + "\n";
    }
    expect(body.prompts).toEqual(expectedPrompts);
  });

  it("returns 404 VERSION_NOT_FOUND for an unknown hash", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request(
      "http://t/api/kernel/pipelines/" + "0".repeat(64) + "/export",
    ));
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("VERSION_NOT_FOUND");
  });

  it("sanitizes pipeline name in Content-Disposition filename", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = { ...diamondIR(), name: "Weird/Name With Spaces!" };
    const submitted = await svc.submit(ir, { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const app = buildApp();
    const res = await app.fetch(new Request(
      `http://t/api/kernel/pipelines/${submitted.versionHash}/export`,
    ));
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toMatch(/filename="weird-name-with-spaces-[a-f0-9]{8}\.wfctl\.json"/);
  });
});

describe("POST /api/kernel/pipelines/import", () => {
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

  async function buildEnvelopeJson(): Promise<{
    envelope: Record<string, unknown>;
    sourceVersionHash: string;
  }> {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");
    const app = buildApp();
    const res = await app.fetch(new Request(
      `http://t/api/kernel/pipelines/${submitted.versionHash}/export`,
    ));
    const env = await res.json() as Record<string, unknown>;
    return { envelope: env, sourceVersionHash: submitted.versionHash };
  }

  it("imports a valid envelope into a fresh DB", async () => {
    const { envelope } = await buildEnvelopeJson();
    // Fresh DB to simulate a different machine.
    db.close();
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);

    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      versionHash: string;
      pipelineName: string;
      alreadyExisted: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.pipelineName).toBe(diamondIR().name);
    expect(body.versionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.alreadyExisted).toBe(false);

    const row = db.prepare(
      `SELECT version_hash FROM pipeline_versions WHERE version_hash = ?`,
    ).get(body.versionHash);
    expect(row).toBeDefined();
  });

  it("returns alreadyExisted=true on duplicate import", async () => {
    const { envelope, sourceVersionHash } = await buildEnvelopeJson();
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      versionHash: string;
      alreadyExisted: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.versionHash).toBe(sourceVersionHash);
    expect(body.alreadyExisted).toBe(true);
  });

  it("rejects non-JSON body with INVALID_JSON_BODY", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json {",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_JSON_BODY");
  });

  it("rejects wrong format literal with UNSUPPORTED_FORMAT", async () => {
    const { envelope } = await buildEnvelopeJson();
    envelope.format = "wfctl-pipeline-export/v2";
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("passes through submit diagnostics for missing prompts", async () => {
    const { envelope } = await buildEnvelopeJson();
    envelope.prompts = {};  // strip prompts; AgentStage promptRefs become unsatisfied
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics.some((d) => d.code === "PROMPT_REF_MISSING")).toBe(true);
  });

  it("rejects unknown top-level fields with INVALID_ENVELOPE", async () => {
    const { envelope } = await buildEnvelopeJson();
    (envelope as Record<string, unknown>).extra = "junk";
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_ENVELOPE");
  });

  it("rejects empty body with INVALID_JSON_BODY", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/pipelines/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_JSON_BODY");
  });
});
