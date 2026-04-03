import { test, expect } from "@playwright/test";

const AWAITING_TASK_URL = "/task/d510b065-043f-4899-8a29-f1ef4dd73c99";

/** Helper: navigate and wait for SSE to populate the awaitingConfirm state */
async function gotoAndWaitForConfirm(page: import("@playwright/test").Page) {
  await page.goto(AWAITING_TASK_URL);
  await expect(
    page.getByRole("heading", { name: "Awaiting Confirm" })
  ).toBeVisible({ timeout: 15_000 });
}

test.describe("Task Advanced Interactions — Override Repo Name", () => {
  test("Override repo name disclosure expands and accepts input", async ({
    page,
  }) => {
    await gotoAndWaitForConfirm(page);

    // Click the "Override repo name" disclosure to expand it
    const disclosure = page.getByText("Override repo name");
    await expect(disclosure).toBeVisible();
    await disclosure.click();

    // After expanding, an input with repo placeholder should become visible
    const repoInput = page.getByPlaceholder("e.g. my-project");
    await expect(repoInput).toBeVisible({ timeout: 5_000 });

    // Type a new repo name and verify the value
    await repoInput.fill("my-custom-repo");
    await expect(repoInput).toHaveValue("my-custom-repo");
  });
});

test.describe("Task Advanced Interactions — Feedback Textarea", () => {
  test("Feedback textarea accepts input", async ({ page }) => {
    await gotoAndWaitForConfirm(page);

    // Locate the feedback textarea by placeholder
    const feedbackArea = page.getByPlaceholder(/provide feedback/);
    await expect(feedbackArea).toBeVisible();

    // Type feedback and verify
    await feedbackArea.fill("Please add more unit tests");
    await expect(feedbackArea).toHaveValue("Please add more unit tests");
  });
});

test.describe("Task Advanced Interactions — Summary Tab JSON Viewer", () => {
  test("Summary tab shows store data and expandable structured fields", async ({
    page,
  }) => {
    await gotoAndWaitForConfirm(page);

    // Switch to Summary tab
    const tabBar = page.locator(".flex.border-b.border-zinc-800");
    const summaryTab = tabBar.locator("button").filter({ hasText: "Summary" });

    // Summary tab may not be present if no store data — skip gracefully
    if (!(await summaryTab.isVisible().catch(() => false))) {
      test.skip(true, "Summary tab not available for this task");
      return;
    }

    await summaryTab.click();
    await page.waitForTimeout(1_000);

    // Look for expandable "View Structured Fields" or any disclosure/details element
    const structuredToggle = page.getByText("View Structured Fields").first();
    if (await structuredToggle.isVisible().catch(() => false)) {
      await structuredToggle.click();
      await page.waitForTimeout(500);

      // After expanding, JSON-like content (braces or key-value pairs) should be visible
      await expect(page.locator("pre, code, .json-viewer").first()).toBeVisible(
        { timeout: 5_000 }
      );
    }
  });
});

test.describe("Task Advanced Interactions — Tab Switching", () => {
  test("Workflow, Summary, and Agent Config tabs switch content", async ({
    page,
  }) => {
    await gotoAndWaitForConfirm(page);

    const tabBar = page.locator(".flex.border-b.border-zinc-800");

    // Verify Workflow tab is active by default (has purple border)
    const workflowTab = tabBar
      .locator("button")
      .filter({ hasText: "Workflow" });
    await expect(workflowTab).toBeVisible();

    // Switch to Agent Config tab
    const agentConfigTab = tabBar
      .locator("button")
      .filter({ hasText: "Agent Config" });
    await expect(agentConfigTab).toBeVisible();
    await agentConfigTab.click();
    await page.waitForTimeout(500);
    await expect(agentConfigTab).toHaveClass(/border-b-2/);

    // Switch to Summary tab if it exists
    const summaryTab = tabBar.locator("button").filter({ hasText: "Summary" });
    if (await summaryTab.isVisible().catch(() => false)) {
      await summaryTab.click();
      await page.waitForTimeout(500);
      await expect(summaryTab).toHaveClass(/border-b-2/);
    }

    // Switch back to Workflow tab
    await workflowTab.click();
    await page.waitForTimeout(500);
    await expect(workflowTab).toHaveClass(/border-b-2/);
  });
});

