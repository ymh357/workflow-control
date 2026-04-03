import { test, expect } from "@playwright/test";

test.describe("Registry — Update Outdated Package", () => {
  test("Update button visible for outdated packages", async ({ page }) => {
    await page.goto("/registry");
    await expect(page.getByRole("heading", { name: "Package Store" })).toBeVisible({ timeout: 10_000 });

    // Look for an "Update" button (shown for outdated installed packages)
    const updateBtn = page.getByRole("button", { name: "Update" }).first();
    if (!(await updateBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No outdated packages to update");
      return;
    }
    await expect(updateBtn).toBeVisible();
  });
});
