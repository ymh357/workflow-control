import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

const openWorkbench = async (page: import("@playwright/test").Page) => {
  await page.goto("/config");
  await expect(page.locator("text=Loading System Configuration")).not.toBeVisible({ timeout: 15_000 });
  await page.locator("button", { hasText: "Blueprint & Intelligence" }).click();
};

const selectTestPipeline = async (page: import("@playwright/test").Page, pipelineId: string) => {
  const pipelineCard = page.locator(".grid.grid-cols-1.gap-3 > div").filter({ hasText: pipelineId });
  await expect(pipelineCard).toBeVisible({ timeout: 10_000 });
  await pipelineCard.locator("button.flex-1").click();
  await expect(page.locator("button").filter({ hasText: "Pipeline Settings" })).toBeVisible({ timeout: 10_000 });
};

async function createTestPipeline(apiBase: string): Promise<string> {
  const id = `e2e-int-${Date.now()}`;
  await fetch(`${apiBase}/api/config/pipelines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return id;
}

async function getPromptFiles(apiBase: string, pipelineId: string): Promise<string[]> {
  const res = await fetch(`${apiBase}/api/config/pipelines/${pipelineId}/prompts/system`);
  if (!res.ok) return [];
  const data = await res.json();
  // API returns { prompts: ["analysis.md", "tech-prep.md", ...] }
  return data.prompts ?? [];
}

async function getPipelineData(apiBase: string, pipelineId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`);
  if (!res.ok) return {};
  const data = await res.json();
  // API returns { raw, parsed } where parsed has the pipeline object
  return data.parsed ?? {};
}

test.describe("Config Integration — Stage Rename Prompt Migration", () => {
  test("renaming a stage migrates its prompt key after save", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);

    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Step 1: Add an AI Agent stage
      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "AI Agent" }).click();
      await page.waitForTimeout(500);

      // Step 2: Select the stage and go to Prompt tab
      const stageCard = page.locator('[role="button"]').filter({ has: page.locator(".text-sm.font-bold.text-zinc-100") });
      await expect(stageCard.first()).toBeVisible({ timeout: 5_000 });
      await stageCard.first().click();

      const promptTab = page.locator("button").filter({ hasText: /^Prompt$/ });
      await expect(promptTab).toBeVisible({ timeout: 5_000 });
      await promptTab.click();

      // Step 3: Create a prompt for this stage
      const createPromptBtn = page.locator("button").filter({ hasText: "Create Prompt" });
      if (await createPromptBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await createPromptBtn.click();
        await page.waitForTimeout(500);
      }

      // Step 4: Save the pipeline first to persist the initial state
      const saveBtn = page.locator("button").filter({ hasText: /^Save$/ });
      await saveBtn.click();
      await page.waitForTimeout(2_000);

      // Verify initial prompt file exists via API
      const initialFiles = await getPromptFiles(apiBase, pipelineId);
      expect(initialFiles.length).toBeGreaterThanOrEqual(1);
      const oldFile = initialFiles[0]; // e.g. "agent-1.md"

      // Step 5: Switch to Config tab and rename the stage
      const configTab = page.locator("button").filter({ hasText: /^Config$/ });
      await configTab.click();
      await page.waitForTimeout(300);

      const nameInput = page.locator("label").filter({ hasText: "Stage Name" }).locator("..").locator("input").first();
      await expect(nameInput).toBeVisible({ timeout: 5_000 });
      const newName = "renamedStage";
      await nameInput.fill(newName);
      await page.waitForTimeout(300);

      // Step 6: Save again — this should trigger prompt migration
      await saveBtn.click();
      await page.waitForTimeout(2_000);

      // Step 7: Verify via API that the prompt file was renamed
      const newFiles = await getPromptFiles(apiBase, pipelineId);
      // The new prompt file should be "renamed-stage.md" (normalizePromptKey converts camelCase to kebab-case)
      const expectedFile = "renamed-stage.md";
      expect(newFiles).toContain(expectedFile);
      // Old file should be deleted (if name was different)
      if (oldFile !== expectedFile) {
        expect(newFiles).not.toContain(oldFile);
      }

      // Step 8: Verify stage name changed in pipeline YAML
      const pipeline = await getPipelineData(apiBase, pipelineId);
      const stages = (pipeline.stages ?? []) as Array<{ name: string }>;
      expect(stages.some((s) => s.name === newName)).toBe(true);
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });
});