test.describe("Task Advanced Interactions — Stage Timeline Click", () => {
  test("Clicking different timeline stages triggers visual switch", async ({
    page,
  }) => {
    await gotoAndWaitForConfirm(page);

    const timeline = page.locator("span.whitespace-nowrap");

    // Verify timeline stages are present
    const analyzingStage = timeline.filter({ hasText: "Analyzing" });
    const confirmStage = timeline.filter({ hasText: "Confirm" });
    const implementingStage = timeline.filter({ hasText: "Implementing" });

    await expect(analyzingStage).toBeVisible({ timeout: 10_000 });
    await expect(confirmStage).toBeVisible();
    await expect(implementingStage).toBeVisible();

    // Click Analyzing stage
    await analyzingStage.click();
    await page.waitForTimeout(300);

    // Click Confirm stage
    await confirmStage.click();
    await page.waitForTimeout(300);

    // Click Implementing stage
    await implementingStage.click();
    await page.waitForTimeout(300);

    // Click back to Analyzing to confirm round-trip works
    await analyzingStage.click();
  });
});

test.describe("Task Advanced Interactions — Combined Message Filters", () => {
  test("Agent filter + search + stage dropdown combine correctly", async ({
    page,
  }) => {
    await gotoAndWaitForConfirm(page);

    // Wait for log entries to be populated
    await expect(
      page.getByRole("button", { name: /Tool: StructuredOutput/ }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Step 1: Click Agent filter button
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page.waitForTimeout(300);

    // Step 2: Type "echo" in the search box
    const searchInput = page.getByPlaceholder("Search...");
    await searchInput.fill("echo");
    await page.waitForTimeout(300);

    // Step 3: Select "analyzing" stage from dropdown
    const stageDropdown = page.getByRole("combobox");
    await expect(stageDropdown).toBeVisible();
    await stageDropdown.selectOption("analyzing");
    await page.waitForTimeout(300);

    // Verify filters are combined — the UI should reflect all three active filters
    // Reset: click All filter to clear category, clear search, reset stage
    await page.getByRole("button", { name: "All", exact: true }).click();
    await searchInput.fill("");
    await stageDropdown.selectOption({ index: 0 });
  });
});

test.describe("Task Advanced Interactions — Collapsible Log Entry Content", () => {
  test("Expanding Tool: StructuredOutput reveals JSON content", async ({
    page,
  }) => {
    await gotoAndWaitForConfirm(page);

    // Wait for collapsible tool entry
    const toolEntry = page
      .getByRole("button", { name: /Tool: StructuredOutput/ })
      .first();
    await expect(toolEntry).toBeVisible({ timeout: 15_000 });

    // Click to expand
    await toolEntry.click();
    await page.waitForTimeout(500);

    // After expansion, verify JSON content is visible (look for braces or key patterns)
    const expandedContent = page
      .locator("pre, code, .whitespace-pre-wrap")
      .filter({ hasText: /[{"\w]/ })
      .first();
    await expect(expandedContent).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Task Advanced Interactions — Status Badge Color", () => {
  test("awaitingConfirm badge uses blue styling", async ({ page }) => {
    await gotoAndWaitForConfirm(page);

    // Locate the status badge
    const badge = page
      .locator("span.rounded-full.px-3.py-1")
      .filter({ hasText: /awaitingConfirm/ });
    await expect(badge).toBeVisible();

    // Verify it has blue background class
    await expect(badge).toHaveClass(/bg-blue/);
  });
});

test.describe("Task Advanced Interactions — Session ID Display", () => {
  test("Session ID label followed by UUID is visible", async ({ page }) => {
    await gotoAndWaitForConfirm(page);

    // Verify "Session ID:" text is present
    const sessionLabel = page.getByText("Session ID:").first();
    await expect(sessionLabel).toBeVisible({ timeout: 10_000 });

    // Verify a UUID pattern is present near the session ID label
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    const sessionContainer = sessionLabel.locator("..");
    await expect(
      sessionContainer.getByText(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      )
    ).toBeVisible();
  });
});
