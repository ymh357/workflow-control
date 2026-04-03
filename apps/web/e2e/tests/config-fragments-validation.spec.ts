import { test, expect } from "../fixtures";

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

const openFragments = async (page: import("@playwright/test").Page) => {
  const fragmentsBtn = page.locator("button").filter({ hasText: /^Fragments/ });
  await expect(fragmentsBtn).toBeVisible({ timeout: 5_000 });
  await fragmentsBtn.click();
  await expect(page.getByText("Knowledge Fragments")).toBeVisible({ timeout: 5_000 });
};

// ─── Part 1: Fragment Editor ────────────────────────────────────────────────

test.describe("Config Fragments Editor", () => {
  const FRAG_NAME = `e2e-frag-${Date.now()}`;

  const ensureAtLeastOneFragment = async (page: import("@playwright/test").Page) => {
    const tabs = page.locator(".group.relative > button").first();
    if (await tabs.isVisible({ timeout: 2_000 }).catch(() => false)) return;
    // No fragments exist — add one
    const plusBtn = page.locator("button", { hasText: "+" }).filter({ has: page.locator("text=+") });
    await plusBtn.first().click();
    const input = page.locator('input[placeholder="fragment-name"]');
    await input.fill("seed-frag");
    await page.locator("button", { hasText: "Add" }).click();
  };

  test("Fragment tab switching changes active style", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openFragments(page);

    const tabContainer = page.locator(".flex.flex-wrap.gap-1\\.5.items-center");
    const tabs = tabContainer.locator(".group.relative > button.rounded").first();
    // Need at least one tab
    if (!(await tabs.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip();
      return;
    }

    const allTabs = tabContainer.locator(".group.relative > button.rounded");
    const count = await allTabs.count();
    if (count < 2) {
      // Add a second fragment for switching
      const plusBtn = page.locator("button").filter({ hasText: /^\+$/ });
      await plusBtn.click();
      const input = page.locator('input[placeholder="fragment-name"]');
      await input.fill("switch-test");
      await page.locator("button").filter({ hasText: /^Add$/ }).click();
      await page.waitForTimeout(300);
    }

    const refreshedTabs = tabContainer.locator(".group.relative > button.rounded");
    const tabCount = await refreshedTabs.count();
    if (tabCount < 2) {
      test.skip();
      return;
    }

    // Click the first tab
    await refreshedTabs.first().click();
    await expect(refreshedTabs.first()).toHaveClass(/bg-blue-900\/40/);

    // Click the second tab
    await refreshedTabs.nth(1).click();
    await expect(refreshedTabs.nth(1)).toHaveClass(/bg-blue-900\/40/);
    // First tab should no longer be active
    await expect(refreshedTabs.first()).not.toHaveClass(/bg-blue-900\/40/);
  });

  test("Fragment add via Enter", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openFragments(page);

    // Click "+" to enter add mode
    const plusBtn = page.locator("button").filter({ hasText: /^\+$/ });
    await expect(plusBtn).toBeVisible({ timeout: 3_000 });
    await plusBtn.click();

    // Input should appear
    const input = page.locator('input[placeholder="fragment-name"]');
    await expect(input).toBeVisible({ timeout: 3_000 });

    await input.fill(FRAG_NAME);
    await input.press("Enter");

    // New tab should appear
    const newTab = page.locator("button").filter({ hasText: FRAG_NAME });
    await expect(newTab).toBeVisible({ timeout: 3_000 });
  });

  test("Newly added fragment is automatically active", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openFragments(page);

    const fragName = `auto-active-${Date.now()}`;

    const plusBtn = page.locator("button").filter({ hasText: /^\+$/ });
    await plusBtn.click();
    const input = page.locator('input[placeholder="fragment-name"]');
    await input.fill(fragName);
    await input.press("Enter");

    const newTab = page.locator("button").filter({ hasText: fragName });
    await expect(newTab).toBeVisible({ timeout: 3_000 });
    await expect(newTab).toHaveClass(/bg-blue-900\/40/);
  });

  test("Fragment add — Escape cancels", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openFragments(page);

    const plusBtn = page.locator("button").filter({ hasText: /^\+$/ });
    await plusBtn.click();

    const input = page.locator('input[placeholder="fragment-name"]');
    await expect(input).toBeVisible({ timeout: 3_000 });
    await input.fill("should-not-exist");
    await input.press("Escape");

    // Input should disappear
    await expect(input).not.toBeVisible({ timeout: 3_000 });
    // No tab with that name
    await expect(page.locator("button").filter({ hasText: "should-not-exist" })).not.toBeVisible();
  });

  test("Fragment delete via x button", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openFragments(page);

    // Add a fragment to delete
    const fragName = `del-me-${Date.now()}`;
    const plusBtn = page.locator("button").filter({ hasText: /^\+$/ });
    await plusBtn.click();
    const input = page.locator('input[placeholder="fragment-name"]');
    await input.fill(fragName);
    await input.press("Enter");

    const newTab = page.locator("button").filter({ hasText: fragName });
    await expect(newTab).toBeVisible({ timeout: 3_000 });

    // The delete button is hidden (group-hover:flex) — find it relative to the tab's parent .group
    const tabGroup = newTab.locator("..");
    const deleteBtn = tabGroup.locator("button.bg-red-950");
    // Force click since it's hidden
    await deleteBtn.click({ force: true });

    await expect(newTab).not.toBeVisible({ timeout: 3_000 });
  });

  test("Fragment Meta — Keywords add", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openFragments(page);
    await ensureAtLeastOneFragment(page);

    const kwInput = page.locator('input[placeholder="add..."]');
    await expect(kwInput).toBeVisible({ timeout: 5_000 });
    await kwInput.fill("test-kw");
    await kwInput.press("Enter");

    // Keyword badge should appear
    const badge = page.locator(".bg-zinc-800").filter({ hasText: "test-kw" });
    await expect(badge).toBeVisible({ timeout: 3_000 });
  });

  test("Fragment Meta — Keywords delete", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openFragments(page);
    await ensureAtLeastOneFragment(page);

    // First add a keyword to ensure one exists
    const kwInput = page.locator('input[placeholder="add..."]');
    await expect(kwInput).toBeVisible({ timeout: 5_000 });
    await kwInput.fill("removable-kw");
    await kwInput.press("Enter");

    const badge = page.locator(".bg-zinc-800").filter({ hasText: "removable-kw" });
    await expect(badge).toBeVisible({ timeout: 3_000 });

    // Click the x button inside the badge
    const removeBtn = badge.locator("button");
    await removeBtn.click();

    await expect(badge).not.toBeVisible({ timeout: 3_000 });
  });

  test("Fragment Meta — Stages ALL toggle", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openFragments(page);
    await ensureAtLeastOneFragment(page);

    const allBtn = page.locator("button").filter({ hasText: "ALL" });
    await expect(allBtn).toBeVisible({ timeout: 5_000 });

    // Check initial state and toggle to active
    const isActive = await allBtn.evaluate((el) => el.className.includes("bg-purple-900/20"));
    if (!isActive) {
      await allBtn.click();
      await expect(allBtn).toHaveClass(/bg-purple-900\/20/);
      // KNOWN_AGENT_STAGES buttons should NOT be visible when ALL is active
      await expect(page.locator("button").filter({ hasText: "analyzing" })).not.toBeVisible();
    }

    // Toggle off — stage buttons should appear
    await allBtn.click();
    if (isActive) {
      // Was active, now deactivated
      await expect(allBtn).not.toHaveClass(/bg-purple-900\/20/);
    }
    await expect(page.locator("button").filter({ hasText: "analyzing" })).toBeVisible({ timeout: 3_000 });
  });

  test("Fragment Meta — Select specific stage", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openFragments(page);
    await ensureAtLeastOneFragment(page);

    // Make sure ALL is not active
    const allBtn = page.locator("button").filter({ hasText: "ALL" });
    await expect(allBtn).toBeVisible({ timeout: 5_000 });
    const isAllActive = await allBtn.evaluate((el) => el.className.includes("bg-purple-900/20"));
    if (isAllActive) {
      await allBtn.click();
      await page.waitForTimeout(300);
    }

    const analyzingBtn = page.locator("button").filter({ hasText: "analyzing" });
    await expect(analyzingBtn).toBeVisible({ timeout: 3_000 });

    // Toggle on
    await analyzingBtn.click();
    await expect(analyzingBtn).toHaveClass(/bg-blue-900\/20/);

    // Toggle off
    await analyzingBtn.click();
    await expect(analyzingBtn).not.toHaveClass(/bg-blue-900\/20/);
  });

  test("Fragment Meta — Always toggle", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openFragments(page);
    await ensureAtLeastOneFragment(page);

    const alwaysBtn = page.locator("button").filter({ hasText: /Always/ });
    await expect(alwaysBtn).toBeVisible({ timeout: 5_000 });

    // Toggle on
    const wasActive = await alwaysBtn.evaluate((el) => el.className.includes("bg-green-900/20"));
    await alwaysBtn.click();

    if (wasActive) {
      await expect(alwaysBtn).not.toHaveClass(/bg-green-900\/20/);
    } else {
      await expect(alwaysBtn).toHaveClass(/bg-green-900\/20/);
    }

    // Toggle back
    await alwaysBtn.click();
    if (wasActive) {
      await expect(alwaysBtn).toHaveClass(/bg-green-900\/20/);
    } else {
      await expect(alwaysBtn).not.toHaveClass(/bg-green-900\/20/);
    }
  });
});

