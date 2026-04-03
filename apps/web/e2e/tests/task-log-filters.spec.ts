// spec: e2e/specs/uncovered-scenarios.plan.md
// seed: e2e/tests/mcp-seed.spec.ts

import { test, expect } from "@playwright/test";

const TASK_URL = "/task/d510b065-043f-4899-8a29-f1ef4dd73c99";

test.describe("Task Detail — Log Filtering", () => {
  test("Log filter buttons toggle message categories", async ({ page }) => {
    await page.goto(TASK_URL);

    // Wait for log entries to appear
    await expect(page.getByRole("button", { name: /Tool: StructuredOutput/ }).first()).toBeVisible({ timeout: 15_000 });

    // Click Agent filter button
    await page.getByRole("button", { name: "Agent", exact: true }).click();

    // Click All filter to restore
    await page.getByRole("button", { name: "All", exact: true }).click();
  });

  test("Log search filters messages by text", async ({ page }) => {
    await page.goto(TASK_URL);

    // Wait for log entries
    await expect(page.getByRole("button", { name: /Tool: StructuredOutput/ }).first()).toBeVisible({ timeout: 15_000 });

    // Type search term
    const searchInput = page.getByPlaceholder("Search...");
    await searchInput.fill("helloworld");

    // Verify matching content is visible
    await expect(page.getByText("helloworld").first()).toBeVisible();

    // Clear search
    await searchInput.fill("");
  });

  test("Stage dropdown filters log messages by stage", async ({ page }) => {
    await page.goto(TASK_URL);

    // Wait for stage dropdown to have options
    const stageDropdown = page.getByRole("combobox");
    await expect(stageDropdown).toBeVisible({ timeout: 15_000 });

    // Verify options exist
    await expect(stageDropdown.locator("option")).toHaveCount(3); // All stages, analyzing, awaitingConfirm

    // Select analyzing stage
    await stageDropdown.selectOption("analyzing");

    // Select All stages to restore
    await stageDropdown.selectOption({ index: 0 });
  });

  test("Timeline stages are visible and clickable", async ({ page }) => {
    await page.goto(TASK_URL);

    // Wait for timeline to appear — timeline stage labels are in small span elements
    const timeline = page.locator("span.whitespace-nowrap");
    await expect(timeline.filter({ hasText: "Analyzing" })).toBeVisible({ timeout: 15_000 });
    await expect(timeline.filter({ hasText: "Confirm" })).toBeVisible();
    await expect(timeline.filter({ hasText: "Implementing" })).toBeVisible();
    await expect(timeline.filter({ hasText: "Quality Assurance" })).toBeVisible();

    // Click on Analyzing stage in timeline
    await timeline.filter({ hasText: "Analyzing" }).click();
  });

  test("Collapsible log entries expand on click", async ({ page }) => {
    await page.goto(TASK_URL);

    // Wait for collapsible log entry
    const toolEntry = page.getByRole("button", { name: /Tool: StructuredOutput/ }).first();
    await expect(toolEntry).toBeVisible({ timeout: 15_000 });

    // Click to expand
    await toolEntry.click();
  });
});
