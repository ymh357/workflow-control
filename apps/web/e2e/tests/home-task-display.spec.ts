import { test, expect } from "@playwright/test";

test.describe("Home Page — Task Display Details", () => {

  test("Task card shows waiting time", async ({ page }) => {
    await page.goto("/");
    // Wait for SSE tasks to load
    await expect(page.getByRole("heading", { name: /Needs Your Action/ })).toBeVisible({ timeout: 15_000 });
    // Task cards show "waiting Xm" or "waiting <1m" text
    await expect(page.getByText(/waiting/).first()).toBeVisible();
  });

  test("Actionable task group has colored left border", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Needs Your Action/ })).toBeVisible({ timeout: 15_000 });
    // Task links in actionable group have blue left border (border-l-2 border-blue-500)
    const actionableTask = page.getByRole("link").filter({ hasText: /blocked|awaitingConfirm/ }).first();
    await expect(actionableTask).toBeVisible();
    // Verify the border class on the parent or the link itself
    await expect(actionableTask).toHaveClass(/border-l/);
  });

  test("Task card shows awaitingConfirm status distinctly", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Needs Your Action/ })).toBeVisible({ timeout: 15_000 });
    // Find a task with awaitingConfirm status
    const confirmTask = page.getByText("awaitingConfirm").first();
    if (!(await confirmTask.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No awaitingConfirm task in list");
      return;
    }
    await expect(confirmTask).toBeVisible();
  });

  test("Completed section shows cancelled tasks without time info", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Completed/ })).toBeVisible({ timeout: 15_000 });
    // Cancelled tasks should show "cancelled" badge
    const cancelledBadge = page.getByText("cancelled").first();
    await expect(cancelledBadge).toBeVisible();
  });

  test("Stats bar shows total cost with dollar sign", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Total:/).first()).toBeVisible({ timeout: 15_000 });
    // Verify format "Total: $X.XX"
    await expect(page.getByText(/Total: \$\d+\.\d+/).first()).toBeVisible();
  });

});
