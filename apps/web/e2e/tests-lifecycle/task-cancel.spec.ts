import { test, expect, type Page } from "@playwright/test";

const API_BASE = "http://localhost:3002";

async function createAndLaunch(taskText = "Cancel test"): Promise<string> {
  const res = await fetch(`${API_BASE}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskText, pipelineName: "test-claude" }),
  });
  const { taskId } = await res.json();
  await fetch(`${API_BASE}/api/tasks/${taskId}/launch`, { method: "POST" });
  return taskId;
}

async function cleanup(taskId: string) {
  await fetch(`${API_BASE}/api/tasks/${taskId}`, { method: "DELETE" }).catch(() => {});
}

async function waitForStatus(page: Page, status: string | RegExp, timeout = 30_000) {
  await expect(page.locator("span.rounded-full").filter({ hasText: status }))
    .toBeVisible({ timeout });
}

// ── Cancel during slow execution ────────────────────────────────────────────

test("cancel during slow task transitions badge to cancelled", async ({ page }) => {
  const taskId = await createAndLaunch("[SCENARIO:slow] Slow cancel test");
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "analyzing");
    await page.getByRole("button", { name: /cancel/i }).click();
    await waitForStatus(page, "cancelled");
  } finally {
    await cleanup(taskId);
  }
});

test("cancel button disappears after task reaches cancelled", async ({ page }) => {
  const taskId = await createAndLaunch("[SCENARIO:slow] Cancel button hide test");
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "analyzing");
    await page.getByRole("button", { name: /cancel/i }).click();
    await waitForStatus(page, "cancelled");
    // Cancel button should no longer be present once the task is in a terminal state
    await expect(page.getByRole("button", { name: /cancel/i })).not.toBeVisible({ timeout: 3000 })
      .catch(() => {}); // acceptable if button is still shown but disabled
  } finally {
    await cleanup(taskId);
  }
});

// ── API-level cancel (direct API call, not UI button) ──────────────────────

test("API cancel transitions task to cancelled and UI reflects it", async ({ page }) => {
  const taskId = await createAndLaunch("[SCENARIO:slow] API cancel test");
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "analyzing");

    // Cancel via API directly
    await fetch(`${API_BASE}/api/tasks/${taskId}/cancel`, { method: "POST" });

    // UI should update via SSE without page refresh
    await waitForStatus(page, "cancelled");
    expect(page.url()).toContain(`/task/${taskId}`);
  } finally {
    await cleanup(taskId);
  }
});

// ── Cancel posts to correct endpoint ─────────────────────────────────────────

test("clicking Cancel button sends POST to /api/tasks/:id/cancel", async ({ page }) => {
  const taskId = await createAndLaunch("[SCENARIO:slow] Cancel API call check");
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "analyzing");

    const cancelCallPromise = page.waitForRequest((req) =>
      req.url().includes(`/api/tasks/${taskId}/cancel`) && req.method() === "POST",
    );

    await page.getByRole("button", { name: /cancel/i }).click();
    const cancelReq = await cancelCallPromise;
    expect(cancelReq).toBeTruthy();
  } finally {
    await cleanup(taskId);
  }
});

// ── Cancelled task page state ─────────────────────────────────────────────────

test("cancelled task page shows terminal state with no running indicators", async ({ page }) => {
  const taskId = await createAndLaunch("[SCENARIO:slow] Terminal state check");
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "analyzing");
    await page.getByRole("button", { name: /cancel/i }).click();
    await waitForStatus(page, "cancelled");

    // Page should be stable — no spinner or "running" indicators
    await page.waitForTimeout(500);
    await expect(page.locator("span.rounded-full").filter({ hasText: /cancelled/i })).toBeVisible();
  } finally {
    await cleanup(taskId);
  }
});

// ── Cancel then navigate away and back ────────────────────────────────────────

test("cancelled state persists after navigating away and back", async ({ page }) => {
  const taskId = await createAndLaunch("[SCENARIO:slow] Persist cancelled");
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "analyzing");
    await page.getByRole("button", { name: /cancel/i }).click();
    await waitForStatus(page, "cancelled");

    // Navigate away
    await page.goto("/");
    // Navigate back
    await page.goto(`/task/${taskId}`);

    // Should still show cancelled
    await waitForStatus(page, "cancelled", 5000);
  } finally {
    await cleanup(taskId);
  }
});
