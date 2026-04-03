import { test, expect } from "@playwright/test";

test.describe("Home Page — Advanced Coverage", () => {
  test("Text mode submit button is clickable after filling textarea and repo name", async ({ page }) => {
    await page.goto("/");

    // Fill textarea
    await page.getByPlaceholder("Describe your task...").fill("Implement login feature");

    // Fill repo name
    await page.getByPlaceholder("Repository name (optional)").fill("my-repo");

    // Submit button should be visible and enabled
    const submitBtn = page.getByRole("button", { name: "Analyze" });
    await expect(submitBtn).toBeVisible();
    await expect(submitBtn).toBeEnabled();
  });

  test("Pipeline selector switches between options", async ({ page }) => {
    await page.goto("/");

    const pipelineSelect = page.locator("select");
    await expect(pipelineSelect).toBeVisible({ timeout: 10_000 });

    // Get all options
    const options = pipelineSelect.locator("option");
    const count = await options.count();
    if (count < 2) {
      test.skip(true, "Only one pipeline option available — cannot test switching");
      return;
    }

    // Record the initial value
    const initialValue = await pipelineSelect.inputValue();

    // Select the second option
    const secondOptionValue = await options.nth(1).getAttribute("value");
    expect(secondOptionValue).toBeTruthy();
    await pipelineSelect.selectOption(secondOptionValue!);

    // Verify value changed
    const newValue = await pipelineSelect.inputValue();
    expect(newValue).toBe(secondOptionValue);
    expect(newValue).not.toBe(initialValue);
  });

  test("Empty textarea submit does not navigate away", async ({ page }) => {
    await page.goto("/");

    // Do not fill textarea, click Analyze
    const analyzeBtn = page.getByRole("button", { name: "Analyze" });
    await expect(analyzeBtn).toBeVisible();
    await analyzeBtn.click();

    // Should still be on homepage — browser native validation prevents submission
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: "Create Task" })).toBeVisible();
  });

  test("Textarea and repo name both retain values", async ({ page }) => {
    await page.goto("/");

    const textarea = page.getByPlaceholder("Describe your task...");
    const repoInput = page.getByPlaceholder("Repository name (optional)");

    // Fill both fields
    await textarea.fill("Build a REST API with authentication");
    await repoInput.fill("api-service");

    // Verify both values persist
    await expect(textarea).toHaveValue("Build a REST API with authentication");
    await expect(repoInput).toHaveValue("api-service");
  });

  test("Task card displays status badge", async ({ page }) => {
    await page.goto("/");

    // Wait for SSE to load tasks
    await expect(
      page.getByRole("heading", { name: /Needs Your Action/ })
    ).toBeVisible({ timeout: 15_000 });

    // Find a task link in the actionable group
    const taskLinks = page.locator('a[href^="/task/"]');
    await expect(taskLinks.first()).toBeVisible();

    // Each task card should have a status text (blocked, awaitingConfirm, running, etc.)
    const firstCard = taskLinks.first();
    const statusBadge = firstCard.locator("span.text-xs.font-medium");
    await expect(statusBadge).toBeVisible();
    const statusText = await statusBadge.textContent();
    expect(statusText).toBeTruthy();
    expect(statusText!.length).toBeGreaterThan(0);
  });

  test("Task card displays cost", async ({ page }) => {
    await page.goto("/");

    // Wait for SSE to load tasks
    await expect(
      page.getByRole("heading", { name: /Needs Your Action/ })
    ).toBeVisible({ timeout: 15_000 });

    // Look for a cost element matching $X.XX pattern
    const costSpan = page.locator("span.font-mono").filter({ hasText: /^\$\d+\.\d{2}$/ });
    if (!(await costSpan.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "No task with cost data available");
      return;
    }

    await expect(costSpan.first()).toBeVisible();
    const costText = await costSpan.first().textContent();
    expect(costText).toMatch(/^\$\d+\.\d{2}$/);
  });

  test("Task card click navigates to task detail page", async ({ page }) => {
    await page.goto("/");

    // Wait for SSE to load tasks
    await expect(
      page.getByRole("heading", { name: /Needs Your Action/ })
    ).toBeVisible({ timeout: 15_000 });

    const taskLinks = page.locator('a[href^="/task/"]');
    await expect(taskLinks.first()).toBeVisible();

    // Extract the href to know the expected URL
    const href = await taskLinks.first().getAttribute("href");
    expect(href).toMatch(/^\/task\/.+/);

    // Click the first task card
    await taskLinks.first().click();

    // Verify navigation to /task/xxx
    await expect(page).toHaveURL(new RegExp(`^.*${href!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  });

  test("Awaiting action count is displayed in stats bar", async ({ page }) => {
    await page.goto("/");

    // Wait for SSE to load tasks
    await expect(
      page.getByRole("heading", { name: /Needs Your Action/ })
    ).toBeVisible({ timeout: 15_000 });

    // Stats bar should show "N awaiting action" text
    const statsBar = page.locator(".flex.gap-4.text-xs.text-zinc-500");
    await expect(statsBar).toBeVisible();
    await expect(statsBar).toContainText(/\d+ awaiting action/);
  });
});
