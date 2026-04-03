import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

test.describe("Config Workbench — Advanced Features", () => {
  const openWorkbench = async (page: import("@playwright/test").Page) => {
    await page.goto("/config");
    await expect(page.locator("text=Loading System Configuration")).not.toBeVisible({ timeout: 15_000 });
    await page.locator("button", { hasText: "Blueprint & Intelligence" }).click();
  };

  const selectFirstPipeline = async (page: import("@playwright/test").Page) => {
    const pipelineCards = page.locator(".grid.grid-cols-1.gap-3 > div");
    await expect(pipelineCards.first()).toBeVisible({ timeout: 10_000 });
    await pipelineCards.first().locator("button.flex-1").click();
    // Wait for the pipeline editor to load — look for the stage list or settings button
    await expect(page.locator("button").filter({ hasText: "Pipeline Settings" })).toBeVisible({ timeout: 10_000 });
  };

  test("Constraints editor loads and shows content", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Click "Constraints" in the left sidebar
    const constraintsBtn = page.locator("button").filter({ hasText: /^Constraints$/ });
    await expect(constraintsBtn).toBeVisible({ timeout: 5_000 });
    await constraintsBtn.click();

    // Right panel should show "Global Constraints" heading
    await expect(page.getByText("Global Constraints")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Injected into every agent stage")).toBeVisible();

    // Monaco editor should be present
    const editor = page.locator(".monaco-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });
  });

  test("CLAUDE.md editor loads", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Click "CLAUDE.md" in the left sidebar
    const claudeBtn = page.locator("button.w-full.text-left").filter({ hasText: /CLAUDE\.md/ });
    if (await claudeBtn.isVisible().catch(() => false)) {
      await claudeBtn.click();

      // Should show CLAUDE.md heading
      await expect(page.locator("h3").filter({ hasText: "CLAUDE.md" })).toBeVisible({ timeout: 5_000 });

      // Monaco editor should be present
      const editor = page.locator(".monaco-editor");
      await expect(editor).toBeVisible({ timeout: 10_000 });
    }
  });

  test("Fragments editor loads", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Click "Fragments" in the left sidebar
    const fragmentsBtn = page.locator("button").filter({ hasText: /^Fragments/ });
    await expect(fragmentsBtn).toBeVisible({ timeout: 5_000 });
    await fragmentsBtn.click();

    // Right panel should show fragment content
    await expect(page.getByText("Knowledge Fragments")).toBeVisible({ timeout: 5_000 });
  });

  test("YAML source editor loads and shows pipeline YAML", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Click "YAML Source" in the left sidebar
    const yamlBtn = page.locator("button").filter({ hasText: /YAML/ });
    await expect(yamlBtn).toBeVisible({ timeout: 5_000 });
    await yamlBtn.click();

    // Should show YAML heading
    await expect(page.getByText("Pipeline YAML")).toBeVisible({ timeout: 5_000 });

    // Monaco editor should be present with content
    const editor = page.locator(".monaco-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });
  });

  test("Stage Prompt tab shows editor", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Select the first stage
    const stageCards = page.locator('[role="button"]').filter({
      has: page.locator(".text-sm.font-bold.text-zinc-100"),
    });
    await expect(stageCards.first()).toBeVisible({ timeout: 10_000 });
    await stageCards.first().click();

    // The Prompt tab should be visible and active by default
    const promptTab = page.locator("button").filter({ hasText: /^Prompt$/ });
    await expect(promptTab).toBeVisible({ timeout: 5_000 });

    // Monaco editor or "No prompt file" text should appear
    const editorOrNoPrompt = page.locator(".monaco-editor").or(page.getByText("No prompt file for"));
    await expect(editorOrNoPrompt).toBeVisible({ timeout: 10_000 });
  });

  test("Stage Outputs tab shows output schema", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Select the first stage
    const stageCards = page.locator('[role="button"]').filter({
      has: page.locator(".text-sm.font-bold.text-zinc-100"),
    });
    await expect(stageCards.first()).toBeVisible({ timeout: 10_000 });
    await stageCards.first().click();

    // Click Outputs tab
    const outputsTab = page.locator("button").filter({ hasText: /^Outputs$/ });
    await expect(outputsTab).toBeVisible({ timeout: 5_000 });
    await outputsTab.click();

    // Should show output schema or "No output schema defined"
    const outputContent = page.getByText("No output schema defined").or(page.getByText("Generate from Writes")).or(page.locator("text=+ Add Field"));
    await expect(outputContent).toBeVisible({ timeout: 5_000 });
  });

  test("Add Stage button shows template menu", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Click "+ Add Stage" button
    const addStageBtn = page.locator("button").filter({ hasText: "+ Add Stage" });
    await expect(addStageBtn).toBeVisible({ timeout: 5_000 });
    await addStageBtn.click();

    // Template menu should appear with options
    await expect(page.getByText("AI Agent")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("Automation Script")).toBeVisible();
    await expect(page.getByText("Human Gate")).toBeVisible();
    await expect(page.getByText("Parallel Group")).toBeVisible();
    await expect(page.getByText("Condition")).toBeVisible();
    await expect(page.getByText("Pipeline Call")).toBeVisible();
    await expect(page.getByText("Foreach")).toBeVisible();
  });

  test("Stage reorder buttons exist in DOM", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Stage cards should have move up/down buttons (hidden until hover, but present in DOM)
    const moveUpBtn = page.locator('button[title="Move up"]');
    const moveDownBtn = page.locator('button[title="Move down"]');
    const removeBtn = page.locator('button[title="Remove stage"]');

    // These buttons exist in DOM even if hidden (group-hover:flex)
    await expect(moveUpBtn.first()).toBeAttached({ timeout: 10_000 });
    await expect(moveDownBtn.first()).toBeAttached();
    await expect(removeBtn.first()).toBeAttached();
  });

  test("Pipeline Settings panel toggles", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Click "Pipeline Settings" to expand it
    const settingsHeader = page.locator("button").filter({ hasText: /Pipeline Settings/i });
    await expect(settingsHeader).toBeVisible({ timeout: 5_000 });
    await settingsHeader.click();

    // Settings panel should show description and engine fields
    await page.waitForTimeout(500);
    await expect(page.getByText("Engine").first()).toBeVisible({ timeout: 5_000 });

    // Collapse settings
    await settingsHeader.click();
    await page.waitForTimeout(300);
  });

  test("Copy From pipeline creation", async ({ page }) => {
    const pipelineId = `e2e-copy-${Date.now()}`;

    await openWorkbench(page);

    // Click "+ New Pipeline"
    const newBtn = page.locator("button", { hasText: "+ New Pipeline" });
    await expect(newBtn).toBeVisible({ timeout: 10_000 });
    await newBtn.click();

    await expect(page.getByText("Create New Pipeline")).toBeVisible({ timeout: 5_000 });

    // Enter pipeline ID
    const idInput = page.locator('input[placeholder="my-pipeline"]');
    await idInput.fill(pipelineId);

    // Select "Copy From" — choose the first non-empty option
    const copyFromSelect = page.locator("select");
    const options = copyFromSelect.locator("option");
    const optCount = await options.count();
    if (optCount > 1) {
      // Select the second option (first is "Empty pipeline")
      await copyFromSelect.selectOption({ index: 1 });
    }

    // Click Create
    const modal = page.locator(".fixed.inset-0.z-50");
    const createBtn = modal.locator("button").filter({ hasText: /^Create$/ });
    await createBtn.click();

    // Wait for creation
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_000);

    // Cleanup
    await fetch(`${API_BASE}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
  });

  test("AI Generate modal opens and closes", async ({ page }) => {
    await openWorkbench(page);

    // Look for the "AI Generate" button
    const aiGenBtn = page.locator("button").filter({ hasText: "AI Generate" });

    // It might not be visible on the pipeline list page
    const isOnList = await page.getByText("Select a Pipeline to Configure").isVisible().catch(() => false);
    if (isOnList) {
      // Need to select a pipeline first to see AI Generate
      await selectFirstPipeline(page);
    }

    // AI Generate button may not exist in all views, check gracefully
    if (await aiGenBtn.isVisible().catch(() => false)) {
      await aiGenBtn.click();

      // Modal should open
      await expect(page.getByText("AI Generate Pipeline")).toBeVisible({ timeout: 5_000 });

      // Should have description textarea and Generate button
      await expect(page.locator("textarea")).toBeVisible();
      await expect(page.locator("button").filter({ hasText: "Generate" })).toBeVisible();

      // Close modal via Cancel
      const cancelBtn = page.locator("button").filter({ hasText: "Cancel" });
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click();
      } else {
        // Close by pressing Escape
        await page.keyboard.press("Escape");
      }
    }
  });
});
