import { test, expect } from "../fixtures";

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

// --- Part 1: Pipeline Visualizer ---

test.describe("Config Pipeline Visualizer", () => {
  test("Visualizer modal opens with Pipeline Flow title", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Click "Preview Flow" button at the bottom of the left column
    const previewBtn = page.locator("button").filter({ hasText: /Preview Flow/ });
    await expect(previewBtn).toBeVisible({ timeout: 5_000 });
    await previewBtn.click();

    // Modal should appear with "Pipeline Flow" title
    const modal = page.locator(".fixed.inset-0.z-50");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.locator("h3").filter({ hasText: "Pipeline Flow" })).toBeVisible();
  });

  test("Visualizer modal closes via close button", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    const previewBtn = page.locator("button").filter({ hasText: /Preview Flow/ });
    await previewBtn.click();

    const modal = page.locator(".fixed.inset-0.z-50");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Click the close button (rounded-full bg-zinc-800)
    const closeBtn = modal.locator("button.rounded-full.bg-zinc-800");
    await closeBtn.click();

    await expect(modal).not.toBeVisible({ timeout: 3_000 });
  });

  test("Visualizer contains pipeline stage content", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    const previewBtn = page.locator("button").filter({ hasText: /Preview Flow/ });
    await previewBtn.click();

    const modal = page.locator(".fixed.inset-0.z-50");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // The PipelineVisualizer renders stage content inside the modal body
    const modalBody = modal.locator(".flex-1");
    await expect(modalBody.first()).toBeVisible({ timeout: 5_000 });

    // There should be some text content rendered (stage names)
    const textContent = await modal.textContent();
    expect(textContent?.trim().length).toBeGreaterThan(0);
  });
});

// --- Part 2: Pipeline List Navigation ---

test.describe("Config Pipeline List Navigation", () => {
  test("Pipeline card displays engine badge", async ({ page }) => {
    await openWorkbench(page);

    const pipelineCards = page.locator(".grid.grid-cols-1.gap-3 > div");
    await expect(pipelineCards.first()).toBeVisible({ timeout: 10_000 });

    // Engine badge should be one of: claude, gemini, mixed
    const engineBadge = pipelineCards.first().locator("span.font-bold.uppercase").first();
    await expect(engineBadge).toBeVisible({ timeout: 5_000 });
    const badgeText = await engineBadge.textContent();
    expect(["claude", "gemini", "mixed"]).toContain(badgeText?.trim().toLowerCase());
  });

  test("Pipeline card displays stage count", async ({ page }) => {
    await openWorkbench(page);

    const pipelineCards = page.locator(".grid.grid-cols-1.gap-3 > div");
    await expect(pipelineCards.first()).toBeVisible({ timeout: 10_000 });

    // Stage count text like "N stages"
    const stageCount = pipelineCards.first().locator("text=/\\d+ stages/");
    await expect(stageCount).toBeVisible({ timeout: 5_000 });
  });

  test("Return to pipeline list after entering editor", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Verify we are in the editor
    await expect(page.locator("button").filter({ hasText: "Pipeline Settings" })).toBeVisible();

    // Navigate back by re-entering the config page and clicking workbench tab
    await page.goto("/config");
    await expect(page.locator("text=Loading System Configuration")).not.toBeVisible({ timeout: 15_000 });
    await page.locator("button", { hasText: "Blueprint & Intelligence" }).click();

    // Should see the pipeline list heading again
    await expect(page.getByText("Select a Pipeline to Configure")).toBeVisible({ timeout: 10_000 });
  });
});

// --- Part 3: Gemini.md Editor ---

test.describe("Config Gemini.md Editor", () => {
  test("Gemini.md editor loads with Monaco editor", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Click "GEMINI.md" button in the left sidebar globals section
    const geminiBtn = page.locator("button.w-full.text-left").filter({ hasText: /GEMINI\.md/ });
    if (!(await geminiBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await geminiBtn.click();

    // Right panel should show GEMINI.md heading
    await expect(page.locator("h3").filter({ hasText: "GEMINI.md" })).toBeVisible({ timeout: 5_000 });

    // Monaco editor should be present
    const editor = page.locator(".monaco-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });
  });
});

// --- Part 4: Parallel Group Detail ---

test.describe("Config Parallel Group Detail", () => {
  test("Parallel group header shows group detail panel", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Look for a parallel group card (dashed border with "parallel" badge)
    const parallelBadge = page.locator("span.text-emerald-400", { hasText: "parallel" });
    if (!(await parallelBadge.first().isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip();
      return;
    }

    // Click the group header (the role="button" container of the parallel group)
    const groupHeader = parallelBadge.first().locator("xpath=ancestor::div[@role='button']");
    await groupHeader.click();

    // Right panel should show "Parallel Group" heading
    await expect(page.locator("h3").filter({ hasText: "Parallel Group" })).toBeVisible({ timeout: 5_000 });

    // Group name input should be present
    const groupNameInput = page.locator("input").filter({ has: page.locator("xpath=ancestor::div[.//label[contains(text(),'Group Name') or contains(text(),'group')]]") });
    // Alternatively just check that an input exists in the detail panel
    const detailPanel = page.locator(".space-y-4").filter({ has: page.locator("h3", { hasText: "Parallel Group" }) });
    await expect(detailPanel.locator("input")).toBeVisible({ timeout: 5_000 });
  });
});
