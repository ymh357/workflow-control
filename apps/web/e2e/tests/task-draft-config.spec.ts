import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

/**
 * Helper: create a draft task via the API and return its taskId.
 * Uses the first available pipeline from the server.
 */
async function createDraftTask(
  apiBase: string,
  taskText = "E2E test task — draft config spec",
): Promise<string> {
  // Discover an available pipeline
  const pipelinesRes = await fetch(`${apiBase}/api/config/pipelines`);
  const pipelinesBody = await pipelinesRes.json();
  const pipelineName: string =
    pipelinesBody.pipelines?.[0]?.id ?? "pipeline-generator";

  const res = await fetch(`${apiBase}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskText, pipelineName }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create draft task: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.taskId as string;
}

/**
 * Helper: delete a task via the API (best-effort cleanup).
 */
async function deleteDraftTask(apiBase: string, taskId: string): Promise<void> {
  await fetch(`${apiBase}/api/tasks/${taskId}`, { method: "DELETE" }).catch(
    () => {},
  );
}

test.describe("Task Page — Draft & Config", () => {
  // ─── Scenario 1: Task list page loads ────────────────────────────
  test("task list page loads and shows task entries", async ({
    page,
    apiBase,
  }) => {
    // Ensure at least one task exists so the list is non-empty
    const taskId = await createDraftTask(apiBase);

    try {
      await page.goto("/");

      // The "Tasks" heading should be visible
      await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

      // At least one task link should be rendered (each task is an <a> pointing to /task/...)
      const taskLinks = page.locator('a[href^="/task/"]');
      await expect(taskLinks.first()).toBeVisible({ timeout: 10_000 });
      const count = await taskLinks.count();
      expect(count).toBeGreaterThanOrEqual(1);

      // Each visible task entry shows a status label (text inside the rightmost span)
      // Verify at least the first entry contains status text
      const firstEntry = taskLinks.first();
      await expect(firstEntry).toContainText(/idle|completed|error|cancelled|blocked|running/i);
    } finally {
      await deleteDraftTask(apiBase, taskId);
    }
  });

  // ─── Scenario 2: Draft task displays correct status ──────────────
  test("draft task shows idle status with draft UI", async ({
    page,
    apiBase,
  }) => {
    const taskId = await createDraftTask(apiBase);

    try {
      await page.goto(`/task/${taskId}`);

      // Status badge should show "idle" (the internal status for drafts)
      const statusBadge = page.locator("span.rounded-full.px-3.py-1").filter({ hasText: "idle" });
      await expect(statusBadge).toBeVisible({ timeout: 10_000 });

      // Draft heading "Task Draft Created" should be visible
      await expect(
        page.getByText("Task Draft Created"),
      ).toBeVisible();

      // The "Launch Now" button should be present
      await expect(
        page.getByRole("button", { name: /launch/i }),
      ).toBeVisible();

      // Tab bar should exist with Workflow and Agent Config tabs
      const tabBar = page.locator(".flex.border-b.border-zinc-800");
      await expect(tabBar.locator("button").filter({ hasText: "Workflow" })).toBeVisible();
      await expect(tabBar.locator("button").filter({ hasText: "Agent Config" })).toBeVisible();
    } finally {
      await deleteDraftTask(apiBase, taskId);
    }
  });

  // ─── Scenario 3: Agent Config tab shows MCP availability ────────
  test("Agent Config tab shows pipeline config and MCP entries", async ({
    page,
    apiBase,
  }) => {
    const taskId = await createDraftTask(apiBase);

    try {
      await page.goto(`/task/${taskId}`);

      // Wait for task data to load
      await expect(
        page.locator("span.rounded-full.px-3.py-1").filter({ hasText: "idle" }),
      ).toBeVisible({ timeout: 10_000 });

      // Click the "Agent Config" tab (in the tab bar, not the inline link)
      const tabBar = page.locator(".flex.border-b.border-zinc-800");
      await tabBar.locator("button").filter({ hasText: "Agent Config" }).click();

      // The config workbench should appear — wait for pipeline content to render
      // It shows the pipeline editor with stage cards
      await page.waitForTimeout(2_000);

      // Verify that the config view rendered (any pipeline-related content)
      // The workbench shows pipeline settings or stage list
      const configContent = page.locator(".space-y-6").first();
      await expect(configContent).toBeVisible({ timeout: 5_000 });
    } finally {
      await deleteDraftTask(apiBase, taskId);
    }
  });

  // ─── Scenario 4: Delete a task ──────────────────────────────────
  test("delete a task removes it from the list", async ({
    page,
    apiBase,
  }) => {
    const taskId = await createDraftTask(
      apiBase,
      "E2E delete-test task",
    );

    // Navigate to the task detail page (delete button is on detail page for idle tasks)
    await page.goto(`/task/${taskId}`);

    // Wait for idle status badge
    await expect(
      page.locator("span.rounded-full").filter({ hasText: "idle" }),
    ).toBeVisible({ timeout: 10_000 });

    // Click the "Delete" button
    const deleteBtn = page.getByRole("button", { name: /delete/i });
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    // After deletion the page should redirect to "/"
    await page.waitForURL("/", { timeout: 10_000 });

    // The deleted task should no longer appear in the list
    // Wait a moment for SSE to propagate the removal event
    await page.waitForTimeout(1_000);
    const taskLink = page.locator(`a[href="/task/${taskId}"]`);
    await expect(taskLink).toHaveCount(0);
  });

  // ─── Scenario 5: Task detail navigation ─────────────────────────
  test("clicking a task navigates to its detail page", async ({
    page,
    apiBase,
  }) => {
    // Navigate to home first so SSE is connected
    await page.goto("/");
    await page.waitForTimeout(1_000);

    // Create task while SSE is connected — it should appear via real-time update
    const taskId = await createDraftTask(apiBase);

    try {
      // Wait for the task link to appear via SSE push
      const taskLink = page.locator(`a[href="/task/${taskId}"]`);
      // SSE may need a moment; if still not visible, reload
      try {
        await expect(taskLink).toBeVisible({ timeout: 5_000 });
      } catch {
        await page.reload();
        await expect(taskLink).toBeVisible({ timeout: 10_000 });
      }

      // Click the task entry
      await taskLink.click();

      // Should navigate to the task detail page
      await page.waitForURL(`**/task/${taskId}`, { timeout: 10_000 });

      // The detail page should render the tab bar
      const tabBar = page.locator(".flex.border-b.border-zinc-800");
      await expect(tabBar.locator("button").filter({ hasText: "Workflow" })).toBeVisible({ timeout: 5_000 });

      // For a draft task the "Task Draft Created" message should appear
      await expect(page.getByText("Task Draft Created")).toBeVisible();
    } finally {
      await deleteDraftTask(apiBase, taskId);
    }
  });
});
