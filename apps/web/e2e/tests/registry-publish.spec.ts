// spec: e2e/specs/uncovered-scenarios.plan.md
// seed: e2e/tests/mcp-seed.spec.ts

import { test, expect } from "@playwright/test";

test.describe("Registry — Publish", () => {
  test("Publish button is visible for installed packages", async ({ page }) => {
    await page.goto("/registry");

    // Wait for packages to load
    await expect(page.getByRole("heading", { name: "Package Store" })).toBeVisible({ timeout: 10_000 });

    // Find an installed package — it should have both "Publish" and "Installed" buttons
    const publishBtn = page.getByRole("button", { name: "Publish" }).first();
    await expect(publishBtn).toBeVisible({ timeout: 5_000 });

    const installedBtn = page.getByRole("button", { name: "Installed" }).first();
    await expect(installedBtn).toBeVisible();
  });
});
