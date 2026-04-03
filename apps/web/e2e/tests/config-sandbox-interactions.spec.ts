import { test, expect } from "@playwright/test";

test.describe("Config Sandbox — Toggle and Input Interactions", () => {
  const openSandbox = async (page: import("@playwright/test").Page) => {
    await page.goto("/config");
    await expect(page.locator("text=Loading System Configuration")).not.toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Sandbox" }).click();
    await expect(page.getByRole("heading", { name: "Sandbox Mode" })).toBeVisible({ timeout: 5_000 });
  };

  test("Sandbox Mode main toggle can be toggled", async ({ page }) => {
    await openSandbox(page);

    // The main Sandbox Mode toggle is the first toggle button after the heading
    const mainToggle = page.locator("button[role='switch'], button.rounded-full").first();
    await expect(mainToggle).toBeVisible();

    // Get initial state and click to toggle
    const initialBg = await mainToggle.getAttribute("class");
    await mainToggle.click();

    // Click again to restore
    await mainToggle.click();
  });

  test("Auto-allow Bash toggle can be toggled", async ({ page }) => {
    await openSandbox(page);

    const row = page.getByText("Auto-allow Bash in Sandbox").locator("../..").locator("..");
    const toggle = row.locator("button.rounded-full").first();
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await toggle.click({ force: true });
    await toggle.click({ force: true });
  });

  test("Allow Unsandboxed Commands toggle can be toggled", async ({ page }) => {
    await openSandbox(page);

    const row = page.getByText("Allow Unsandboxed Commands").locator("../..").locator("..");
    const toggle = row.locator("button.rounded-full").first();
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await toggle.click({ force: true });
    await toggle.click({ force: true });
  });

  test("Network Allowed Domains textarea accepts input", async ({ page }) => {
    await openSandbox(page);

    const textarea = page.getByPlaceholder("registry.npmjs.org");
    await expect(textarea).toBeVisible();

    // Get current value, type a new domain, verify
    const original = await textarea.inputValue();
    await textarea.fill("example.com\ntest.org");
    await expect(textarea).toHaveValue("example.com\ntest.org");

    // Restore original value
    await textarea.fill(original);
  });

  test("Filesystem Rules inputs accept values", async ({ page }) => {
    await openSandbox(page);

    // There are 3 filesystem rule textareas: allow write, deny write, deny read
    await expect(page.getByText("Filesystem Rules")).toBeVisible();

    const fsSection = page.getByText("Filesystem Rules").locator("..").locator("..");
    const textareas = fsSection.locator("textarea");
    const count = await textareas.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Verify the first textarea is editable
    const firstTextarea = textareas.first();
    const original = await firstTextarea.inputValue();
    await firstTextarea.fill("/tmp/test-path");
    await expect(firstTextarea).toHaveValue("/tmp/test-path");
    // Restore
    await firstTextarea.fill(original);
  });
});
