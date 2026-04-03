import { test, expect, type Page } from "@playwright/test";

const API_BASE = "http://localhost:3002";

async function createAndLaunch(taskText = "E2E lifecycle test"): Promise<string> {
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

test("draft task shows idle and Launch button", async ({ page }) => {
  const res = await fetch(`${API_BASE}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskText: "Draft only", pipelineName: "test-claude" }),
  });
  const { taskId } = await res.json();
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "idle");
    await expect(page.getByRole("button", { name: /launch/i })).toBeVisible();
  } finally {
    await cleanup(taskId);
  }
});

test("full happy path: idle to completed", async ({ page }) => {
  const taskId = await createAndLaunch();
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "analyzing");
    await waitForStatus(page, "awaitingConfirm");
    await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();
    await waitForStatus(page, "implementing");
    await waitForStatus(page, "completed", 45_000);
  } finally {
    await cleanup(taskId);
  }
});

test("confirm gate: reject sends back to analyzing", async ({ page }) => {
  const taskId = await createAndLaunch();
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "awaitingConfirm");
    await page.getByRole("button", { name: "Re-run" }).click();
    await waitForStatus(page, "analyzing");
  } finally {
    await cleanup(taskId);
  }
});

test("cancel a running task", async ({ page }) => {
  const taskId = await createAndLaunch("[SCENARIO:slow] Cancel test task");
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "analyzing");
    await page.getByRole("button", { name: /cancel/i }).click();
    await waitForStatus(page, "cancelled");
  } finally {
    await cleanup(taskId);
  }
});

test("missing output leads to blocked state", async ({ page }) => {
  const taskId = await createAndLaunch("[SCENARIO:missing_output] Output missing test");
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "blocked", 30_000);
    await expect(page.getByRole("button", { name: "Retry Stage" })).toBeVisible();
  } finally {
    await cleanup(taskId);
  }
});

test("SSE drives real-time status badge updates", async ({ page }) => {
  const taskId = await createAndLaunch();
  try {
    await page.goto(`/task/${taskId}`);
    await waitForStatus(page, "analyzing");
    await waitForStatus(page, "awaitingConfirm");
  } finally {
    await cleanup(taskId);
  }
});
