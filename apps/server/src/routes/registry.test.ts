import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mockRegistryService = vi.hoisted(() => ({
  getIndex: vi.fn(),
  search: vi.fn(),
  getManifest: vi.fn(),
  listInstalled: vi.fn(),
  checkOutdated: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  update: vi.fn(),
  listLocalOnly: vi.fn(),
  bootstrap: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock("../services/registry-service.js", () => ({
  registryService: mockRegistryService,
}));

import { registryRoute } from "./registry.js";

function json(body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("registry routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", registryRoute);
  });

  it("GET /registry/index returns the index", async () => {
    const index = { packages: [{ name: "foo" }] };
    mockRegistryService.getIndex.mockResolvedValue(index);

    const res = await app.request("/registry/index");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(index);
  });

  it("GET /registry/index returns 500 on error", async () => {
    mockRegistryService.getIndex.mockRejectedValue(new Error("boom"));

    const res = await app.request("/registry/index");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.error).toBe("boom");
  });

  it("GET /registry/search passes query params", async () => {
    mockRegistryService.search.mockResolvedValue([{ name: "bar" }]);

    const res = await app.request("/registry/search?q=bar&type=tool");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.packages).toEqual([{ name: "bar" }]);
    expect(mockRegistryService.search).toHaveBeenCalledWith("bar", "tool");
  });

  it("GET /registry/search defaults undefined when no params", async () => {
    mockRegistryService.search.mockResolvedValue([]);

    await app.request("/registry/search");
    expect(mockRegistryService.search).toHaveBeenCalledWith(undefined, undefined);
  });

  it("GET /registry/packages/:name returns manifest", async () => {
    const manifest = { name: "pkg", version: "1.0.0" };
    mockRegistryService.getManifest.mockResolvedValue(manifest);

    const res = await app.request("/registry/packages/pkg");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(manifest);
  });

  it("GET /registry/packages/:name returns 404 on error", async () => {
    mockRegistryService.getManifest.mockRejectedValue(new Error("not found"));

    const res = await app.request("/registry/packages/missing");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("FILE_NOT_FOUND");
  });

  it("GET /registry/installed returns installed packages", async () => {
    const installed = [{ name: "a" }];
    mockRegistryService.listInstalled.mockReturnValue(installed);

    const res = await app.request("/registry/installed?type=tool");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.packages).toEqual(installed);
    expect(mockRegistryService.listInstalled).toHaveBeenCalledWith("tool");
  });

  it("POST /registry/install installs packages", async () => {
    const result = { installed: ["foo"] };
    mockRegistryService.install.mockResolvedValue(result);

    const res = await app.request("/registry/install", json({ packages: ["foo"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mockRegistryService.install).toHaveBeenCalledWith(["foo"]);
  });

  it("POST /registry/install returns 400 on invalid body", async () => {
    const res = await app.request("/registry/install", json({ packages: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("POST /registry/publish publishes a package", async () => {
    const result = { published: true };
    mockRegistryService.publish.mockResolvedValue(result);

    const res = await app.request("/registry/publish", json({ name: "pkg", type: "tool" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mockRegistryService.publish).toHaveBeenCalledWith("pkg", "tool");
  });
});