test.describe("Config Integration — Save and Reload Round-trip", () => {
  test("modifying pipeline settings persists across page reload", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);

    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Step 1: Open Pipeline Settings and modify description
      const settingsHeader = page.locator("button").filter({ hasText: /Pipeline Settings/i });
      await settingsHeader.click();
      await page.waitForTimeout(300);

      const descTextarea = page.locator("textarea").first();
      await expect(descTextarea).toBeVisible({ timeout: 5_000 });
      const testDesc = `E2E integration test ${Date.now()}`;
      await descTextarea.fill(testDesc);

      // Step 2: Save
      const saveBtn = page.locator("button").filter({ hasText: /^Save$/ });
      await saveBtn.click();

      // Wait for save to complete
      await expect(page.locator("text=Saved")).toBeVisible({ timeout: 10_000 });

      // Step 3: Reload the page entirely
      await page.goto("/config");
      await expect(page.locator("text=Loading System Configuration")).not.toBeVisible({ timeout: 15_000 });
      await page.locator("button", { hasText: "Blueprint & Intelligence" }).click();
      await selectTestPipeline(page, pipelineId);

      // Step 4: Open Pipeline Settings and verify description persisted
      await settingsHeader.click();
      await page.waitForTimeout(300);

      const reloadedDesc = page.locator("textarea").first();
      await expect(reloadedDesc).toBeVisible({ timeout: 5_000 });
      await expect(reloadedDesc).toHaveValue(testDesc);
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("adding a stage and saving persists stage count", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);

    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Step 1: Add two stages
      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "AI Agent" }).click();
      await page.waitForTimeout(500);

      await page.locator("button", { hasText: "+ Add Stage" }).click();
      await page.locator("button", { hasText: "Human Gate" }).click();
      await page.waitForTimeout(500);

      // Step 2: Save
      const saveBtn = page.locator("button").filter({ hasText: /^Save$/ });
      await saveBtn.click();
      await expect(page.locator("text=Saved")).toBeVisible({ timeout: 10_000 });

      // Step 3: Verify via API
      const pipeline = await getPipelineData(apiBase, pipelineId);
      const stages = (pipeline.stages ?? []) as Array<{ name: string; type: string }>;
      expect(stages.length).toBe(2);
      expect(stages[0].type).toBe("agent");
      expect(stages[1].type).toBe("human_confirm");
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });

  test("engine change persists after save and reload", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);

    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Step 1: Open Pipeline Settings and switch engine to gemini
      const settingsHeader = page.locator("button").filter({ hasText: /Pipeline Settings/i });
      await settingsHeader.click();
      await page.waitForTimeout(300);

      const geminiBtn = page.locator("button").filter({ hasText: "gemini" }).first();
      await geminiBtn.click();
      await page.waitForTimeout(300);

      // Step 2: Save
      const saveBtn = page.locator("button").filter({ hasText: /^Save$/ });
      await saveBtn.click();
      await expect(page.locator("text=Saved")).toBeVisible({ timeout: 10_000 });

      // Step 3: Verify via API
      const pipeline = await getPipelineData(apiBase, pipelineId);
      expect(pipeline.engine).toBe("gemini");

      // Step 4: Reload UI and verify engine badge
      await page.goto("/config");
      await expect(page.locator("text=Loading System Configuration")).not.toBeVisible({ timeout: 15_000 });
      await page.locator("button", { hasText: "Blueprint & Intelligence" }).click();
      await selectTestPipeline(page, pipelineId);

      // Engine badge in top bar should show "gemini"
      const engineBadge = page.locator("span.uppercase").filter({ hasText: "gemini" }).first();
      await expect(engineBadge).toBeVisible({ timeout: 5_000 });
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });
});

test.describe("Config Integration — Fragment CRUD Persistence", () => {
  test("adding a fragment and saving persists it", async ({ page, apiBase }) => {
    const pipelineId = await createTestPipeline(apiBase);

    try {
      await openWorkbench(page);
      await selectTestPipeline(page, pipelineId);

      // Step 1: Go to Fragments
      const fragmentsBtn = page.locator("button").filter({ hasText: /^Fragments/ });
      await fragmentsBtn.click();
      await expect(page.getByText("Knowledge Fragments")).toBeVisible({ timeout: 5_000 });

      // Step 2: Add a new fragment
      const plusBtn = page.locator("button").filter({ hasText: /^\+$/ });
      await plusBtn.click();
      const input = page.locator('input[placeholder="fragment-name"]');
      await input.fill("test-integration");
      await page.locator("button").filter({ hasText: /^Add$/ }).click();
      await page.waitForTimeout(500);

      // Also modify something to ensure dirty state (add a stage too)
      // Navigate to stage list and add a stage
      const stageArea = page.locator("button").filter({ hasText: "+ Add Stage" });
      await stageArea.click();
      await page.locator("button", { hasText: "AI Agent" }).click();
      await page.waitForTimeout(500);

      // Go back to fragments to verify tab still there
      await fragmentsBtn.click();
      await page.waitForTimeout(300);

      // Step 3: Save
      const saveBtn = page.locator("button").filter({ hasText: /^Save$/ });
      await saveBtn.click();
      await expect(page.locator("text=Saved")).toBeVisible({ timeout: 10_000 });

      // Step 4: Reload and verify fragment still exists
      await page.goto("/config");
      await expect(page.locator("text=Loading System Configuration")).not.toBeVisible({ timeout: 15_000 });
      await page.locator("button", { hasText: "Blueprint & Intelligence" }).click();
      await selectTestPipeline(page, pipelineId);

      await fragmentsBtn.click();
      await expect(page.getByText("Knowledge Fragments")).toBeVisible({ timeout: 5_000 });

      // Fragment tab with name "test-integration" should still be there
      const fragTab = page.locator("button.rounded").filter({ hasText: "test-integration" });
      await expect(fragTab).toBeVisible({ timeout: 5_000 });
    } finally {
      await fetch(`${apiBase}/api/config/pipelines/${pipelineId}`, { method: "DELETE" });
    }
  });
});
