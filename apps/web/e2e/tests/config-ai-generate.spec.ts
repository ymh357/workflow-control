import { test, expect } from "../fixtures";

const openWorkbench = async (page: import("@playwright/test").Page) => {
  await page.goto("/config");
  await expect(page.locator("text=Loading System Configuration")).not.toBeVisible({ timeout: 15_000 });
  await page.locator("button", { hasText: "Blueprint & Intelligence" }).click();
};

test.describe("Config — AI Generate Modal", () => {
  test("AI Generate modal opens with description textarea and engine select", async ({ page }) => {
    await openWorkbench(page);
    await expect(page.getByText("Select a Pipeline to Configure")).toBeVisible({ timeout: 10_000 });

    // Click AI Generate button
    await page.getByRole("button", { name: "AI Generate" }).click();

    // Modal should appear
    await expect(page.getByText("AI Generate Pipeline")).toBeVisible({ timeout: 5_000 });

    // Description textarea should be visible
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible();
    await textarea.fill("Build a code review pipeline with security audit");
    await expect(textarea).toHaveValue("Build a code review pipeline with security audit");

    // Engine select should be visible with options
    const engineSelect = page.locator("select").first();
    await expect(engineSelect).toBeVisible();
    await engineSelect.selectOption("claude");
    await expect(engineSelect).toHaveValue("claude");
    await engineSelect.selectOption("gemini");
    await expect(engineSelect).toHaveValue("gemini");

    // Generate button should be visible
    await expect(page.getByRole("button", { name: /Generate/i }).last()).toBeVisible();

    // Close the modal without generating
    await page.getByRole("button", { name: /Cancel|Close/i }).first().click();
    await expect(page.getByText("AI Generate Pipeline")).not.toBeVisible({ timeout: 3_000 });
  });
});
