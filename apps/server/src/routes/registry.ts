import { Hono } from "hono";
import { z } from "zod";
import { registryService } from "../services/registry-service.js";
import { validateBody, getValidatedBody } from "../middleware/validate.js";
import { errorResponse, ErrorCode } from "../lib/error-response.js";

const installSchema = z.object({
  packages: z.array(z.string().min(1)).min(1),
});

const uninstallSchema = z.object({
  packages: z.array(z.string().min(1)).min(1),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
});

const publishSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
});

export const registryRoute = new Hono();

registryRoute.get("/registry/index", async (c) => {
  try {
    const index = await registryService.getIndex();
    return c.json(index);
  } catch (err) {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
});

registryRoute.get("/registry/search", async (c) => {
  try {
    const q = c.req.query("q");
    const type = c.req.query("type");
    const results = await registryService.search(q || undefined, type || undefined);
    return c.json({ packages: results });
  } catch (err) {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
});

registryRoute.get("/registry/packages/:name", async (c) => {
  try {
    const name = c.req.param("name");
    const manifest = await registryService.getManifest(name);
    return c.json(manifest);
  } catch (err) {
    return errorResponse(c, 404, ErrorCode.FILE_NOT_FOUND, (err as Error).message);
  }
});

registryRoute.get("/registry/installed", (c) => {
  try {
    const type = c.req.query("type");
    const installed = registryService.listInstalled(type || undefined);
    return c.json({ packages: installed });
  } catch (err) {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
});

registryRoute.get("/registry/outdated", async (c) => {
  try {
    const outdated = await registryService.checkOutdated();
    return c.json({ packages: outdated });
  } catch (err) {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
});

registryRoute.post("/registry/install", validateBody(installSchema), async (c) => {
  try {
    const body = getValidatedBody<z.infer<typeof installSchema>>(c as any);
    const result = await registryService.install(body.packages);
    return c.json(result);
  } catch (err) {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
});

registryRoute.post("/registry/uninstall", validateBody(uninstallSchema), async (c) => {
  try {
    const body = getValidatedBody<z.infer<typeof uninstallSchema>>(c as any);
    const result = await registryService.uninstall(body.packages);
    return c.json(result);
  } catch (err) {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
});

registryRoute.post("/registry/update", validateBody(updateSchema), async (c) => {
  try {
    const body = getValidatedBody<z.infer<typeof updateSchema>>(c as any);
    const result = await registryService.update(body.name);
    return c.json(result);
  } catch (err) {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
});

registryRoute.get("/registry/local", (c) => {
  try {
    const localOnly = registryService.listLocalOnly();
    return c.json({ packages: localOnly });
  } catch (err) {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
});

registryRoute.post("/registry/bootstrap", async (c) => {
  try {
    const result = await registryService.bootstrap(["test-mixed"]);
    return c.json(result);
  } catch (err) {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
});

registryRoute.post("/registry/publish", validateBody(publishSchema), async (c) => {
  try {
    const body = getValidatedBody<z.infer<typeof publishSchema>>(c as any);
    const result = await registryService.publish(body.name, body.type);
    return c.json(result);
  } catch (err) {
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
});
