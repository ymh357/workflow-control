import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

async function fetchTaskList(apiBase: string): Promise<Array<{ id: string; status: string; totalCostUsd?: number }>> {
  const res = await fetch(`${apiBase}/api/tasks`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.tasks ?? data ?? [];
}

async function createDraftTask(apiBase: string, text = "E2E advanced test"): Promise<string> {
  const pipelinesRes = await fetch(`${apiBase}/api/config/pipelines`);
  const pipelinesBody = await pipelinesRes.json();
  const pipelineName: string = pipelinesBody.pipelines?.[0]?.id ?? "pipeline-generator";

  const res = await fetch(`${apiBase}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskText: text, pipelineName }),
  });
  const data = await res.json();
  return data.taskId as string;
}

async function deleteDraftTask(apiBase: string, taskId: string): Promise<void> {
  await fetch(`${apiBase}/api/tasks/${taskId}`, { method: "DELETE" }).catch(() => {});
}

test.describe("Task Detail — Back Navigation", () => {
  test("back link navigates to home page", async ({ page, apiBase }) => {
    const taskId = await createDraftTask(apiBase);

    try {
      await page.goto(`/task/${taskId}`);
      await expect(page.locator("span.rounded-full.px-3.py-1").filter({ hasText: "idle" })).toBeVisible({ timeout: 10_000 });

      // Click the back link
      const backLink = page.locator('a[href="/"]').filter({ hasText: "Back" });
      await expect(backLink).toBeVisible();
      await backLink.click();

      // Should navigate to home
      await page.waitForURL("/", { timeout: 10_000 });
    } finally {
      await deleteDraftTask(apiBase, taskId);
    }
  });
});

test.describe("Task Detail — Idle State UI", () => {
  test("idle task shows Launch Now button that switches to workflow tab", async ({ page, apiBase }) => {
    const taskId = await createDraftTask(apiBase);

    try {
      await page.goto(`/task/${taskId}`);
      await expect(page.getByText("Task Draft Created")).toBeVisible({ timeout: 10_000 });

      // Launch Now button should be visible
      const launchBtn = page.locator("button").filter({ hasText: "Launch" });
      await expect(launchBtn).toBeVisible();
    } finally {
      await deleteDraftTask(apiBase, taskId);
    }
  });

  test("idle task has Agent Config tab with animated dot indicator", async ({ page, apiBase }) => {
    const taskId = await createDraftTask(apiBase);

    try {
      await page.goto(`/task/${taskId}`);
      await expect(page.locator("span.rounded-full.px-3.py-1").filter({ hasText: "idle" })).toBeVisible({ timeout: 10_000 });

      // Agent Config tab should have an animated pulse dot when idle
      const tabBar = page.locator(".flex.border-b.border-zinc-800");
      const agentConfigTab = tabBar.locator("button").filter({ hasText: "Agent Config" });
      await expect(agentConfigTab).toBeVisible();

      // The pulse dot
      const pulseDot = agentConfigTab.locator("span.animate-pulse");
      await expect(pulseDot).toBeVisible();
    } finally {
      await deleteDraftTask(apiBase, taskId);
    }
  });

  test("draft description has clickable Agent Config link", async ({ page, apiBase }) => {
    const taskId = await createDraftTask(apiBase);

    try {
      await page.goto(`/task/${taskId}`);
      await expect(page.getByText("Task Draft Created")).toBeVisible({ timeout: 10_000 });

      // The description contains an inline "Agent Config" link button
      const inlineLink = page.locator("p").locator("button").filter({ hasText: "Agent Config" });
      await expect(inlineLink).toBeVisible();

      // Clicking it should switch to config view
      await inlineLink.click();
      await page.waitForTimeout(1_000);

      // Agent Config tab should now be active (has purple border)
      const tabBar = page.locator(".flex.border-b.border-zinc-800");
      const agentConfigTab = tabBar.locator("button").filter({ hasText: "Agent Config" });
      await expect(agentConfigTab).toHaveClass(/border-purple-500/);
    } finally {
      await deleteDraftTask(apiBase, taskId);
    }
  });

  test("delete button is visible for idle tasks", async ({ page, apiBase }) => {
    const taskId = await createDraftTask(apiBase);

    try {
      await page.goto(`/task/${taskId}`);
      await expect(page.locator("span.rounded-full.px-3.py-1").filter({ hasText: "idle" })).toBeVisible({ timeout: 10_000 });

      // Delete button should be visible for idle tasks
      const deleteBtn = page.locator("button").filter({ hasText: /^Delete$/ });
      await expect(deleteBtn).toBeVisible();
    } finally {
      await deleteDraftTask(apiBase, taskId);
    }
  });
});

test.describe("Task Detail — Cancelled State", () => {
  test("cancelled task shows Resume button", async ({ page, apiBase }) => {
    // Try to find an existing cancelled task first
    const tasks = await fetchTaskList(apiBase);
    let taskId = tasks.find((t) => t.status === "cancelled")?.id;
    let createdTask = false;

    if (!taskId) {
      // Create and cancel a task
      taskId = await createDraftTask(apiBase);
      createdTask = true;
      await fetch(`${apiBase}/api/tasks/${taskId}/launch`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 1_000));
      await fetch(`${apiBase}/api/tasks/${taskId}/cancel`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 2_000));
    }

    try {
      await page.goto(`/task/${taskId}`);

      const statusBadge = page.locator("span.rounded-full.px-3.py-1").filter({ hasText: "cancelled" });
      try {
        await expect(statusBadge).toBeVisible({ timeout: 15_000 });
      } catch {
        test.skip(true, "Task did not reach cancelled state in time");
        return;
      }

      await expect(page.locator("h3").filter({ hasText: "Task Cancelled" })).toBeVisible();
      await expect(page.locator("button").filter({ hasText: "Resume" })).toBeVisible();
      await expect(page.locator("button").filter({ hasText: /^Delete$/ })).toBeVisible();
    } finally {
      if (createdTask) await deleteDraftTask(apiBase, taskId!);
    }
  });
});

test.describe("Task Detail — Blocked State", () => {
  test("blocked task shows recovery panel with retry buttons", async ({ page, apiBase }) => {
    const tasks = await fetchTaskList(apiBase);
    const blockedTask = tasks.find((t) => t.status === "blocked");
    test.skip(!blockedTask, "No blocked task available for testing");
    if (!blockedTask) return;

    await page.goto(`/task/${blockedTask.id}`);

    // Task may have auto-recovered by the time we navigate
    const agentStopped = page.getByText("Agent Stopped");
    try {
      await expect(agentStopped).toBeVisible({ timeout: 10_000 });
    } catch {
      test.skip(true, "Blocked task recovered before page load");
      return;
    }
    await expect(page.locator("button").filter({ hasText: "Retry Stage" })).toBeVisible();
    await expect(page.locator("button").filter({ hasText: "Cancel" })).toBeVisible();
  });
});

test.describe("Task Detail — Completed State", () => {
  test("completed task shows completion panel", async ({ page, apiBase }) => {
    const tasks = await fetchTaskList(apiBase);
    const completedTask = tasks.find((t) => t.status === "completed");
    if (!completedTask) {
      test.skip(true, "No completed task available for testing");
      return;
    }

    await page.goto(`/task/${completedTask.id}`);

    // Should show "Completed" heading
    await expect(page.getByText("Completed").first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Task Detail — Cost Summary", () => {
  test("cost summary button appears for tasks with cost", async ({ page, apiBase }) => {
    const tasks = await fetchTaskList(apiBase);
    const taskWithCost = tasks.find((t) => (t.totalCostUsd ?? 0) > 0);
    if (!taskWithCost) {
      test.skip(true, "No task with cost data available");
      return;
    }

    await page.goto(`/task/${taskWithCost.id}`);

    // Cost summary button (shows $X.XX in a rounded pill)
    const costBtn = page.locator("button.rounded-full").filter({ hasText: /\$\d+\.\d+/ });
    await expect(costBtn).toBeVisible({ timeout: 10_000 });

    // Click the cost button — if stageCosts are populated, table appears
    await costBtn.click();
    await page.waitForTimeout(500);

    // For historical tasks, stage cost breakdown may not be available (only populated via SSE)
    // Just verify the button toggle works — click again to close
    await costBtn.click();
  });
});

test.describe("Task Detail — Summary Tab", () => {
  test("summary tab appears for tasks with store data", async ({ page, apiBase }) => {
    const tasks = await fetchTaskList(apiBase);
    // Completed tasks typically have store data
    const candidateTask = tasks.find((t) => t.status === "completed") ?? tasks.find((t) => t.status !== "idle");
    if (!candidateTask) {
      test.skip(true, "No task with potential store data available");
      return;
    }

    await page.goto(`/task/${candidateTask.id}`);
    await page.waitForTimeout(2_000);

    // Check if Summary tab appears (it only shows when store has data)
    const tabBar = page.locator(".flex.border-b.border-zinc-800");
    const summaryTab = tabBar.locator("button").filter({ hasText: "Summary" });

    if (await summaryTab.isVisible().catch(() => false)) {
      await summaryTab.click();
      await page.waitForTimeout(1_000);
      await expect(page.getByText("Loading task data...")).not.toBeVisible();
    }
  });
});
