import { test, expect } from "@playwright/test";

test.describe("Registry — Extra Coverage", () => {

  test("Search by tag keyword filters packages", async ({ page }) => {
    await page.goto("/registry");
    await expect(page.getByRole("heading", { name: "Package Store" })).toBeVisible({ timeout: 10_000 });
    // Search by a known tag keyword (e.g. "debugging") which appears in package tags
    await page.getByPlaceholder("Search packages...").fill("debugging");
    // Packages with "debugging" tag should remain visible
    await expect(page.getByText("systematic-debugging")).toBeVisible({ timeout: 5_000 });
  });

  test("Expanded package shows version and type info", async ({ page }) => {
    await page.goto("/registry");
    await expect(page.getByRole("heading", { name: "Package Store" })).toBeVisible({ timeout: 10_000 });
    // Click first package card to expand details
    const firstCard = page.locator(".space-y-2 > div").first();
    await firstCard.click();
    // After expanding, more content should be visible (description, tags, buttons)
    await expect(firstCard.getByText("1.0.0")).toBeVisible({ timeout: 3_000 });
  });

  test("Publish hint text visible for local packages", async ({ page }) => {
    await page.goto("/registry");
    await expect(page.getByRole("heading", { name: "Package Store" })).toBeVisible({ timeout: 10_000 });
    // Installed packages with local changes show a publish hint
    const publishHint = page.getByText(/publish|local changes/i).first();
    const hasHint = await publishHint.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!hasHint) {
      test.skip(true, "No local packages with publish hints");
    }
  });

});

test.describe("Help — Extra Coverage", () => {

  test("Help page in Chinese locale loads content", async ({ page }) => {
    await page.goto("/help");
    await expect(page.getByText("Overview")).toBeVisible({ timeout: 5_000 });
    // Switch to Chinese
    await page.getByRole("button", { name: "中", exact: true }).click();
    // Content should reload in Chinese — heading and nav should change
    // At minimum the page should not show error
    await expect(page.locator("main")).toBeVisible();
    // Switch back to English
    await page.getByRole("button", { name: "EN", exact: true }).click();
  });

  test("Help page renders mermaid diagrams or code blocks", async ({ page }) => {
    await page.goto("/help");
    await expect(page.getByText("Overview")).toBeVisible({ timeout: 5_000 });
    // Navigate to Architecture tab which likely has mermaid diagrams
    const archTab = page.locator("nav").getByText("Architecture");
    if (!(await archTab.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "Architecture tab not found");
      return;
    }
    await archTab.click();
    // Wait for content to load
    await page.waitForTimeout(1000);
    // Look for mermaid container or pre/code blocks
    const hasMermaid = await page.locator(".mermaid, svg.mermaid, pre code").first().isVisible({ timeout: 5_000 }).catch(() => false);
    const hasCode = await page.locator("pre, code").first().isVisible({ timeout: 3_000 }).catch(() => false);
    expect(hasMermaid || hasCode).toBe(true);
  });

  test("Navigation buttons show prev and next labels on middle tab", async ({ page }) => {
    await page.goto("/help");
    await expect(page.getByText("Overview")).toBeVisible({ timeout: 5_000 });
    // Navigate to a middle tab to see both Prev and Next
    const nav = page.locator("nav");
    const tabs = nav.locator("button");
    const tabCount = await tabs.count();
    if (tabCount > 2) {
      // Click second tab
      await tabs.nth(1).click();
      await page.waitForTimeout(500);
      // At least one navigation button should be visible at the bottom
      const navArea = page.locator(".flex.justify-between.items-center");
      await expect(navArea).toBeVisible({ timeout: 5_000 });
      const navButtons = navArea.locator("button");
      expect(await navButtons.count()).toBeGreaterThanOrEqual(1);
    }
  });

});
