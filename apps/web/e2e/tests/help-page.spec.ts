import { test, expect } from "../fixtures";

test.describe("Help Page", () => {
  test("page loads and displays overview content", async ({ page }) => {
    await page.goto("/help");

    // Nav tabs should be visible inside the nav element
    const nav = page.locator("nav");
    await expect(nav.locator("button").filter({ hasText: "Overview" })).toBeVisible();
    await expect(nav.locator("button").filter({ hasText: /^Tasks/ })).toBeVisible();
    await expect(nav.locator("button").filter({ hasText: "Pipelines" })).toBeVisible();
    await expect(nav.locator("button").filter({ hasText: "Prompts" })).toBeVisible();

    // Overview tab should be active (blue indicator)
    const overviewTab = nav.locator("button").filter({ hasText: "Overview" });
    await expect(overviewTab).toHaveClass(/text-blue-400/);

    // Content area should render markdown (non-empty)
    await page.waitForTimeout(1_000);
    const contentArea = page.locator(".max-w-none");
    await expect(contentArea).toBeVisible();
    const text = await contentArea.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test("tab navigation switches content", async ({ page }) => {
    await page.goto("/help");
    await page.waitForTimeout(1_000);

    // Get initial content
    const contentArea = page.locator(".max-w-none");
    await expect(contentArea).toBeVisible();
    const overviewText = await contentArea.textContent();

    // Click "Pipelines" tab
    await page.locator("button").filter({ hasText: "Pipelines" }).first().click();
    await page.waitForTimeout(1_000);

    // Content should change
    const pipelinesText = await contentArea.textContent();
    expect(pipelinesText).not.toEqual(overviewText);

    // Pipelines tab should be active
    const pipelinesTab = page.locator("button").filter({ hasText: "Pipelines" }).first();
    await expect(pipelinesTab).toHaveClass(/text-blue-400/);
  });

  test("all nav tabs are present", async ({ page }) => {
    await page.goto("/help");

    const expectedTabs = ["Overview", "Tasks", "Pipelines", "Prompts", "Edge Runner", "Integrations", "Store", "Architecture"];
    const nav = page.locator("nav");

    for (const label of expectedTabs) {
      await expect(nav.locator("button").filter({ hasText: label })).toBeVisible();
    }
  });

  test("prev/next navigation buttons work", async ({ page }) => {
    await page.goto("/help");
    await page.waitForTimeout(1_000);

    // On "Overview" (first page), no prev button, but next should exist
    const navFooter = page.locator(".border-t.border-zinc-800");
    const nextBtn = navFooter.locator("button").filter({ hasText: "Tasks" });
    await expect(nextBtn).toBeVisible();

    // Click next
    await nextBtn.click();
    await page.waitForTimeout(1_000);

    // Now "Tasks" tab should be active
    const tasksTab = page.locator("nav button").filter({ hasText: "Tasks" }).first();
    await expect(tasksTab).toHaveClass(/text-blue-400/);

    // Prev button should now point to "Overview"
    const prevBtn = navFooter.locator("button").filter({ hasText: "Overview" });
    await expect(prevBtn).toBeVisible();

    // Click prev to go back
    await prevBtn.click();
    await page.waitForTimeout(1_000);

    const overviewTab = page.locator("nav button").filter({ hasText: "Overview" }).first();
    await expect(overviewTab).toHaveClass(/text-blue-400/);
  });
});
