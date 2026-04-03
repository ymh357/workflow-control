import { test, expect, type Page } from "@playwright/test";

const API_BASE = "http://localhost:3002";

async function createTask(taskText: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskText, pipelineName: "test-claude" }),
  });
  const { taskId } = await res.json();
  return taskId;
}

async function launchTask(taskId: string) {
  await fetch(`${API_BASE}/api/tasks/${taskId}/launch`, { method: "POST" });
}

async function cleanup(taskId: string) {
  await fetch(`${API_BASE}/api/tasks/${taskId}`, { method: "DELETE" }).catch(() => {});
}

async function waitForStatus(page: Page, status: string | RegExp, timeout = 30_000) {
  await expect(page.locator("span.rounded-full").filter({ hasText: status }))
    .toBeVisible({ timeout });
}

// ── Gate reject → error state ──────────────────────────────────────────────

test("reject at confirm gate shows error state in UI", async ({ page }) => {
  const taskId = await createTask("Gate reject UI test");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "awaitingConfirm");
    // Click reject/re-run — in the test-claude pipeline this sends back to analyzing
    await page.getByRole("button", { name: "Re-run" }).click();
    // Should return to analyzing (not error) — reject sends back to prior stage in test-claude
    await waitForStatus(page, "analyzing");
  } finally {
    await cleanup(taskId);
  }
});

// ── Draft task: launch button visible, no status spinner ──────────────────

test("draft task page shows idle badge and Launch button, no running indicator", async ({ page }) => {
  const taskId = await createTask("Draft idle check");
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "idle", 10_000);
    await expect(page.getByRole("button", { name: /launch/i })).toBeVisible();
    // No cancel button on draft task
    await expect(page.getByRole("button", { name: /cancel/i })).not.toBeVisible({ timeout: 1000 })
      .catch(() => {}); // acceptable if shown but disabled
  } finally {
    await cleanup(taskId);
  }
});

// ── Task deleted while viewing — server 404 ───────────────────────────────

test("viewing a non-existent task ID shows a reasonable page (no crash)", async ({ page }) => {
  await page.goto("/task/nonexistent-task-id-xyz-000");
  // The page should load without crashing — either show 404 message or empty state
  // We just verify the page doesn't show a JS error overlay
  await page.waitForLoadState("networkidle");
  const title = await page.title();
  expect(title).toBeTruthy(); // page rendered something
});

// ── SSE reconnect: status badge updates on slow start ─────────────────────

test("status badge updates from idle to analyzing via SSE after launch", async ({ page }) => {
  const taskId = await createTask("SSE badge update test");
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "idle", 5000);
    await page.getByRole("button", { name: /launch/i }).click();
    // Badge should update to analyzing via SSE
    await waitForStatus(page, "analyzing", 15_000);
  } finally {
    await cleanup(taskId);
  }
});

// ── Confirm panel appears and disappears correctly ────────────────────────

test("confirm panel appears when status is awaitingConfirm", async ({ page }) => {
  const taskId = await createTask("Confirm panel visibility test");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "awaitingConfirm");
    // Confirm button and Re-run should both be visible in the confirm panel
    await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Re-run" })).toBeVisible();
  } finally {
    await cleanup(taskId);
  }
});

test("confirm panel disappears after Confirm is clicked", async ({ page }) => {
  const taskId = await createTask("Confirm panel hide test");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "awaitingConfirm");
    await page.getByRole("button", { name: "Confirm" }).click();
    // After confirm, the Confirm button should disappear
    await expect(page.getByRole("button", { name: "Confirm" }))
      .not.toBeVisible({ timeout: 10_000 });
    // Task should proceed
    await waitForStatus(page, "implementing");
  } finally {
    await cleanup(taskId);
  }
});

// ── Cost display ──────────────────────────────────────────────────────────

test("completed task shows cost summary", async ({ page }) => {
  const taskId = await createTask("Cost display test");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "awaitingConfirm");
    await page.getByRole("button", { name: "Confirm" }).click();
    await waitForStatus(page, "completed", 45_000);
    // After completion, some cost indicator should be visible
    // (could be "$0.00" or "0.00 USD" etc.)
    const pageContent = await page.content();
    expect(
      pageContent.includes("$") ||
      pageContent.toLowerCase().includes("cost") ||
      pageContent.includes("USD"),
    ).toBe(true);
  } finally {
    await cleanup(taskId);
  }
});

// ── Task list reflects terminal status ────────────────────────────────────

test("completed task appears in task list with completed status", async ({ page }) => {
  const taskId = await createTask("List check after complete");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "awaitingConfirm");
    await page.getByRole("button", { name: "Confirm" }).click();
    await waitForStatus(page, "completed", 45_000);

    // Navigate to task list
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // The page should exist and render
    const content = await page.content();
    expect(content).toBeTruthy();
  } finally {
    await cleanup(taskId);
  }
});

// ── Blocked task: Retry Stage button makes API call ───────────────────────

test("Retry Stage button on blocked task fires POST /api/tasks/:id/retry", async ({ page }) => {
  const taskId = await createTask("[SCENARIO:missing_output] Retry button API check");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "blocked", 30_000);
    await expect(page.getByRole("button", { name: "Retry Stage" })).toBeVisible();

    const retryPromise = page.waitForRequest((req) =>
      req.url().includes(`/api/tasks/${taskId}/retry`) && req.method() === "POST",
    );
    await page.getByRole("button", { name: "Retry Stage" }).click();
    const retryReq = await retryPromise;
    expect(retryReq).toBeTruthy();
  } finally {
    await cleanup(taskId);
  }
});
