import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

test.describe("Config Workbench — MCP Binding", () => {
  // Helper: navigate to /config and click the Workbench tab
  const openWorkbench = async (page: import("@playwright/test").Page) => {
    await page.goto("/config");
    // Wait for the page to finish loading
    await expect(page.locator("text=Loading System Configuration")).not.toBeVisible({ timeout: 15_000 });
    // Click the "Blueprint & Intelligence" (workbench) tab
    const workbenchTab = page.locator("button", { hasText: "Blueprint & Intelligence" });
    await workbenchTab.click();
  };

  // Helper: select the first pipeline and wait for editor to load
  const selectFirstPipeline = async (page: import("@playwright/test").Page) => {
    const pipelineCards = page.locator(".grid.grid-cols-1.gap-3 > div");
    await expect(pipelineCards.first()).toBeVisible({ timeout: 10_000 });
    // Click the first pipeline's clickable area
    await pipelineCards.first().locator("button.flex-1").click();
    // Wait for the pipeline editor to appear (stage list is inside the editor)
    await expect(page.locator("text=Pipeline Settings")).toBeVisible({ timeout: 10_000 });
  };

  test("Scenario 1: Pipeline list loads", async ({ page }) => {
    await openWorkbench(page);

    // Verify pipeline list heading
    await expect(page.locator("text=Select a Pipeline to Configure")).toBeVisible({ timeout: 10_000 });

    // Verify at least one pipeline is listed
    const pipelineCards = page.locator(".grid.grid-cols-1.gap-3 > div");
    await expect(pipelineCards.first()).toBeVisible({ timeout: 10_000 });
    expect(await pipelineCards.count()).toBeGreaterThanOrEqual(1);
  });

  test("Scenario 2: Select and view pipeline stages", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Verify stage cards are shown in the left sidebar
    // Stage cards have role="button" inside the stage list
    const stageCards = page.locator('[role="button"]').filter({
      has: page.locator(".text-sm.font-bold.text-zinc-100"),
    });
    await expect(stageCards.first()).toBeVisible({ timeout: 10_000 });
    const stageCount = await stageCards.count();
    expect(stageCount).toBeGreaterThanOrEqual(1);

    // Click the first stage card (it may already be selected, click it anyway)
    await stageCards.first().click();

    // Verify the right panel shows stage detail with a "Stage Name" label or config tab
    // The stage detail shows tabs: Prompt, Config, Outputs
    const configTab = page.locator("button", { hasText: "Config" });
    await expect(configTab).toBeVisible({ timeout: 5_000 });
    await configTab.click();

    // Verify the MCPs field label appears in the config panel
    await expect(page.locator("text=MCPs")).toBeVisible({ timeout: 5_000 });
  });

  test("Scenario 3: Toggle MCP binding on a stage", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Click on the first stage card
    const stageCards = page.locator('[role="button"]').filter({
      has: page.locator(".text-sm.font-bold.text-zinc-100"),
    });
    await expect(stageCards.first()).toBeVisible({ timeout: 10_000 });
    await stageCards.first().click();

    // Switch to Config tab to see MCP checkboxes
    const configTab = page.locator("button", { hasText: "Config" });
    await expect(configTab).toBeVisible({ timeout: 5_000 });
    await configTab.click();

    // Find MCP toggle buttons (rendered as small pill buttons with MCP names)
    // They are inside the MCPs field section
    const mcpButtons = page.locator("button[type='button']").filter({
      has: page.locator("span.rounded-full"),
    });

    const mcpCount = await mcpButtons.count();
    if (mcpCount === 0) {
      // No MCP buttons available (no MCPs registered) — fall back to text input
      const mcpInput = page.locator('input[placeholder="e.g. notion, figma, context7"]');
      const inputVisible = await mcpInput.isVisible().catch(() => false);
      if (inputVisible) {
        // Type an MCP name into the input
        await mcpInput.fill("test-mcp");
        await expect(mcpInput).toHaveValue("test-mcp");
        // Clear it
        await mcpInput.fill("");
        await expect(mcpInput).toHaveValue("");
      }
      return;
    }

    // Get the first MCP button
    const firstMcp = mcpButtons.first();
    const initialClass = await firstMcp.getAttribute("class");
    const wasSelected = initialClass?.includes("bg-blue-900/40") ?? false;

    // Toggle the MCP on (or off if already selected)
    await firstMcp.click();
    await page.waitForTimeout(300);

    // Verify class changed (selected state uses bg-blue-900/40)
    const afterClickClass = await firstMcp.getAttribute("class");
    if (wasSelected) {
      expect(afterClickClass).not.toContain("bg-blue-900/40");
    } else {
      expect(afterClickClass).toContain("bg-blue-900/40");
    }

    // Toggle it back
    await firstMcp.click();
    await page.waitForTimeout(300);

    // Verify it reverted to original state
    const revertedClass = await firstMcp.getAttribute("class");
    if (wasSelected) {
      expect(revertedClass).toContain("bg-blue-900/40");
    } else {
      expect(revertedClass).not.toContain("bg-blue-900/40");
    }
  });

  test("Scenario 4: Validation warnings for missing capabilities", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Look for validation warnings in the ValidationBar or on stage cards
    // Stage cards show "N warn" or "N err" badges when there are issues
    // The ValidationBar at the bottom also shows warnings/errors
    const warnBadge = page.locator("text=/\\d+ warn/").first();
    const errBadge = page.locator("text=/\\d+ err/").first();
    const validationBar = page.locator("text=/warning|error/i").first();

    // At least one of these should be visible — if the pipeline has no issues,
    // we check for "No issues" text instead (which confirms validation runs)
    const noIssues = page.locator("text=No issues");

    // Wait for any of these to appear
    await expect(
      warnBadge.or(errBadge).or(validationBar).or(noIssues)
    ).toBeVisible({ timeout: 10_000 });

    // If there are warnings, verify they are displayed meaningfully
    const hasWarn = await warnBadge.isVisible().catch(() => false);
    const hasErr = await errBadge.isVisible().catch(() => false);
    const hasNoIssues = await noIssues.isVisible().catch(() => false);

    // At least one validation state should be visible
    expect(hasWarn || hasErr || hasNoIssues).toBe(true);
  });

  test("Scenario 5: Create a new pipeline", async ({ page }) => {
    const pipelineId = `e2e-test-${Date.now()}`;

    await openWorkbench(page);

    // Click the "+ New Pipeline" button
    const newBtn = page.locator("button", { hasText: "+ New Pipeline" });
    await expect(newBtn).toBeVisible({ timeout: 10_000 });
    await newBtn.click();

    // Modal should appear with "Create New Pipeline" heading
    await expect(page.locator("text=Create New Pipeline")).toBeVisible({ timeout: 5_000 });

    // Enter the pipeline ID
    const idInput = page.locator('input[placeholder="my-pipeline"]');
    await idInput.fill(pipelineId);

    // Leave "Copy From" as empty (Empty pipeline)
    // Click the "Create" button inside the modal
    const modal = page.locator(".fixed.inset-0.z-50");
    const createBtn = modal.locator("button", { hasText: /^Create$/ });
    await createBtn.click();

    // After creation the page loads the new pipeline editor.
    // Wait for modal to close, then navigate back to pipeline list.
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_000);

    // If we got into the editor, go back to the list
    const backBtn = page.getByText("Select a Pipeline to Configure");
    const inEditor = !(await backBtn.isVisible().catch(() => false));
    if (inEditor) {
      // Reload to get back to the pipeline list view
      await page.goto("/config");
      await openWorkbench(page);
    }

    // Verify the new pipeline appears in the list
    const pipelineCard = page.locator(".grid.grid-cols-1.gap-3 > div").filter({ hasText: pipelineId });
    await expect(pipelineCard).toBeVisible({ timeout: 10_000 });

    // Cleanup: delete the pipeline via API
    await fetch(`${API_BASE}/api/config/pipelines/${pipelineId}`, {
      method: "DELETE",
    });
  });

  test("Scenario 6: Delete a pipeline", async ({ page }) => {
    // Setup: create a throwaway pipeline via API
    const pipelineId = `e2e-del-${Date.now()}`;
    await fetch(`${API_BASE}/api/config/pipelines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pipelineId }),
    });

    await openWorkbench(page);

    // Verify the pipeline appears in the list
    await expect(page.locator(`text=${pipelineId}`)).toBeVisible({ timeout: 10_000 });

    // Click the delete (x) button on that pipeline card
    const pipelineCard = page.locator(".grid.grid-cols-1.gap-3 > div").filter({
      hasText: pipelineId,
    });
    await expect(pipelineCard).toBeVisible({ timeout: 5_000 });
    // The delete button is a small "x" button with title="Delete Pipeline"
    const deleteBtn = pipelineCard.locator('button[title="Delete Pipeline"]');
    await deleteBtn.click();

    // Confirm deletion in the modal
    await expect(page.locator("text=Delete Pipeline")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(`text=Are you sure you want to delete ${pipelineId}`)).toBeVisible();
    const confirmDeleteBtn = page.locator("button", { hasText: "Delete" }).last();
    await confirmDeleteBtn.click();

    // Verify the pipeline is no longer in the list
    await expect(page.locator(`.grid.grid-cols-1.gap-3 > div`).filter({ hasText: pipelineId })).toHaveCount(0, { timeout: 10_000 });
  });
});
