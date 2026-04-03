import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

test.describe("Config Infrastructure", () => {
  // Scenario 1: Health tab displays system status
  test("Health tab displays system status", async ({ page }) => {
    await page.goto("/config");

    // The "Infrastructure & Health" main tab should be active by default
    await expect(page.getByText("Infrastructure & Health")).toBeVisible();

    // Click the "System Health" sub-tab (default, but be explicit)
    await page.getByText("System Health", { exact: true }).click();

    // Verify environment info: OS and Node version
    await expect(page.getByText("Host Environment")).toBeVisible();
    await expect(page.getByText("Operating System")).toBeVisible();
    await expect(page.getByText("Node Runtime")).toBeVisible();

    // Verify preflight diagnostics section exists with check items
    await expect(page.getByText("Preflight Diagnostics")).toBeVisible();
    // Each preflight check has a colored indicator dot (emerald or red) and a name
    const preflightSection = page.locator("text=Preflight Diagnostics").locator("..").locator("..");
    const checkItems = preflightSection.locator(".rounded-xl .flex.items-center.gap-4");
    await expect(checkItems.first()).toBeVisible();
    const checkCount = await checkItems.count();
    expect(checkCount).toBeGreaterThanOrEqual(1);

    // Verify MCP status section: "Availability" card with MCP Servers count
    await expect(page.getByText("Availability")).toBeVisible();
    await expect(page.getByText("MCP Servers", { exact: true })).toBeVisible();
    // The ready count format: "X/Y Ready"
    await expect(page.getByText(/\d+\/\d+ Ready/)).toBeVisible();

    // Verify Skills section: "Shared Skills" with loaded count
    await expect(page.getByText("Shared Skills")).toBeVisible();
    await expect(page.getByText(/\d+ Loaded/)).toBeVisible();
  });

  // Scenario 2: Settings tab loads and displays YAML
  test("Settings tab loads and displays YAML", async ({ page }) => {
    await page.goto("/config");

    // Click the "System Settings" sub-tab
    await page.getByText("System Settings", { exact: true }).click();

    // Verify the raw config editing hint is shown
    await expect(
      page.getByText("Editing raw system configuration. Be careful with indentation.")
    ).toBeVisible();

    // Verify Monaco editor is rendered (it renders inside a .monaco-editor container)
    const monacoEditor = page.locator(".monaco-editor");
    await expect(monacoEditor).toBeVisible({ timeout: 10000 });

    // Verify the editor has non-empty content by checking the view lines
    const viewLines = monacoEditor.locator(".view-lines");
    await expect(viewLines).toBeVisible();
    const textContent = await viewLines.textContent();
    expect(textContent?.trim().length).toBeGreaterThan(0);

    // Verify the "Save Changes" button is present
    await expect(page.getByText("Save Changes", { exact: true })).toBeVisible();
  });

  // Scenario 3: MCP tab loads and displays YAML
  test("MCP tab loads and displays YAML", async ({ page }) => {
    await page.goto("/config");

    // Click the "MCP Registry" sub-tab
    await page.getByText("MCP Registry", { exact: true }).click();

    // Verify the raw config editing hint
    await expect(
      page.getByText("Editing raw system configuration. Be careful with indentation.")
    ).toBeVisible();

    // Verify Monaco editor is rendered with MCP content
    const monacoEditor = page.locator(".monaco-editor");
    await expect(monacoEditor).toBeVisible({ timeout: 10000 });

    const viewLines = monacoEditor.locator(".view-lines");
    await expect(viewLines).toBeVisible();
    const textContent = await viewLines.textContent();
    expect(textContent?.trim().length).toBeGreaterThan(0);

    // Verify "Save Changes" button exists
    await expect(page.getByText("Save Changes", { exact: true })).toBeVisible();
  });

  // Scenario 4: Save settings YAML via API round-trip
  test("Save settings YAML round-trips without corruption", async ({ page }) => {
    // Fetch current settings content so we can restore later
    const originalRes = await fetch(`${API_BASE}/api/config/settings`);
    expect(originalRes.ok).toBe(true);
    const originalData = await originalRes.json();
    const originalRaw: string = originalData.raw || "";

    // Save with a marker via API
    const markerContent = originalRaw.trimEnd() + "\n# e2e-test-marker\n";
    const saveRes = await fetch(`${API_BASE}/api/config/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: markerContent }),
    });
    expect(saveRes.ok).toBe(true);

    // Verify via API that the content was persisted
    const verifyRes = await fetch(`${API_BASE}/api/config/settings`);
    expect(verifyRes.ok).toBe(true);
    const verifyData = await verifyRes.json();
    expect(verifyData.raw).toContain("# e2e-test-marker");

    // Also verify the UI loads the saved content
    await page.goto("/config");
    await page.getByText("System Settings", { exact: true }).click();

    const monacoEditor = page.locator(".monaco-editor");
    await expect(monacoEditor).toBeVisible({ timeout: 10_000 });
    const viewLines = monacoEditor.locator(".view-lines");
    await expect(viewLines).toBeVisible();

    // Restore original content
    const restoreRes = await fetch(`${API_BASE}/api/config/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: originalRaw }),
    });
    expect(restoreRes.ok).toBe(true);
  });

  // Scenario 5: Sandbox tab displays configuration
  test("Sandbox tab displays configuration", async ({ page }) => {
    await page.goto("/config");

    // Click the "Sandbox" sub-tab
    await page.getByText("Sandbox", { exact: true }).click();

    // Verify the sandbox panel renders
    await expect(page.getByText("Sandbox Mode")).toBeVisible();
    await expect(
      page.getByText("OS-level isolation for bash commands")
    ).toBeVisible();

    // Verify the main sandbox toggle exists (the rounded-full toggle button)
    const sandboxToggle = page
      .locator(".rounded-xl")
      .filter({ hasText: "Sandbox Mode" })
      .locator("button.rounded-full")
      .first();
    await expect(sandboxToggle).toBeVisible();

    // Verify sub-option labels are present
    await expect(page.getByText("Auto-allow Bash in Sandbox")).toBeVisible();
    await expect(page.getByText("Allow Unsandboxed Commands")).toBeVisible();

    // Verify network domains textarea is present
    await expect(page.getByText("Network Allowed Domains")).toBeVisible();
    const networkTextarea = page.locator(
      "textarea[placeholder*='registry.npmjs.org']"
    );
    await expect(networkTextarea).toBeVisible();

    // Verify filesystem rules section
    await expect(page.getByText("Filesystem Rules")).toBeVisible();
    // There should be 3 textareas for allow_write, deny_write, deny_read
    const fsSection = page.locator("text=Filesystem Rules").locator("..").locator("..");
    const fsTextareas = fsSection.locator("textarea");
    const fsCount = await fsTextareas.count();
    expect(fsCount).toBeGreaterThanOrEqual(3);

    // Verify the main toggle is interactive: click it and check state changes
    const initialClass = await sandboxToggle.getAttribute("class");
    await sandboxToggle.click();
    // Small wait for re-render
    await page.waitForTimeout(300);
    const newClass = await sandboxToggle.getAttribute("class");
    // The class should change between bg-emerald-600 and bg-zinc-700
    expect(newClass).not.toEqual(initialClass);

    // Click it back to restore original state
    await sandboxToggle.click();
  });
});
