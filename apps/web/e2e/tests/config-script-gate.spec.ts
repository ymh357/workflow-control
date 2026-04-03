import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

const openWorkbench = async (page: import("@playwright/test").Page) => {
  await page.goto("/config");
  await expect(page.locator("text=Loading System Configuration")).not.toBeVisible({ timeout: 15_000 });
  await page.locator("button", { hasText: "Blueprint & Intelligence" }).click();
};

const selectFirstPipeline = async (page: import("@playwright/test").Page) => {
  const pipelineCards = page.locator(".grid.grid-cols-1.gap-3 > div");
  await expect(pipelineCards.first()).toBeVisible({ timeout: 10_000 });
  await pipelineCards.first().locator("button.flex-1").click();
  await expect(page.locator("button").filter({ hasText: "Pipeline Settings" })).toBeVisible({ timeout: 10_000 });
};

const selectFirstStageConfig = async (page: import("@playwright/test").Page) => {
  const stageCards = page.locator('[role="button"]').filter({
    has: page.locator(".text-sm.font-bold.text-zinc-100"),
  });
  await expect(stageCards.first()).toBeVisible({ timeout: 10_000 });
  await stageCards.first().click();
  const configTab = page.locator("button").filter({ hasText: /^Config$/ });
  await expect(configTab).toBeVisible({ timeout: 5_000 });
  await configTab.click();
};

const switchStageType = async (page: import("@playwright/test").Page, type: "agent" | "gate" | "script") => {
  const typeLabel = page.locator("label", { hasText: "Type" });
  const typeButtons = typeLabel.locator("..").locator("button");
  const btn = typeButtons.filter({ hasText: type });
  await expect(btn).toBeVisible({ timeout: 5_000 });
  await btn.click();
  await expect(btn).toHaveClass(/bg-zinc-700/);
};

// ---------------------------------------------------------------------------
// Script Stage Fields
// ---------------------------------------------------------------------------

test.describe("Config Script Stage Fields", () => {
  test("Switching to script type shows script fields", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "script");

    const scriptIdLabel = page.locator("label", { hasText: "Script ID" });
    await expect(scriptIdLabel).toBeVisible({ timeout: 5_000 });

    const scriptIdSelect = scriptIdLabel.locator("..").locator("select").first();
    await expect(scriptIdSelect).toBeVisible();
  });

  test("Script ID dropdown has options", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "script");

    const scriptIdLabel = page.locator("label", { hasText: "Script ID" });
    const scriptIdSelect = scriptIdLabel.locator("..").locator("select").first();
    await expect(scriptIdSelect).toBeVisible({ timeout: 5_000 });

    const optionCount = await scriptIdSelect.locator("option").count();
    expect(optionCount).toBeGreaterThan(0);

    // Select the first option
    if (optionCount > 0) {
      const firstValue = await scriptIdSelect.locator("option").first().getAttribute("value");
      if (firstValue) {
        await scriptIdSelect.selectOption(firstValue);
        await expect(scriptIdSelect).toHaveValue(firstValue);
      }
    }
  });

  test("Script Writes input", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "script");

    const writesInput = page.locator('input[placeholder="branch, worktreePath..."]');
    await expect(writesInput).toBeVisible({ timeout: 5_000 });

    await writesInput.fill("output1, output2");
    await expect(writesInput).toHaveValue("output1, output2");
  });

  test("Script Args JSON textarea", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "script");

    const argsLabel = page.locator("label", { hasText: "Arguments (JSON)" });
    const argsTextarea = argsLabel.locator("..").locator("textarea").first();
    await expect(argsTextarea).toBeVisible({ timeout: 5_000 });

    await argsTextarea.fill('{"key": "value"}');
    // JSON gets parsed and reformatted by the onChange handler
    await expect(argsTextarea).toHaveValue(/key/);
  });

  test("Script Timeout input", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "script");

    const timeoutLabel = page.locator("label", { hasText: "Timeout (sec)" });
    const timeoutInput = timeoutLabel.locator("..").locator('input[type="number"]').first();
    await expect(timeoutInput).toBeVisible({ timeout: 5_000 });

    await timeoutInput.fill("120");
    await expect(timeoutInput).toHaveValue("120");
  });
});

// ---------------------------------------------------------------------------
// Human Gate Fields
// ---------------------------------------------------------------------------

