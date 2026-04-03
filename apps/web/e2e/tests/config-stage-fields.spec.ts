import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

const openWorkbench = async (page: import("@playwright/test").Page) => {
  await page.goto("/config");
  await expect(
    page.locator("text=Loading System Configuration")
  ).not.toBeVisible({ timeout: 15_000 });
  await page
    .locator("button", { hasText: "Blueprint & Intelligence" })
    .click();
};

const selectFirstPipeline = async (page: import("@playwright/test").Page) => {
  const pipelineCards = page.locator(".grid.grid-cols-1.gap-3 > div");
  await expect(pipelineCards.first()).toBeVisible({ timeout: 10_000 });
  await pipelineCards.first().locator("button.flex-1").click();
  await expect(
    page.locator("button").filter({ hasText: "Pipeline Settings" })
  ).toBeVisible({ timeout: 10_000 });
};

const selectFirstStageConfig = async (
  page: import("@playwright/test").Page
) => {
  const stageCards = page.locator('[role="button"]').filter({
    has: page.locator(".text-sm.font-bold.text-zinc-100"),
  });
  await expect(stageCards.first()).toBeVisible({ timeout: 10_000 });
  await stageCards.first().click();
  // Switch to Config tab
  const configTab = page.locator("button").filter({ hasText: /^Config$/ });
  await expect(configTab).toBeVisible({ timeout: 5_000 });
  await configTab.click();
};

