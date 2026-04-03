import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

test.describe("Registry — Advanced Features", () => {
  test("Bootstrap All button is functional", async ({ page }) => {
    await page.goto("/registry");

    // Wait for page to load
    await expect(page.locator("h1", { hasText: "Package Store" })).toBeVisible({ timeout: 10_000 });

    // Bootstrap button should be visible (i18n text may vary)
    const bootstrapBtn = page.locator("button").filter({ hasText: /bootstrap|Bootstrap/ }).first();
    await expect(bootstrapBtn).toBeVisible({ timeout: 5_000 });
    await expect(bootstrapBtn).toBeEnabled();
  });

  test("expand details shows dependencies section when available", async ({ page }) => {
    await page.goto("/registry");

    // Wait for packages to load
    const cards = page.locator(".space-y-2 > div");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // Click each card until we find one with dependencies
    const cardCount = await cards.count();
    let foundDeps = false;

    for (let i = 0; i < Math.min(cardCount, 5); i++) {
      const card = cards.nth(i);
      const header = card.locator(".cursor-pointer").first();
      await header.click();
      await page.waitForTimeout(500);

      const depsSection = card.locator("text=Dependencies");
      if (await depsSection.isVisible().catch(() => false)) {
        foundDeps = true;
        // Verify dependencies are shown as badges
        const depBadges = card.locator(".border-t .bg-zinc-800.text-zinc-400");
        expect(await depBadges.count()).toBeGreaterThanOrEqual(1);
        break;
      }

      // Collapse before trying next
      await header.click();
      await page.waitForTimeout(300);
    }

    // Dependencies are optional — just verify the expand/collapse mechanism works
    if (!foundDeps) {
      // At minimum, the first card should expand with Files section
      const firstHeader = cards.first().locator(".cursor-pointer").first();
      await firstHeader.click();
      await expect(cards.first().locator("text=Files")).toBeVisible({ timeout: 5_000 });
    }
  });

  test("stats bar shows Local and Outdated counts when applicable", async ({ page }) => {
    await page.goto("/registry");

    // Stats bar should always show Available and Installed
    await expect(page.locator("text=Available:")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Installed:")).toBeVisible();

    // Local and Outdated are conditional — check the API to know what to expect
    const [localRes, outdatedRes] = await Promise.all([
      fetch(`${API_BASE}/api/registry/local`),
      fetch(`${API_BASE}/api/registry/outdated`),
    ]);
    const localData = await localRes.json();
    const outdatedData = await outdatedRes.json();

    const localCount = (localData.packages ?? []).filter(
      (lp: { name: string }) => true
    ).length;
    const outdatedCount = (outdatedData.packages ?? []).length;

    if (localCount > 0) {
      await expect(page.locator("text=Local:")).toBeVisible();
    }
    if (outdatedCount > 0) {
      await expect(page.locator("text=Outdated:")).toBeVisible();
    }
  });
});