test.describe("Config Human Gate Fields", () => {
  test("Switching to gate type shows gate fields", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "gate");

    const onRejectLabel = page.locator("label", { hasText: "On Reject" });
    await expect(onRejectLabel).toBeVisible({ timeout: 5_000 });
  });

  test("On Reject defaults to error and has stage options", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "gate");

    const onRejectLabel = page.locator("label", { hasText: "On Reject" });
    const onRejectSelect = onRejectLabel.locator("..").locator("select").first();
    await expect(onRejectSelect).toBeVisible({ timeout: 5_000 });

    // Default value should be "error"
    await expect(onRejectSelect).toHaveValue("error");

    // Should have "error (Default)" option plus other stage names
    const options = onRejectSelect.locator("option");
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThanOrEqual(1);

    // First option should be the error default
    const firstOptionText = await options.first().textContent();
    expect(firstOptionText).toContain("error");
  });

  test("On Approve To defaults to next stage", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "gate");

    const onApproveLabel = page.locator("label", { hasText: "On Approve To" });
    const onApproveSelect = onApproveLabel.locator("..").locator("select").first();
    await expect(onApproveSelect).toBeVisible({ timeout: 5_000 });

    // Default value should be "" (Next Stage default)
    await expect(onApproveSelect).toHaveValue("");

    // First option text should contain "Next stage (default)"
    const firstOptionText = await onApproveSelect.locator("option").first().textContent();
    expect(firstOptionText).toContain("Next stage");
  });

  test("Notify template input", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "gate");

    const notifyTemplateInput = page.locator('input[placeholder="Notification template..."]');
    await expect(notifyTemplateInput).toBeVisible({ timeout: 5_000 });

    await notifyTemplateInput.fill("Review needed: {{task}}");
    await expect(notifyTemplateInput).toHaveValue("Review needed: {{task}}");
  });

  test("Max Feedback Loops input", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "gate");

    const maxLoopsLabel = page.locator("label", { hasText: "Max Feedback Loops" });
    const maxLoopsInput = maxLoopsLabel.locator("..").locator('input[type="number"]').first();
    await expect(maxLoopsInput).toBeVisible({ timeout: 5_000 });

    await maxLoopsInput.fill("3");
    await expect(maxLoopsInput).toHaveValue("3");
  });
});

// ---------------------------------------------------------------------------
// Stage Routing (common fields)
// ---------------------------------------------------------------------------

test.describe("Config Stage Routing", () => {
  test("Success Target shows arrow indicator", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const successLabel = page.locator("label", { hasText: "Success Target" });
    await expect(successLabel).toBeVisible({ timeout: 5_000 });

    // The success target area should contain an arrow symbol
    const successContainer = successLabel.locator("..");
    const arrowSpan = successContainer.locator("span").filter({ hasText: "\u2192" });
    await expect(arrowSpan).toBeVisible();
  });

  test("Retry Back To select for agent type", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    // Ensure we are on agent type (non-gate)
    await switchStageType(page, "agent");

    const retryLabel = page.locator("label", { hasText: "Retry Back To" });
    const retrySelect = retryLabel.locator("..").locator("select").first();
    await expect(retrySelect).toBeVisible({ timeout: 5_000 });

    // Default should be "" (No retry)
    await expect(retrySelect).toHaveValue("");

    // First option text should be "No retry"
    const firstOptionText = await retrySelect.locator("option").first().textContent();
    expect(firstOptionText).toContain("No retry");

    // Should have additional stage options if pipeline has multiple stages
    const optionCount = await retrySelect.locator("option").count();
    expect(optionCount).toBeGreaterThanOrEqual(1);
  });

  test("Retry Back To select for script type", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "script");

    const retryLabel = page.locator("label", { hasText: "Retry Back To" });
    const retrySelect = retryLabel.locator("..").locator("select").first();
    await expect(retrySelect).toBeVisible({ timeout: 5_000 });

    await expect(retrySelect).toHaveValue("");
  });

  test("Retry Back To not visible for gate type", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);
    await switchStageType(page, "gate");

    const retryLabel = page.locator("label", { hasText: "Retry Back To" });
    await expect(retryLabel).not.toBeVisible({ timeout: 3_000 });
  });
});
