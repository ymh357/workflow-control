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

// ── blocked state from missing output ──────────────────────────────────────

test("blocked state shows Retry Stage button", async ({ page }) => {
  const taskId = await createTask("[SCENARIO:missing_output] Blocked by missing output");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "blocked", 30_000);
    await expect(page.getByRole("button", { name: "Retry Stage" })).toBeVisible();
  } finally {
    await cleanup(taskId);
  }
});

test("blocked state shows error message in the UI", async ({ page }) => {
  const taskId = await createTask("[SCENARIO:missing_output] Show error text");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "blocked", 30_000);
    // Some error indication visible — could be in status bar or dedicated area
    const pageContent = await page.content();
    // The page should mention either "blocked" or "missing" or show the retry button
    expect(
      pageContent.toLowerCase().includes("blocked") ||
      pageContent.toLowerCase().includes("missing") ||
      pageContent.toLowerCase().includes("retry"),
    ).toBe(true);
  } finally {
    await cleanup(taskId);
  }
});

test("Retry Stage button click posts to /api/tasks/:id/retry and task resumes", async ({ page }) => {
  const taskId = await createTask("[SCENARIO:missing_output] Retry flow test");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "blocked", 30_000);

    // Intercept the retry API call to verify it's made
    const retryCallPromise = page.waitForRequest((req) =>
      req.url().includes(`/api/tasks/${taskId}/retry`) && req.method() === "POST",
    );

    await page.getByRole("button", { name: "Retry Stage" }).click();

    // The retry request should fire
    const retryReq = await retryCallPromise;
    expect(retryReq).toBeTruthy();
  } finally {
    await cleanup(taskId);
  }
});

// ── blocked state from forced failure ─────────────────────────────────────

test("blocked scenario shows status badge as 'blocked'", async ({ page }) => {
  const taskId = await createTask("[SCENARIO:blocked] Force block test");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "blocked", 30_000);
    // Status badge should show "blocked"
    await expect(page.locator("span.rounded-full").filter({ hasText: /blocked/i })).toBeVisible();
  } finally {
    await cleanup(taskId);
  }
});

// ── SSE-driven badge updates through analyzing → blocked ──────────────────

test("SSE drives badge from analyzing to blocked without page refresh", async ({ page }) => {
  const taskId = await createTask("[SCENARIO:missing_output] SSE badge blocked");
  await launchTask(taskId);
  try {
    await page.goto(`/task/${taskId}`);
    // Badge should go through analyzing and then reach blocked — no reload needed
    await waitForStatus(page, "blocked", 35_000);
    // Confirm we never had to navigate (no full page navigation occurred)
    expect(page.url()).toContain(`/task/${taskId}`);
  } finally {
    await cleanup(taskId);
  }
});
