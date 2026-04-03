import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

test.describe("Home Page — Task Creation Form", () => {
  test("textarea is directly visible for task input", async ({ page }) => {
    await page.goto("/");

    // Textarea should be visible immediately (no radio toggle)
    const textarea = page.locator("textarea");
    await expect(textarea).toBeVisible();

    // No radio buttons should exist
    const radios = page.locator('input[type="radio"]');
    await expect(radios).toHaveCount(0);
  });

  test("pipeline selector shows grouped options", async ({ page }) => {
    await page.goto("/");

    // Pipeline selector should be visible (select element)
    const pipelineSelect = page.locator("select");
    await expect(pipelineSelect).toBeVisible({ timeout: 10_000 });

    // Should have at least one option
    const options = pipelineSelect.locator("option");
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Should have engine-grouped optgroups
    const optgroups = pipelineSelect.locator("optgroup");
    const groupCount = await optgroups.count();
    expect(groupCount).toBeGreaterThanOrEqual(1);

    // First optgroup label should be uppercase engine name (CLAUDE, GEMINI, etc.)
    const firstLabel = await optgroups.first().getAttribute("label");
    expect(firstLabel).toMatch(/^[A-Z]+$/);
  });

  test("text mode form accepts input", async ({ page }) => {
    await page.goto("/");

    // Fill in task text
    const textarea = page.locator("textarea");
    await textarea.fill("E2E test task description");
    await expect(textarea).toHaveValue("E2E test task description");

    // Fill in repo name
    const repoInput = page.locator('input[placeholder="Repository name (optional)"]');
    await repoInput.fill("test-repo");
    await expect(repoInput).toHaveValue("test-repo");

    // Analyze button should be visible
    const analyzeBtn = page.locator('button[type="submit"]');
    await expect(analyzeBtn).toBeVisible();
    await expect(analyzeBtn).toContainText("Analyze");
  });
});

test.describe("Home Page — Task List Features", () => {
  test("summary stats bar shows running and cost info", async ({ page, apiBase }) => {
    // Create a task to ensure the list is non-empty
    const taskId = await createDraftTask(apiBase);

    try {
      await page.goto("/");
      await page.waitForTimeout(2_000);

      // If no tasks appear via SSE, reload
      const taskLinks = page.locator('a[href^="/task/"]');
      if (!(await taskLinks.first().isVisible().catch(() => false))) {
        await page.reload();
      }
      await expect(taskLinks.first()).toBeVisible({ timeout: 10_000 });

      // Summary stats bar should be visible when tasks exist
      const statsBar = page.locator(".flex.gap-4.text-xs.text-zinc-500");
      await expect(statsBar).toBeVisible();

      // Should contain running count and total cost
      await expect(statsBar).toContainText(/running/);
      await expect(statsBar).toContainText(/Total/);
    } finally {
      await fetch(`${apiBase}/api/tasks/${taskId}`, { method: "DELETE" }).catch(() => {});
    }
  });

  test("task groups render with correct headings", async ({ page, apiBase }) => {
    // Create a draft task — it goes to "Completed & Other" group (idle = other)
    const taskId = await createDraftTask(apiBase);

    try {
      await page.goto("/");
      await page.waitForTimeout(2_000);

      if (!(await page.locator('a[href^="/task/"]').first().isVisible().catch(() => false))) {
        await page.reload();
      }
      await expect(page.locator('a[href^="/task/"]').first()).toBeVisible({ timeout: 10_000 });

      // "Completed & Other" group should be visible (idle tasks go here)
      await expect(page.getByText(/Completed & Other/)).toBeVisible();
    } finally {
      await fetch(`${apiBase}/api/tasks/${taskId}`, { method: "DELETE" }).catch(() => {});
    }
  });
});

async function createDraftTask(apiBase: string): Promise<string> {
  const pipelinesRes = await fetch(`${apiBase}/api/config/pipelines`);
  const pipelinesBody = await pipelinesRes.json();
  const pipelineName: string = pipelinesBody.pipelines?.[0]?.id ?? "pipeline-generator";

  const res = await fetch(`${apiBase}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskText: "E2E home form test", pipelineName }),
  });
  const data = await res.json();
  return data.taskId as string;
}
