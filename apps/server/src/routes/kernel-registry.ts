// Registry HTTP surface — exposes RegistryService to the web UI.
//
// Routes:
//   GET    /api/registry/index             — full index of remote+local packages
//   GET    /api/registry/packages/:name    — manifest for one package
//   GET    /api/registry/installed         — packages currently installed (lock file view)
//   GET    /api/registry/outdated          — installed packages with newer versions remote
//   POST   /api/registry/install           — { packages: string[], force?: boolean }
//   POST   /api/registry/uninstall         — { packages: string[] }
//   POST   /api/registry/update            — { name?: string }
//   POST   /api/registry/publish           — { name: string, type: string }
//
// Local single-user posture: same as the rest of kernel-next HTTP. No
// auth; everything runs in the user's own server process.

import { Hono } from "hono";
import { z } from "zod";
import { registryService } from "../services/registry-service.js";

export const kernelRegistryRoute = new Hono();

kernelRegistryRoute.get("/registry/index", async (c) => {
  try {
    const index = await registryService.getIndex();
    return c.json({ ok: true, index });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, diagnostics: [{ code: "REGISTRY_INDEX_FAILED", message }] }, 502);
  }
});

kernelRegistryRoute.get("/registry/packages/:name", async (c) => {
  const name = c.req.param("name");
  try {
    const manifest = await registryService.getManifest(name);
    return c.json({ ok: true, manifest });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, diagnostics: [{ code: "PACKAGE_MANIFEST_FAILED", message }] }, 404);
  }
});

kernelRegistryRoute.get("/registry/installed", (c) => {
  const type = c.req.query("type") ?? undefined;
  const installed = registryService.listInstalled(type);
  // Convert Record<name, entry> to array form so the web client can
  // sort + filter without object-iteration semantics.
  const packages = Object.entries(installed).map(([name, entry]) => ({
    name,
    version: entry.version,
    type: entry.type,
    author: entry.author,
    installedAt: entry.installed_at,
    files: entry.files,
  }));
  return c.json({ ok: true, packages });
});

kernelRegistryRoute.get("/registry/outdated", async (c) => {
  try {
    const outdated = await registryService.checkOutdated();
    return c.json({ ok: true, outdated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, diagnostics: [{ code: "REGISTRY_OUTDATED_FAILED", message }] }, 502);
  }
});

const installBodySchema = z.object({
  packages: z.array(z.string().min(1)).min(1),
  force: z.boolean().optional(),
}).strict();

kernelRegistryRoute.post("/registry/install", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, diagnostics: [{ code: "INVALID_JSON_BODY", message: "invalid JSON body" }] }, 400);
  }
  const parsed = installBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      diagnostics: parsed.error.issues.map((i) => ({
        code: "INVALID_REQUEST_BODY",
        message: `${i.path.join(".") || "<root>"}: ${i.message}`,
      })),
    }, 400);
  }
  try {
    const result = await registryService.install(parsed.data.packages, { force: parsed.data.force });
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, diagnostics: [{ code: "INSTALL_FAILED", message }] }, 500);
  }
});

const uninstallBodySchema = z.object({
  packages: z.array(z.string().min(1)).min(1),
}).strict();

kernelRegistryRoute.post("/registry/uninstall", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, diagnostics: [{ code: "INVALID_JSON_BODY", message: "invalid JSON body" }] }, 400);
  }
  const parsed = uninstallBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      diagnostics: parsed.error.issues.map((i) => ({
        code: "INVALID_REQUEST_BODY",
        message: `${i.path.join(".") || "<root>"}: ${i.message}`,
      })),
    }, 400);
  }
  try {
    const result = await registryService.uninstall(parsed.data.packages);
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, diagnostics: [{ code: "UNINSTALL_FAILED", message }] }, 500);
  }
});

const updateBodySchema = z.object({
  name: z.string().min(1).optional(),
}).strict();

kernelRegistryRoute.post("/registry/update", async (c) => {
  let body: unknown = {};
  const raw = await c.req.text();
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ ok: false, diagnostics: [{ code: "INVALID_JSON_BODY", message: "invalid JSON body" }] }, 400);
    }
  }
  const parsed = updateBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      diagnostics: parsed.error.issues.map((i) => ({
        code: "INVALID_REQUEST_BODY",
        message: `${i.path.join(".") || "<root>"}: ${i.message}`,
      })),
    }, 400);
  }
  try {
    const result = await registryService.update(parsed.data.name);
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, diagnostics: [{ code: "UPDATE_FAILED", message }] }, 500);
  }
});

const publishBodySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
}).strict();

kernelRegistryRoute.post("/registry/publish", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, diagnostics: [{ code: "INVALID_JSON_BODY", message: "invalid JSON body" }] }, 400);
  }
  const parsed = publishBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      diagnostics: parsed.error.issues.map((i) => ({
        code: "INVALID_REQUEST_BODY",
        message: `${i.path.join(".") || "<root>"}: ${i.message}`,
      })),
    }, 400);
  }
  try {
    const result = await registryService.publish(parsed.data.name, parsed.data.type);
    if (!result.success) {
      return c.json({ ok: false, diagnostics: [{ code: "PUBLISH_FAILED", message: result.message }] }, 400);
    }
    return c.json({ ok: true, message: result.message });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, diagnostics: [{ code: "PUBLISH_FAILED", message }] }, 500);
  }
});

