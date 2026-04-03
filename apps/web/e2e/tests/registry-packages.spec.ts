import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

test.describe("Registry Packages", () => {
  test("Scenario 1: Page loads and displays packages", async ({ page }) => {
    await page.goto("/registry");

    // Verify title and subtitle
    await expect(page.locator("h1", { hasText: "Package Store" })).toBeVisible();
    await expect(page.locator("text=Browse, install, and manage configuration packages")).toBeVisible();

    // Verify stats bar shows Available and Installed counts
    await expect(page.locator("text=Available:")).toBeVisible();
    await expect(page.locator("text=Installed:")).toBeVisible();

    // Verify at least one package card is rendered
    const cards = page.locator(".border.border-zinc-800.rounded-lg.overflow-hidden");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    expect(await cards.count()).toBeGreaterThanOrEqual(1);
  });

  test("Scenario 2: Filter packages by type", async ({ page }) => {
    await page.goto("/registry");

    // Wait for packages to load
    const cards = page.locator(".space-y-2 > div");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // Click the "Skill" filter button (inside the filter bar)
    const filterBar = page.locator(".bg-zinc-900.border.border-zinc-800.rounded-lg.p-1");
    await filterBar.locator("button", { hasText: "Skill" }).click();

    // Wait for filter to take effect
    await page.waitForTimeout(300);

    // Verify all visible package cards have the "skill" type badge
    const filteredCards = page.locator(".space-y-2 > div");
    const count = await filteredCards.count();
    expect(count).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < count; i++) {
      const typeBadge = filteredCards.nth(i).locator("span.rounded.border", { hasText: "skill" });
      await expect(typeBadge).toBeVisible();
    }

    // Click the "All" filter button
    await filterBar.locator("button", { hasText: "All" }).click();
    await page.waitForTimeout(300);

    // Verify packages of mixed types are shown again
    const allCards = page.locator(".space-y-2 > div");
    const allCount = await allCards.count();
    expect(allCount).toBeGreaterThanOrEqual(count);
  });

  test("Scenario 3: Search packages by name", async ({ page }) => {
    await page.goto("/registry");

    // Wait for packages to load
    const cards = page.locator(".space-y-2 > div");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const initialCount = await cards.count();

    // Get the name of the first package to use as search query
    const firstName = await cards.first().locator(".font-medium").innerText();
    // Use a fragment of the name for searching
    const searchFragment = firstName.length > 4 ? firstName.slice(0, 4) : firstName;

    // Type search fragment into search input
    const searchInput = page.locator('input[placeholder="Search packages..."]');
    await searchInput.fill(searchFragment);
    await page.waitForTimeout(300);

    // Verify the list narrows
    const filteredCount = await cards.count();
    expect(filteredCount).toBeGreaterThanOrEqual(1);
    expect(filteredCount).toBeLessThanOrEqual(initialCount);

    // Verify at least one visible card contains the search fragment
    const firstVisibleName = await cards.first().locator(".font-medium").innerText();
    expect(firstVisibleName.toLowerCase()).toContain(searchFragment.toLowerCase());

    // Clear the search input
    await searchInput.clear();
    await page.waitForTimeout(300);

    // Verify the full list is restored (may grow if async local packages loaded)
    const restoredCount = await cards.count();
    expect(restoredCount).toBeGreaterThanOrEqual(initialCount);
  });

  test("Scenario 4: Install a package", async ({ page }) => {
    await page.goto("/registry");

    // Wait for packages to load
    const cards = page.locator(".space-y-2 > div");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // Find an uninstalled package (one with an "Install" button)
    const installButton = page.locator("button").filter({ hasText: /^Install$/ }).first();

    // If no installable package exists, skip
    const installCount = await installButton.count();
    if (installCount === 0) {
      test.skip(true, "No uninstalled packages available to test install");
      return;
    }

    // Get the package name from the card containing this button
    const card = page.locator(".space-y-2 > div").filter({ has: installButton }).first();
    const pkgName = await card.locator(".font-medium").innerText();

    // Click install
    await installButton.click();

    // Verify a success toast appears
    const toast = page.locator(".fixed.top-4.right-4");
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).toContainText("Successfully installed");

    // After install, the page re-fetches data and re-renders.
    // Locate the card by package name and verify it now shows "Installed"
    await page.waitForTimeout(1_000);
    const updatedCard = page.locator(".space-y-2 > div").filter({
      has: page.locator(`.font-medium`, { hasText: pkgName }),
    }).first();
    await expect(updatedCard.locator("button", { hasText: "Installed" })).toBeVisible({ timeout: 10_000 });

    // Teardown: uninstall the package via API to restore state
    await fetch(`${API_BASE}/api/registry/uninstall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packages: [pkgName] }),
    });
  });

  test("Scenario 5: Uninstall a package", async ({ page }) => {
    // Setup: ensure at least one package is installed via API
    const indexRes = await fetch(`${API_BASE}/api/registry/index`);
    const indexData = await indexRes.json();
    const availablePackages = indexData.packages ?? [];

    const installedRes = await fetch(`${API_BASE}/api/registry/installed`);
    const installedData = await installedRes.json();
    const installedPkgs = installedData.packages ?? {};

    // Find a package to install for testing uninstall
    let targetPkg: string | null = null;
    let needsCleanup = false;

    // First try to find an already-installed package
    const installedNames = Object.keys(installedPkgs);
    if (installedNames.length > 0) {
      targetPkg = installedNames[0];
    } else {
      // Install one first
      if (availablePackages.length === 0) {
        test.skip(true, "No packages available to test uninstall");
        return;
      }
      targetPkg = availablePackages[0].name;
      await fetch(`${API_BASE}/api/registry/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packages: [targetPkg] }),
      });
      needsCleanup = false; // already uninstalling it in the test
    }

    await page.goto("/registry");

    // Wait for packages to load
    const cards = page.locator(".space-y-2 > div");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // Find the installed package's "Installed" button
    const card = cards.filter({ has: page.locator(`.font-medium:text-is("${targetPkg}")`) }).first();
    await expect(card).toBeVisible({ timeout: 5_000 });

    const installedButton = card.locator("button", { hasText: "Installed" });
    await expect(installedButton).toBeVisible({ timeout: 5_000 });

    // Click the "Installed" button to uninstall
    await installedButton.click();

    // Verify a success toast appears
    const toast = page.locator(".fixed.top-4.right-4");
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).toContainText("Successfully uninstalled");

    // Re-query the card after DOM update and verify button changes to "Install"
    const updatedCard = cards.filter({ has: page.locator(`.font-medium:text-is("${targetPkg}")`) }).first();
    const installButton = updatedCard.locator("button").filter({ hasText: /^Install$/ });
    await expect(installButton).toBeVisible({ timeout: 10_000 });

    // Re-install the package to restore state if it was originally installed
    if (installedNames.length > 0) {
      await fetch(`${API_BASE}/api/registry/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packages: [targetPkg] }),
      });
    }
  });

  test("Scenario 6: Expand package details", async ({ page }) => {
    await page.goto("/registry");

    // Wait for packages to load
    const cards = page.locator(".space-y-2 > div");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // Click on the first package card's clickable row area
    const firstCard = cards.first();
    const cardHeader = firstCard.locator(".cursor-pointer").first();
    await cardHeader.click();

    // Verify the expanded details section appears with author and files info
    const expandedDetails = firstCard.locator(".border-t.border-zinc-800.bg-zinc-900\\/30");
    await expect(expandedDetails).toBeVisible({ timeout: 10_000 });

    // Verify author info is shown (the "by" text)
    await expect(expandedDetails.locator("text=by")).toBeVisible();

    // Verify files section is shown
    await expect(expandedDetails.locator("text=Files")).toBeVisible();

    // Click the same card header again to collapse
    await cardHeader.click();

    // Verify the details section collapses
    await expect(expandedDetails).not.toBeVisible({ timeout: 5_000 });
  });

  test("Scenario 7: Pipeline package name links to config page", async ({ page }) => {
    await page.goto("/registry");

    // Wait for packages to load
    const cards = page.locator(".space-y-2 > div");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // Filter to pipelines only
    const filterBar = page.locator(".bg-zinc-900.border.border-zinc-800.rounded-lg.p-1");
    await filterBar.locator("button", { hasText: "Pipeline" }).click();
    await page.waitForTimeout(300);

    // Find a pipeline card with a link (blue text)
    const pipelineLink = page.locator("a.font-medium.text-blue-400").first();
    if (!(await pipelineLink.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No pipeline packages visible");
      return;
    }

    // Get the pipeline name and href
    const pipelineName = await pipelineLink.innerText();
    const href = await pipelineLink.getAttribute("href");
    expect(href).toContain("/config?pipeline=");

    // Click the link
    await pipelineLink.click();

    // Verify navigation to config page with pipeline param
    await expect(page).toHaveURL(/\/config\?pipeline=/);

    // Verify the config page loaded with workbench tab active and pipeline content visible
    // The workbench tab button should have the active style
    const workbenchTab = page.locator("button", { hasText: "Workbench" }).first();
    await expect(workbenchTab).toBeVisible({ timeout: 10_000 });

    // Verify the pipeline name appears somewhere in the config workbench content
    await expect(page.locator(`text=${pipelineName}`).first()).toBeVisible({ timeout: 10_000 });
  });
});
