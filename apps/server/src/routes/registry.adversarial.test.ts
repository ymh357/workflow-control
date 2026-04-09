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

describe("registry routes — adversarial", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route("/", registryRoute);
  });

  it("GET /registry/search handles XSS in query param without error", async () => {
    mockRegistryService.search.mockResolvedValue([]);
    const xss = '<script>alert(1)</script>';
    const res = await app.request(`/registry/search?q=${encodeURIComponent(xss)}`);
    expect(res.status).toBe(200);
    expect(mockRegistryService.search).toHaveBeenCalledWith(xss, undefined);
  });

  it("GET /registry/packages/:name with path traversal attempt", async () => {
    mockRegistryService.getManifest.mockRejectedValue(new Error("not found"));
    const res = await app.request("/registry/packages/..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(404);
  });

  it("POST /registry/install rejects packages array with empty strings", async () => {
    const res = await app.request("/registry/install", json({ packages: [""] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("POST /registry/install rejects non-array packages field", async () => {
    const res = await app.request("/registry/install", json({ packages: "single-pkg" }));
    expect(res.status).toBe(400);
  });

  it("POST /registry/uninstall rejects empty packages array", async () => {
    const res = await app.request("/registry/uninstall", json({ packages: [] }));
    expect(res.status).toBe(400);
  });

  it("POST /registry/publish rejects missing type field", async () => {
    const res = await app.request("/registry/publish", json({ name: "my-pkg" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("error responses do not expose sensitive path information", async () => {
    const sensitiveMsg = "ENOENT: /home/user/.secret/config.yaml";
    mockRegistryService.getIndex.mockRejectedValue(new Error(sensitiveMsg));

    const res = await app.request("/registry/index");
    expect(res.status).toBe(500);
    const body = await res.json();
    // Security hardening: raw error messages are no longer exposed
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("/home/user");
  });

  it("POST /registry/update with invalid JSON body returns 400", async () => {
    const res = await app.request("/registry/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all",
    });
    expect(res.status).toBe(400);
  });
});
