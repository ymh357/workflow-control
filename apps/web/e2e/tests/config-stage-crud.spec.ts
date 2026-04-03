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

async function createTestPipeline(apiBase: string): Promise<string> {
  const id = `e2e-crud-${Date.now()}`;
  await fetch(`${apiBase}/api/config/pipelines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return id;
}

const selectTestPipeline = async (page: import("@playwright/test").Page, pipelineId: string) => {
  const pipelineCard = page.locator(".grid.grid-cols-1.gap-3 > div").filter({ hasText: pipelineId });
  await expect(pipelineCard).toBeVisible({ timeout: 10_000 });
  await pipelineCard.locator("button.flex-1").click();
  await expect(page.locator("button").filter({ hasText: "Pipeline Settings" })).toBeVisible({ timeout: 10_000 });
};

test.describe("Config Stage CRUD & Ordering", () => {
  test("Add AI Agent stage", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Empty pipeline — click "+ Add Stage" and select "AI Agent"
      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "AI Agent" }).click();

      // New agent stage card should appear with "30 turns"
      const stageCard = page.locator('[role="button"]').filter({ has: page.locator(".text-sm.font-bold.text-zinc-100") });
      await expect(stageCard.first()).toBeVisible({ timeout: 5_000 });
      await expect(stageCard.first().locator("text=30 turns")).toBeVisible();
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Add Script stage", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Automation Script" }).click();

      // Verify script type badge appears
      const stageCard = page.locator('[role="button"]').filter({ has: page.locator(".text-sm.font-bold.text-zinc-100") });
      await expect(stageCard.first()).toBeVisible({ timeout: 5_000 });
      // Badge element specifically has uppercase class
      await expect(stageCard.first().locator("span.uppercase").filter({ hasText: /script/i })).toBeVisible();
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Add Human Gate stage", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Human Gate" }).click();

      const stageCard = page.locator('[role="button"]').filter({ has: page.locator(".text-sm.font-bold.text-zinc-100") });
      await expect(stageCard.first()).toBeVisible({ timeout: 5_000 });
      await expect(stageCard.first().locator("span.uppercase").filter({ hasText: /gate/i })).toBeVisible();
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Add Parallel Group", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Parallel Group" }).click();

      // Verify parallel group card appeared — it has "parallel" badge text
      const parallelBadge = page.locator("span.uppercase").filter({ hasText: /parallel/i });
      await expect(parallelBadge).toBeVisible({ timeout: 5_000 });

      // The group header shows child count "2 stages"
      await expect(page.getByText("2 stages")).toBeVisible({ timeout: 5_000 });
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Stage move up/down", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Add two stages: AI Agent then Script
      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "AI Agent" }).click();
      await page.waitForTimeout(500);

      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Automation Script" }).click();
      await page.waitForTimeout(500);

      // Get the names of the two stages
      const stageCards = page.locator('[role="button"]').filter({ has: page.locator(".text-sm.font-bold.text-zinc-100") });
      await expect(stageCards).toHaveCount(2, { timeout: 5_000 });
      const firstName = await stageCards.nth(0).locator(".text-sm.font-bold.text-zinc-100").textContent();
      const secondName = await stageCards.nth(1).locator(".text-sm.font-bold.text-zinc-100").textContent();

      // Hover the second stage card to reveal move buttons, then click move-up
      await stageCards.nth(1).hover();
      await page.waitForTimeout(200);
      const moveUpBtns = page.locator('button[title="Move up"]');
      await moveUpBtns.last().click({ force: true });
      await page.waitForTimeout(500);

      // Verify the second stage name is now in first position
      const newFirstName = await stageCards.nth(0).locator(".text-sm.font-bold.text-zinc-100").textContent();
      const newSecondName = await stageCards.nth(1).locator(".text-sm.font-bold.text-zinc-100").textContent();
      expect(newFirstName).toBe(secondName);
      expect(newSecondName).toBe(firstName);
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Stage delete with confirm", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Add a stage first
      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "AI Agent" }).click();
      await page.waitForTimeout(300);

      const stageCard = page.locator('[role="button"]').filter({ has: page.locator(".text-sm.font-bold.text-zinc-100") });
      await expect(stageCard.first()).toBeVisible({ timeout: 5_000 });

      // Set up dialog handler to accept the confirm
      page.on("dialog", async (dialog) => {
        await dialog.accept();
      });

      // Force-click remove button
      await page.locator('button[title="Remove stage"]').first().click({ force: true });
      await page.waitForTimeout(500);

      // Verify stage is removed
      await expect(stageCard).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Parallel Group add child", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Add a parallel group
      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Parallel Group" }).click();
      await page.waitForTimeout(300);

      const parallelCard = page.locator(".border-dashed").first();
      await expect(parallelCard).toBeVisible();

      // Verify initial 2 child stages
      const childStages = parallelCard.locator(".border-l-2 > div[role='button']");
      await expect(childStages).toHaveCount(2);

      // Click "Add child stage" button within the group
      await parallelCard.locator("button", { hasText: /Add child stage/i }).click();
      await page.waitForTimeout(300);

      // Verify child count increased to 3
      await expect(childStages).toHaveCount(3);
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Parallel Group dissolve", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Add a parallel group (which comes with 2 child stages)
      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Parallel Group" }).click();
      await page.waitForTimeout(300);

      const parallelCard = page.locator(".border-dashed");
      await expect(parallelCard.first()).toBeVisible();

      // Hover group header to reveal dissolve button, then click
      const groupHeader = parallelCard.first().locator("[role='button']").first();
      await groupHeader.hover();
      await page.waitForTimeout(300);

      const dissolveBtn = page.locator('button[title="Dissolve group"]').first();
      // Use dispatchEvent as backup if force-click doesn't work
      await dissolveBtn.click({ force: true });
      await page.waitForTimeout(500);

      // After dissolve, 2 child stages should now be regular stage cards
      const stageCards = page.locator('[role="button"]').filter({ has: page.locator(".text-sm.font-bold.text-zinc-100") });
      await expect(stageCards).toHaveCount(2, { timeout: 5_000 });
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Parallel Group remove child", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Add a parallel group
      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Parallel Group" }).click();
      await page.waitForTimeout(300);

      const parallelCard = page.locator(".border-dashed").first();
      await expect(parallelCard).toBeVisible();

      // Add a child to have 3 children (minimum for removal is > 2)
      await parallelCard.locator("button", { hasText: /Add child stage/i }).click();
      await page.waitForTimeout(300);

      const childStages = parallelCard.locator(".border-l-2 > div[role='button']");
      await expect(childStages).toHaveCount(3);

      // Set up dialog handler in case confirm dialog appears
      page.on("dialog", async (dialog) => {
        await dialog.accept();
      });

      // Force-click remove button on the last child stage
      const childRemoveButtons = parallelCard.locator('.border-l-2 button[title="Remove stage"]');
      await childRemoveButtons.last().click({ force: true });
      await page.waitForTimeout(300);

      // Verify child count back to 2
      await expect(childStages).toHaveCount(2);
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Add Condition stage", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await selectTestPipeline(page, pipelineId);

      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Condition" }).click();

      // Should see condition badge in stage list
      const conditionBadge = page.locator("span.rounded.border", { hasText: "Condition" });
      await expect(conditionBadge).toBeVisible({ timeout: 5_000 });
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Add Pipeline Call stage", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await selectTestPipeline(page, pipelineId);

      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Pipeline Call" }).click();

      const pipelineBadge = page.locator("span.rounded.border", { hasText: "Pipeline" });
      await expect(pipelineBadge).toBeVisible({ timeout: 5_000 });
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Add Foreach stage", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);
    try {
      await selectTestPipeline(page, pipelineId);

      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Foreach" }).click();

      const foreachBadge = page.locator("span.rounded.border", { hasText: "Foreach" });
      await expect(foreachBadge).toBeVisible({ timeout: 5_000 });
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("Template menu dismissal", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    const addStageBtn = page.locator("button", { hasText: "+ Add Stage" });
    await addStageBtn.click();

    // Menu should be visible — template menu has these exact button texts
    const aiAgentOption = page.locator("button.w-full.text-left").filter({ hasText: "AI Agent" });
    await expect(aiAgentOption).toBeVisible({ timeout: 3_000 });

    // Click "+ Add Stage" again to toggle off
    await addStageBtn.click();
    await expect(aiAgentOption).not.toBeVisible({ timeout: 3_000 });

    // Open again and verify toggle works
    await addStageBtn.click();
    await expect(aiAgentOption).toBeVisible({ timeout: 3_000 });

    // Toggle off again
    await addStageBtn.click();
    await expect(aiAgentOption).not.toBeVisible({ timeout: 3_000 });
  });
});