// ─── Part 2: Validation Bar ─────────────────────────────────────────────────

test.describe("Config Validation Bar", () => {
  test("Validation bar exists", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Look for either "No issues" (green) or error/warning counts
    const noIssues = page.getByText("No issues");
    const errorCount = page.locator("span.text-red-400.font-bold");
    const warningCount = page.locator("span.text-amber-400.font-bold");

    const validationBar = noIssues.or(errorCount).or(warningCount);
    await expect(validationBar.first()).toBeVisible({ timeout: 10_000 });
  });

  test("Validation bar expand and collapse", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // If "No issues" is shown, nothing to expand
    const noIssues = page.getByText("No issues");
    if (await noIssues.isVisible({ timeout: 5_000 }).catch(() => false)) {
      test.skip();
      return;
    }

    // Click the validation bar toggle button (the one with error/warning counts)
    const toggleBtn = page.locator("button.flex.items-center.gap-3.w-full");
    await expect(toggleBtn).toBeVisible({ timeout: 5_000 });
    await toggleBtn.click();

    // Issue list should appear — contains ERR/WARN/INFO labels
    const issueList = page.locator(".max-h-48.overflow-y-auto");
    await expect(issueList).toBeVisible({ timeout: 3_000 });

    // Verify at least one issue label exists
    const issueLabels = issueList.locator("span.font-bold.uppercase");
    await expect(issueLabels.first()).toBeVisible();

    // Collapse
    await toggleBtn.click();
    await expect(issueList).not.toBeVisible({ timeout: 3_000 });
  });

  test("Validation issue jump to stage", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    const noIssues = page.getByText("No issues");
    if (await noIssues.isVisible({ timeout: 5_000 }).catch(() => false)) {
      test.skip();
      return;
    }

    // Expand
    const toggleBtn = page.locator("button.flex.items-center.gap-3.w-full");
    await toggleBtn.click();

    const issueList = page.locator(".max-h-48.overflow-y-auto");
    await expect(issueList).toBeVisible({ timeout: 3_000 });

    // Find a stage link (text-blue-400 underline)
    const stageLink = issueList.locator("button.text-blue-400.underline").first();
    if (!(await stageLink.isVisible({ timeout: 2_000 }).catch(() => false))) {
      test.skip();
      return;
    }

    const stageName = await stageLink.textContent();
    await stageLink.click();

    // After clicking, the corresponding stage card in the left panel should have border-blue-600
    const selectedCard = page.locator(".border-blue-600");
    await expect(selectedCard).toBeVisible({ timeout: 5_000 });

    // Verify it contains the stage name
    if (stageName) {
      await expect(selectedCard).toContainText(stageName);
    }
  });
});
