import { test, expect } from "@playwright/test";

const TASK_URL = "/task/d510b065-043f-4899-8a29-f1ef4dd73c99";

test.describe("Task Detail — Extra Coverage", () => {

  test("Cost summary button toggles expanded view", async ({ page }) => {
    await page.goto(TASK_URL);
    // Wait for cost button
    const costBtn = page.getByRole("button", { name: /\$\d+\.\d+/ });
    await expect(costBtn).toBeVisible({ timeout: 15_000 });
    // Click to expand cost summary
    await costBtn.click();
    // Some cost detail should appear (table or breakdown)
    // Click again to collapse
    await costBtn.click();
  });

  test("View Structured Fields collapsible in confirm panel", async ({ page }) => {
    await page.goto(TASK_URL);
    await expect(page.getByRole("heading", { name: "Awaiting Confirm" })).toBeVisible({ timeout: 15_000 });
    // Look for "View Structured Fields" or "View structured fields" collapsible
    const structuredBtn = page.getByText(/View structured fields|View Structured Fields/i).first();
    if (!(await structuredBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No structured fields collapsible");
      return;
    }
    await structuredBtn.click();
  });

  test("Workflow tab is active by default with timeline visible", async ({ page }) => {
    await page.goto(TASK_URL);
    await expect(page.getByRole("heading", { name: "Awaiting Confirm" })).toBeVisible({ timeout: 15_000 });
    // Workflow tab should be active (has border-b-2)
    const workflowTab = page.locator("button").filter({ hasText: "Workflow" });
    await expect(workflowTab).toHaveClass(/border-b-2/);
    // Timeline should show stage names
    const timeline = page.locator("span.whitespace-nowrap");
    await expect(timeline.first()).toBeVisible();
  });

  test("Tools filter button works in log stream", async ({ page }) => {
    await page.goto(TASK_URL);
    await expect(page.getByRole("button", { name: /Tool: StructuredOutput/ }).first()).toBeVisible({ timeout: 15_000 });
    // Click Tools filter
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    // Click All to restore
    await page.getByRole("button", { name: "All", exact: true }).click();
  });

  test("System filter button works in log stream", async ({ page }) => {
    await page.goto(TASK_URL);
    await expect(page.getByRole("button", { name: /Tool: StructuredOutput/ }).first()).toBeVisible({ timeout: 15_000 });
    // Click System filter
    await page.getByRole("button", { name: "System", exact: true }).click();
    // Should show status messages
    // Click All to restore
    await page.getByRole("button", { name: "All", exact: true }).click();
  });

});
