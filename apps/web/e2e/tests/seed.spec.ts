import { test, expect } from "../fixtures";

test.describe("Environment seed checks", () => {
  test("server /health/ready returns 200", async ({ apiBase }) => {
    const res = await fetch(`${apiBase}/health/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("web homepage is accessible and renders", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/.+/);
    await expect(page.locator("body")).toBeVisible();
  });

  test("GET /api/config/pipelines returns at least one pipeline", async ({ apiBase }) => {
    const res = await fetch(`${apiBase}/api/config/pipelines`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.pipelines)).toBe(true);
    expect(body.pipelines.length).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/config/system returns capabilities", async ({ apiBase }) => {
    const res = await fetch(`${apiBase}/api/config/system`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("capabilities");
    expect(Array.isArray(body.capabilities.mcps)).toBe(true);
    expect(Array.isArray(body.capabilities.skills)).toBe(true);
  });

  test("GET /api/registry/index is accessible", async ({ apiBase }) => {
    const res = await fetch(`${apiBase}/api/registry/index`);
    expect(res.status).toBe(200);
  });
});