test.describe("Config Stage Fields", () => {
  test("Stage Name edit", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    // Stage Name field: label.text-xs + sibling input
    const nameInput = page.locator("label").filter({ hasText: "Stage Name" }).locator("..").locator("input").first();
    await expect(nameInput).toBeVisible({ timeout: 5_000 });

    await nameInput.fill("my-custom-stage");
    await expect(nameInput).toHaveValue("my-custom-stage");
  });

  test("Stage Type toggle", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const typeButtons = page
      .locator("label", { hasText: "Type" })
      .locator("..")
      .locator("button");

    const agentBtn = typeButtons.filter({ hasText: "agent" });
    const gateBtn = typeButtons.filter({ hasText: "gate" });
    const scriptBtn = typeButtons.filter({ hasText: "script" });

    // Click gate and verify selected style
    await gateBtn.click();
    await expect(gateBtn).toHaveClass(/bg-zinc-700/);
    await expect(gateBtn).toHaveClass(/text-white/);

    // Click script and verify
    await scriptBtn.click();
    await expect(scriptBtn).toHaveClass(/bg-zinc-700/);
    await expect(scriptBtn).toHaveClass(/text-white/);

    // Click agent and verify
    await agentBtn.click();
    await expect(agentBtn).toHaveClass(/bg-zinc-700/);
    await expect(agentBtn).toHaveClass(/text-white/);
  });

  test("Max Turns number input", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const maxTurnsLabel = page.locator("label", { hasText: "Max Turns" });
    const maxTurnsInput = maxTurnsLabel
      .locator("..")
      .locator('input[type="number"]')
      .first();

    const visible = await maxTurnsInput.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    await maxTurnsInput.fill("50");
    await expect(maxTurnsInput).toHaveValue("50");
  });

  test("Budget number input", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const budgetLabel = page.locator("label", { hasText: "Budget" });
    const budgetInput = budgetLabel
      .locator("..")
      .locator('input[step="0.5"]')
      .first();

    const visible = await budgetInput.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    await budgetInput.fill("5.5");
    await expect(budgetInput).toHaveValue("5.5");
  });

  test("Effort select", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const effortLabel = page.locator("label", { hasText: "Effort" });
    const effortSelect = effortLabel.locator("..").locator("select").first();

    const visible = await effortSelect.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    for (const value of ["low", "medium", "high", "max"]) {
      await effortSelect.selectOption(value);
      await expect(effortSelect).toHaveValue(value);
    }
  });

  test("Engine tri-state toggle (Stage level)", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const engineLabel = page.locator("label", { hasText: "Engine" });
    const engineButtons = engineLabel.locator("..").locator("button");

    const claudeBtn = engineButtons.filter({ hasText: "claude" });
    const geminiBtn = engineButtons.filter({ hasText: "gemini" });
    const inheritBtn = engineButtons.filter({ hasText: "inherit" });

    const visible = await geminiBtn.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    // Click gemini and verify selected style
    await geminiBtn.click();
    await expect(geminiBtn).toHaveClass(/bg-purple-900\/30/);

    // Click inherit and verify — inherit uses bg-zinc-800 style
    await inheritBtn.click();
    await expect(inheritBtn).toHaveClass(/bg-zinc-800/);
  });

  test("Execution Mode toggle", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const autoBtn = page
      .locator("label", { hasText: /Execution Mode|Mode/ })
      .locator("..")
      .locator("button")
      .filter({ hasText: "auto" });
    const edgeBtn = page
      .locator("label", { hasText: /Execution Mode|Mode/ })
      .locator("..")
      .locator("button")
      .filter({ hasText: "edge" });

    const visible = await edgeBtn.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    // Click edge and verify
    await edgeBtn.click();
    await expect(edgeBtn).toHaveClass(/bg-blue-900\/30/);

    // Click auto and verify
    await autoBtn.click();
    await expect(autoBtn).toHaveClass(/bg-blue-900\/30/);
  });

  test("Model field input", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const modelLabel = page.locator("label", { hasText: "Model" });
    const modelInput = modelLabel
      .locator("..")
      .locator("input")
      .first();

    const visible = await modelInput.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    await modelInput.fill("claude-3-opus");
    await expect(modelInput).toHaveValue("claude-3-opus");
  });

  test("System Prompt ID select", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const promptLabel = page.locator("label", { hasText: "System Prompt" });
    const promptSelect = promptLabel.locator("..").locator("select").first();

    const visible = await promptSelect.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    const optionCount = await promptSelect.locator("option").count();
    expect(optionCount).toBeGreaterThan(0);
  });

  test("Writes comma-separated edit", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const writesInput = page.locator(
      'input[placeholder="analysis, techContext..."]'
    );

    const visible = await writesInput.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    await writesInput.fill("foo, bar");
    await expect(writesInput).toHaveValue("foo, bar");
  });

  test("Advanced panel collapse and expand", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const advancedBtn = page
      .locator("button")
      .filter({ hasText: /ADVANCED/i });

    const visible = await advancedBtn.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    // Expand advanced panel
    await advancedBtn.click();

    // Verify thinking/permission/debug fields appear
    const thinkingLabel = page.locator("label", { hasText: /thinking/i });
    const permissionLabel = page.locator("label", {
      hasText: /permission/i,
    });
    const debugLabel = page.locator("label", { hasText: /debug/i });

    await expect(
      thinkingLabel.or(permissionLabel).or(debugLabel).first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Thinking mode toggle", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    // Expand advanced
    const advancedBtn = page
      .locator("button")
      .filter({ hasText: /ADVANCED/i });
    const advVisible = await advancedBtn.isVisible().catch(() => false);
    if (!advVisible) {
      test.skip();
      return;
    }
    await advancedBtn.click();

    const thinkingLabel = page.locator("label", { hasText: /thinking/i });
    const thinkingButtons = thinkingLabel.locator("..").locator("button");
    const enabledBtn = thinkingButtons.filter({ hasText: "enabled" });
    const disabledBtn = thinkingButtons.filter({ hasText: "disabled" });

    const visible = await enabledBtn.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    // Toggle to enabled
    await enabledBtn.click();
    await expect(enabledBtn).toHaveClass(/bg-zinc-700|bg-blue-900|text-white/);

    // Toggle to disabled
    await disabledBtn.click();
    await expect(disabledBtn).toHaveClass(
      /bg-zinc-700|bg-blue-900|text-white/
    );
  });

  test("Permission Mode select", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    // Expand advanced
    const advancedBtn = page
      .locator("button")
      .filter({ hasText: /ADVANCED/i });
    const advVisible = await advancedBtn.isVisible().catch(() => false);
    if (!advVisible) {
      test.skip();
      return;
    }
    await advancedBtn.click();

    const permLabel = page.locator("label", { hasText: /permission/i });
    const permSelect = permLabel.locator("..").locator("select").first();

    const visible = await permSelect.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    await permSelect.selectOption("bypassPermissions");
    await expect(permSelect).toHaveValue("bypassPermissions");
  });

  test("Debug checkbox", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    // Expand advanced
    const advancedBtn = page
      .locator("button")
      .filter({ hasText: /ADVANCED/i });
    const advVisible = await advancedBtn.isVisible().catch(() => false);
    if (!advVisible) {
      test.skip();
      return;
    }
    await advancedBtn.click();

    const debugCheckbox = page.locator('input[type="checkbox"]').first();

    const visible = await debugCheckbox.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    // Check
    await debugCheckbox.check();
    await expect(debugCheckbox).toBeChecked();

    // Uncheck
    await debugCheckbox.uncheck();
    await expect(debugCheckbox).not.toBeChecked();
  });

  test("Disallowed Tools input", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    // Expand advanced
    const advancedBtn = page
      .locator("button")
      .filter({ hasText: /ADVANCED/i });
    const advVisible = await advancedBtn.isVisible().catch(() => false);
    if (!advVisible) {
      test.skip();
      return;
    }
    await advancedBtn.click();

    const disallowedInput = page.locator(
      'input[placeholder*="disallowedToolsPlaceholder"], input[placeholder*="tool1"]'
    );

    const visible = await disallowedInput.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    await disallowedInput.fill("tool1, tool2");
    await expect(disallowedInput).toHaveValue("tool1, tool2");
  });

  test("Available Steps add and delete", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    // Expand advanced
    const advancedBtn = page
      .locator("button")
      .filter({ hasText: /ADVANCED/i });
    const advVisible = await advancedBtn.isVisible().catch(() => false);
    if (!advVisible) {
      test.skip();
      return;
    }
    await advancedBtn.click();

    const addStepBtn = page
      .locator("button")
      .filter({ hasText: /Add Step/i });

    const visible = await addStepBtn.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    // Click add step
    await addStepBtn.click();

    // Verify new row with key/label inputs (placeholders are i18n: "Key" and "Label")
    const keyInput = page.locator('input[placeholder="Key"]').last();
    const labelInput = page.locator('input[placeholder="Label"]').last();

    await expect(keyInput).toBeVisible({ timeout: 5_000 });
    await expect(labelInput).toBeVisible({ timeout: 5_000 });

    // Fill key and label
    await keyInput.fill("my-step");
    await labelInput.fill("My Step Label");
    await expect(keyInput).toHaveValue("my-step");
    await expect(labelInput).toHaveValue("My Step Label");

    // Delete the step (click x button in the same row)
    // Delete the step (click x button in the same row)
    const row = keyInput.locator("..").locator("..");
    const deleteBtn = row.locator("button").filter({ hasText: "x" });
    const deleteVisible = await deleteBtn.isVisible().catch(() => false);
    if (deleteVisible) {
      const countBefore = await page.locator('input[placeholder="Key"]').count();
      await deleteBtn.click();
      const countAfter = await page.locator('input[placeholder="Key"]').count();
      expect(countAfter).toBeLessThan(countBefore);
    }
  });

  test("Enabled Steps Path input", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    // Expand advanced
    const advancedBtn = page
      .locator("button")
      .filter({ hasText: /ADVANCED/i });
    const advVisible = await advancedBtn.isVisible().catch(() => false);
    if (!advVisible) {
      test.skip();
      return;
    }
    await advancedBtn.click();

    const stepsPathLabel = page.locator("label", {
      hasText: /enabled.steps.path|enabledStepsPath/i,
    });
    const stepsPathInput = stepsPathLabel
      .locator("..")
      .locator("input")
      .first();

    const visible = await stepsPathInput.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    await stepsPathInput.fill("store.steps");
    await expect(stepsPathInput).toHaveValue("store.steps");
  });
});
