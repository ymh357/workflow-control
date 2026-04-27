import { Hono, type Context } from "hono";
import type { DatabaseSync } from "node:sqlite";
import {
  listEntries,
  getEntry,
  upsertCustomEntry,
  deleteCustomEntry,
} from "../kernel-next/mcp-catalog/catalog-store.js";
import { CatalogEntrySchema } from "../kernel-next/mcp-catalog/schema.js";
import { recommendForTopicLocal, recommendForTopicWithLLM } from "../kernel-next/mcp-catalog/recommender.js";
import { z } from "zod";
import {
  listInventory,
  getInventoryStatus,
  listSecretReadoutsPublic,
  equipEntry,
  unequipEntry,
  recheckEntry,
} from "../kernel-next/mcp-catalog/inventory.js";
import type { ExecFn } from "../kernel-next/mcp-catalog/healthcheck.js";

const recommendBodySchema = z.object({
  topic: z.string().min(1).max(4096),
  excludeIds: z.array(z.string()).optional(),
  withLLM: z.boolean().optional(),
  maxResults: z.number().int().positive().max(50).optional(),
}).strict();

const equipBodySchema = z.object({
  entryId: z.string().min(1),
  envValues: z.record(z.string(), z.string()).optional(),
  healthCheckTimeoutMs: z.number().int().positive().optional(),
}).strict();

const entryIdBodySchema = z.object({
  entryId: z.string().min(1),
}).strict();

function badRequest(c: Context, code: string, message: string, context?: Record<string, unknown>) {
  return c.json({ ok: false, diagnostics: [{ code, message, ...(context ? { context } : {}) }] }, 400);
}

/**
 * Factory so tests can inject a custom DB getter.
 * In production, getKernelNextDb is used.
 */
export interface KernelMcpCatalogRouteOptions {
  exec?: ExecFn;
  processEnv?: NodeJS.ProcessEnv;
}

