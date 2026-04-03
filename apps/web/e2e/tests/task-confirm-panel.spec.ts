// spec: e2e/specs/uncovered-scenarios.plan.md
// seed: e2e/tests/mcp-seed.spec.ts

import { test, expect } from "@playwright/test";

const AWAITING_TASK_URL = "/task/d510b065-043f-4899-8a29-f1ef4dd73c99";

test.describe("Task Detail — AwaitingConfirm UI", () => {
  test("Confirm panel shows Confirm and Re-run buttons", async ({ page }) => {
    // 1. Navigate to awaitingConfirm task
    await page.goto(AWAITING_TASK_URL);

    // Wait for SSE to connect and load task data
    await expect(page.getByRole("heading", { name: "Awaiting Confirm" })).toBeVisible({ timeout: 15_000 });

    // 2. Verify Confirm and Re-run buttons
    await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Re-run" })).toBeVisible();

    // 3. Verify feedback textarea
    await expect(page.getByPlaceholder(/provide feedback/)).toBeVisible();

    // 4. Verify Override repo name disclosure
    await expect(page.getByText("Override repo name")).toBeVisible();
  });

  test("Confirm panel shows analysis data fields", async ({ page }) => {
    // 1. Navigate to awaitingConfirm task
    await page.goto(AWAITING_TASK_URL);

    // Wait for confirm panel
    await expect(page.getByRole("heading", { name: "Awaiting Confirm" })).toBeVisible({ timeout: 15_000 });

    // 2. Verify analysis section with data fields
    await expect(page.getByRole("heading", { name: "Analysis" })).toBeVisible();
    await expect(page.getByText("title:")).toBeVisible();
    await expect(page.getByText("description:")).toBeVisible();
    await expect(page.getByText("repoName:")).toBeVisible();
  });

  test("Cancel button is visible for awaitingConfirm task", async ({ page }) => {
    // Navigate to awaitingConfirm task
    await page.goto(AWAITING_TASK_URL);
    await expect(page.locator("span").filter({ hasText: /^awaitingConfirm$/ })).toBeVisible({ timeout: 15_000 });

    // Cancel button should be visible
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  test("Cost button shows amount for task with cost", async ({ page }) => {
    // Navigate to task with cost
    await page.goto(AWAITING_TASK_URL);
    await expect(page.locator("span").filter({ hasText: /^awaitingConfirm$/ })).toBeVisible({ timeout: 15_000 });

    // Cost button should show $0.40
    await expect(page.getByRole("button", { name: "$0.40" })).toBeVisible();
  });
});
