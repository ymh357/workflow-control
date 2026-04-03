// spec: e2e/specs/uncovered-scenarios.plan.md
// seed: e2e/tests/mcp-seed.spec.ts

import { test, expect } from "@playwright/test";

test.describe("Home Page — Locale and Load More", () => {
  test("Language switcher toggles between EN and Chinese", async ({ page }) => {
    // 1. Navigate to home page
    await page.goto("/");

    // Verify EN and 中 buttons visible in nav bar
    await expect(page.getByRole("button", { name: "EN", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "中", exact: true })).toBeVisible();

    // 2. Click 中 button to switch to Chinese
    await page.getByRole("button", { name: "中" }).click();

    // Verify page switches to Chinese locale
    await expect(page.getByRole("heading", { name: "创建任务" })).toBeVisible();
    await expect(page.getByRole("link", { name: "任务" })).toBeVisible();
    await expect(page.getByRole("link", { name: "配置" })).toBeVisible();

    // 3. Click EN button to switch back to English
    await page.getByRole("button", { name: "EN", exact: true }).click();

    // Verify page switches back to English
    await expect(page.getByRole("heading", { name: "Create Task" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Config" })).toBeVisible();
  });

  test("Show more button loads additional tasks", async ({ page }) => {
    // 1. Navigate to home page
    await page.goto("/");

    // Wait for task list to load via SSE
    await expect(page.getByRole("heading", { name: /Completed/ })).toBeVisible({ timeout: 15_000 });

    // 2. Look for "Show N more..." button
    const showMoreBtn = page.getByRole("button", { name: /Show \d+ more/ });
    if (!(await showMoreBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No Show more button — all tasks already visible");
      return;
    }

    // Count visible task links before
    const tasksBefore = await page.getByRole("link", { name: /cancelled|idle/ }).count();

    // Click Show more
    await showMoreBtn.click();

    // More tasks should appear and button should disappear
    const tasksAfter = await page.getByRole("link", { name: /cancelled|idle/ }).count();
    expect(tasksAfter).toBeGreaterThan(tasksBefore);
    await expect(showMoreBtn).not.toBeVisible({ timeout: 3_000 });
  });

  test("Textarea is directly visible on home page", async ({ page }) => {
    // 1. Navigate to home page
    await page.goto("/");

    // Verify textarea is directly visible (no radio toggle)
    await expect(page.locator("textarea")).toBeVisible();
    await expect(page.getByRole("button", { name: "Analyze" })).toBeVisible();

    // 2. Type task text
    await page.locator("textarea").fill("Test task description");
    await expect(page.locator("textarea")).toHaveValue("Test task description");
  });
});