export function createKernelMcpCatalogRoute(
  getDb: () => DatabaseSync,
  options: KernelMcpCatalogRouteOptions = {},
): Hono {
  const route = new Hono();

  route.get("/kernel/mcp-catalog/entries", (c) => {
    const sourceParam = c.req.query("source");
    const includeDeprecated = c.req.query("includeDeprecated") === "true";

    if (sourceParam !== undefined && !["builtin", "custom", "all"].includes(sourceParam)) {
      return badRequest(c, "INVALID_REQUEST_BODY",
        "source must be 'builtin', 'custom', or 'all'", { received: sourceParam });
    }

    const entries = listEntries(getDb(), {
      source: sourceParam as "builtin" | "custom" | "all" | undefined,
      includeDeprecated,
    });
    return c.json({ ok: true, entries });
  });

  route.get("/kernel/mcp-catalog/entries/:id", (c) => {
    const id = c.req.param("id");
    const entry = getEntry(getDb(), id);
    if (!entry) {
      return c.json({
        ok: false,
        diagnostics: [{
          code: "CATALOG_ENTRY_NOT_FOUND",
          message: `entry '${id}' not found`,
          context: { id },
        }],
      }, 404);
    }
    return c.json({ ok: true, entry });
  });

  route.post("/kernel/mcp-catalog/entries", async (c) => {
    const raw = await c.req.text();
    if (raw.trim().length === 0) {
      return badRequest(c, "INVALID_REQUEST_BODY", "request body required");
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest(c, "INVALID_JSON_BODY", "invalid JSON");
    }
    // Force source='custom' before validation (clients may omit or set 'builtin' incorrectly)
    const candidate = { ...(body as object), source: "custom" };
    const parsed = CatalogEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      return c.json({
        ok: false,
        diagnostics: [{
          code: "CATALOG_INVALID_ENTRY",
          message: parsed.error.issues[0]?.message ?? "invalid entry",
          context: { path: parsed.error.issues[0]?.path },
        }],
      }, 400);
    }

    const result = upsertCustomEntry(getDb(), parsed.data);
    if (!result.ok) {
      const code = result.diagnostics[0].code;
      const status = code === "CATALOG_ENTRY_ID_CONFLICT" ? 409 : 400;
      return c.json(result, status);
    }
    return c.json({ ok: true, entry: result.entry }, 201);
  });

  route.put("/kernel/mcp-catalog/entries/:id", async (c) => {
    const id = c.req.param("id");
    const existing = getEntry(getDb(), id);
    if (existing && existing.source === "builtin") {
      return c.json({
        ok: false,
        diagnostics: [{
          code: "CATALOG_BUILTIN_NOT_WRITABLE",
          message: "builtin entries can only be modified via the seed JSON",
          context: { id },
        }],
      }, 409);
    }
    if (!existing) {
      return c.json({
        ok: false,
        diagnostics: [{
          code: "CATALOG_ENTRY_NOT_FOUND",
          message: `entry '${id}' not found`,
          context: { id },
        }],
      }, 404);
    }

    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest(c, "INVALID_JSON_BODY", "invalid JSON");
    }
    const candidate = { ...(body as object), id, source: "custom" };
    const parsed = CatalogEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      return c.json({
        ok: false,
        diagnostics: [{
          code: "CATALOG_INVALID_ENTRY",
          message: parsed.error.issues[0]?.message ?? "invalid entry",
          context: { path: parsed.error.issues[0]?.path },
        }],
      }, 400);
    }

    const result = upsertCustomEntry(getDb(), parsed.data);
    if (!result.ok) return c.json(result, 400);
    return c.json({ ok: true, entry: result.entry });
  });

  route.delete("/kernel/mcp-catalog/entries/:id", (c) => {
    const id = c.req.param("id");
    const result = deleteCustomEntry(getDb(), id);
    if (!result.ok) {
      const code = result.diagnostics[0].code;
      const status =
        code === "CATALOG_ENTRY_NOT_FOUND" ? 404 :
        code === "CATALOG_BUILTIN_NOT_WRITABLE" ? 409 : 400;
      return c.json(result, status);
    }
    return c.json({ ok: true });
  });

  route.post("/kernel/mcp-catalog/recommend", async (c) => {
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest(c, "INVALID_JSON_BODY", "invalid JSON");
    }
    const parsed = recommendBodySchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(c, "INVALID_REQUEST_BODY",
        parsed.error.issues[0]?.message ?? "bad request",
        { path: parsed.error.issues[0]?.path });
    }

    if (parsed.data.withLLM) {
      const result = await recommendForTopicWithLLM(getDb(), parsed.data.topic, {
        excludeIds: parsed.data.excludeIds,
        maxResults: parsed.data.maxResults,
      });
      return c.json({
        ok: true,
        recommendations: result.recommendations,
        ...(result.warnings ? { warnings: result.warnings } : {}),
      });
    }

    const recs = recommendForTopicLocal(getDb(), parsed.data.topic, {
      excludeIds: parsed.data.excludeIds,
      maxResults: parsed.data.maxResults,
    });
    return c.json({ ok: true, recommendations: recs });
  });

  const buildDeps = () => ({
    db: getDb(),
    exec: options.exec,
    processEnv: options.processEnv,
  });

  route.get("/kernel/mcp-catalog/inventory", (c) => {
    const db = getDb();
    const rows = listInventory(db);
    const readouts: Record<string, ReturnType<typeof listSecretReadoutsPublic>> = {};
    for (const r of rows) {
      readouts[r.entryId] = listSecretReadoutsPublic(db, r.entryId);
    }
    return c.json({ ok: true, rows, readouts });
  });

  route.get("/kernel/mcp-catalog/inventory/:entryId", (c) => {
    const db = getDb();
    const entryId = c.req.param("entryId");
    const row = getInventoryStatus(db, entryId);
    const readouts = listSecretReadoutsPublic(db, entryId);
    return c.json({ ok: true, row, readouts });
  });

  route.post("/kernel/mcp-catalog/equip", async (c) => {
    const raw = await c.req.text();
    if (raw.trim().length === 0) return badRequest(c, "INVALID_REQUEST_BODY", "request body required");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return badRequest(c, "INVALID_JSON_BODY", "invalid JSON"); }
    const parsed = equipBodySchema.safeParse(body);
    if (!parsed.success) return badRequest(c, "INVALID_REQUEST_BODY",
      parsed.error.issues[0]?.message ?? "bad request");

    const result = await equipEntry(buildDeps(), {
      entryId: parsed.data.entryId,
      envValues: parsed.data.envValues ?? {},
      healthCheckTimeoutMs: parsed.data.healthCheckTimeoutMs,
    });
    if (!result.ok) {
      const code = result.diagnostics[0].code;
      const status = code === "CATALOG_ENTRY_NOT_FOUND" ? 404 : 400;
      return c.json(result, status);
    }
    return c.json(result);
  });

  // Idempotent: unequipping an already-not-equipped entry returns ok:true.
  // This matches the user-mental-model "make sure this is unequipped" rather
  // than a strict resource lifecycle. Distinct from DELETE /entries/:id which
  // returns 404 for unknown ids.
  route.post("/kernel/mcp-catalog/unequip", async (c) => {
    const raw = await c.req.text();
    if (raw.trim().length === 0) return badRequest(c, "INVALID_REQUEST_BODY", "request body required");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return badRequest(c, "INVALID_JSON_BODY", "invalid JSON"); }
    const parsed = entryIdBodySchema.safeParse(body);
    if (!parsed.success) return badRequest(c, "INVALID_REQUEST_BODY",
      parsed.error.issues[0]?.message ?? "bad request");

    const result = unequipEntry(getDb(), parsed.data.entryId);
    return c.json(result);
  });

  route.post("/kernel/mcp-catalog/recheck", async (c) => {
    const raw = await c.req.text();
    if (raw.trim().length === 0) return badRequest(c, "INVALID_REQUEST_BODY", "request body required");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return badRequest(c, "INVALID_JSON_BODY", "invalid JSON"); }
    const parsed = entryIdBodySchema.safeParse(body);
    if (!parsed.success) return badRequest(c, "INVALID_REQUEST_BODY",
      parsed.error.issues[0]?.message ?? "bad request");

    const result = await recheckEntry(buildDeps(), parsed.data.entryId);
    if (!result.ok) {
      const code = result.diagnostics[0].code;
      const status = code === "CATALOG_ENTRY_NOT_FOUND" ? 404 : 400;
      return c.json(result, status);
    }
    return c.json(result);
  });

  route.get("/kernel/mcp-catalog/lookup-by-envkey", (c) => {
    const names = (c.req.query("names") ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (names.length === 0) return c.json({ ok: true, mapping: {}, statuses: {} });
    const db = getDb();
    const allEntries = listEntries(db, { source: "all", includeDeprecated: false });

    const mapping: Record<string, string | null> = {};
    for (const n of names) mapping[n] = null;

    for (const entry of allEntries) {
      for (const k of entry.envKeys) {
        if (Object.prototype.hasOwnProperty.call(mapping, k.name) && mapping[k.name] === null) {
          mapping[k.name] = entry.id;
        }
      }
    }

    const statuses: Record<string, string> = {};
    for (const eid of Object.values(mapping)) {
      if (typeof eid === "string") {
        const inv = getInventoryStatus(db, eid);
        statuses[eid] = inv?.status ?? "not-equipped";
      }
    }
    return c.json({ ok: true, mapping, statuses });
  });

  return route;
}
