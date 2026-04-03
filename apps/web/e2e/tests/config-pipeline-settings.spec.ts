import { test, expect } from "../fixtures";

test.describe("Config Workbench — Pipeline Settings Panel", () => {
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

  const openPipelineSettings = async (page: import("@playwright/test").Page) => {
    const settingsHeader = page.locator("button").filter({ hasText: /Pipeline Settings/i });
    await settingsHeader.click();
    await page.waitForTimeout(300);
  };

  test.beforeEach(async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openPipelineSettings(page);
  });

  test("Engine tri-state toggle switches between claude, gemini, mixed", async ({ page }) => {
    const engineButtons = page.locator("button").filter({ hasText: /^(claude|gemini|mixed)$/ });
    await expect(engineButtons).toHaveCount(3);

    const geminiBtn = page.locator("button").filter({ hasText: /^gemini$/ });
    const mixedBtn = page.locator("button").filter({ hasText: /^mixed$/ });
    const claudeBtn = page.locator("button").filter({ hasText: /^claude$/ });

    // Click gemini — should get purple styling
    await geminiBtn.click();
    await expect(geminiBtn).toHaveClass(/bg-purple-900\/30/);

    // Click mixed — should get emerald styling
    await mixedBtn.click();
    await expect(mixedBtn).toHaveClass(/bg-emerald-900\/30/);

    // Click claude — should get blue styling
    await claudeBtn.click();
    await expect(claudeBtn).toHaveClass(/bg-blue-900\/30/);
  });

  test("Description textarea accepts and displays multiline text", async ({ page }) => {
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    const multilineText = "Line one\nLine two\nLine three";
    await textarea.fill(multilineText);

    await expect(textarea).toHaveValue(multilineText);
  });

  test("Use Cases input accepts comma-separated values", async ({ page }) => {
    const useCasesInput = page.locator('input[placeholder]').nth(0);
    // Find the input whose placeholder matches useCasesPlaceholder — it's the first input inside the settings panel
    const settingsPanel = page.locator(".rounded-lg.border.border-zinc-800.bg-zinc-950\\/30");
    const inputs = settingsPanel.locator("input");
    // Use Cases is the first input in the panel
    const useCases = inputs.nth(0);
    await expect(useCases).toBeVisible({ timeout: 5_000 });

    await useCases.fill("code-review, bug-fix");
    await expect(useCases).toHaveValue("code-review, bug-fix");
  });

  test("Default Execution Mode toggle switches between auto and edge", async ({ page }) => {
    const edgeBtn = page.locator("button").filter({ hasText: /^edge$/i });
    await expect(edgeBtn).toBeVisible({ timeout: 5_000 });

    await edgeBtn.click();
    await expect(edgeBtn).toHaveClass(/bg-blue-900\/30/);

    // Switch back to auto
    const autoBtn = page.locator("button").filter({ hasText: /^auto$/i });
    await autoBtn.click();
    await expect(autoBtn).toHaveClass(/bg-blue-900\/30/);
  });

  test("Hooks input accepts comma-separated values", async ({ page }) => {
    const hooksInput = page.locator('input[placeholder="format-on-write..."]');
    await expect(hooksInput).toBeVisible({ timeout: 5_000 });

    await hooksInput.fill("lint-check, format");
    await expect(hooksInput).toHaveValue("lint-check, format");
  });

  test("Skills input accepts value", async ({ page }) => {
    const skillsInput = page.locator('input[placeholder="security-review..."]');
    await expect(skillsInput).toBeVisible({ timeout: 5_000 });

    await skillsInput.fill("code-audit");
    await expect(skillsInput).toHaveValue("code-audit");
  });

  test("Title Path input accepts value", async ({ page }) => {
    const titlePathInput = page.locator('input[placeholder="analysis.title"]');
    await expect(titlePathInput).toBeVisible({ timeout: 5_000 });

    await titlePathInput.fill("result.title");
    await expect(titlePathInput).toHaveValue("result.title");
  });

  test("Completion Path input accepts value", async ({ page }) => {
    const completionPathInput = page.locator('input[placeholder="prUrl"]');
    await expect(completionPathInput).toBeVisible({ timeout: 5_000 });

    await completionPathInput.fill("output.prUrl");
    await expect(completionPathInput).toHaveValue("output.prUrl");
  });

  test("CLAUDE.md File input accepts value", async ({ page }) => {
    const claudeMdInput = page.locator('input[placeholder="global.md"]');
    await expect(claudeMdInput).toBeVisible({ timeout: 5_000 });

    await claudeMdInput.fill("custom.md");
    await expect(claudeMdInput).toHaveValue("custom.md");
  });

  test("Collapse and expand preserves field values", async ({ page }) => {
    // Modify description
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    const testValue = "persistence-test-value";
    await textarea.fill(testValue);
    await expect(textarea).toHaveValue(testValue);

    // Collapse the settings panel
    const settingsHeader = page.locator("button").filter({ hasText: /Pipeline Settings/i });
    await settingsHeader.click();
    await page.waitForTimeout(300);

    // The textarea should no longer be visible
    await expect(textarea).not.toBeVisible();

    // Re-expand
    await settingsHeader.click();
    await page.waitForTimeout(300);

    // Value should be preserved
    const textareaAfter = page.locator("textarea").first();
    await expect(textareaAfter).toBeVisible({ timeout: 5_000 });
    await expect(textareaAfter).toHaveValue(testValue);
  });
});
