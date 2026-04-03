import { test, expect } from "../fixtures";

const API_BASE = "http://localhost:3001";

// --- Helpers ---

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

const selectPipelineById = async (page: import("@playwright/test").Page, id: string) => {
  const card = page.locator(".grid.grid-cols-1.gap-3 > div").filter({ hasText: id });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.locator("button.flex-1").click();
  await expect(page.locator("button").filter({ hasText: "Pipeline Settings" })).toBeVisible({ timeout: 10_000 });
};

const openPipelineSettings = async (page: import("@playwright/test").Page) => {
  await page.locator("button").filter({ hasText: "Pipeline Settings" }).click();
};

const getDescriptionTextarea = (page: import("@playwright/test").Page) =>
  page.locator("textarea[placeholder='Describe what this pipeline does...']");

const getSaveButton = (page: import("@playwright/test").Page) =>
  page.locator("button").filter({ hasText: /^Save$|^Saving\.\.\.$/ });

const getDiscardButton = (page: import("@playwright/test").Page) =>
  page.locator("button").filter({ hasText: /^Discard$/ });

async function createTestPipeline(): Promise<string> {
  const id = `e2e-save-${Date.now()}`;
  await fetch(`${API_BASE}/api/config/pipelines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return id;
}

async function deleteTestPipeline(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/config/pipelines/${id}`, { method: "DELETE" });
}

// --- Tests ---

test.describe("Config Save & Discard Flow", () => {
  test("Save button is initially disabled", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    const saveBtn = getSaveButton(page);
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toHaveClass(/cursor-not-allowed/);
  });

  test("Save button becomes enabled after modification", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openPipelineSettings(page);

    const textarea = getDescriptionTextarea(page);
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill("e2e-dirty-test");

    const saveBtn = getSaveButton(page);
    await expect(saveBtn).toHaveClass(/bg-blue-600/, { timeout: 5_000 });
  });

  test("Discard button only appears when dirty", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Initially no Discard button
    await expect(getDiscardButton(page)).not.toBeVisible();

    // Make a change
    await openPipelineSettings(page);
    const textarea = getDescriptionTextarea(page);
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill("e2e-dirty-test");

    // Discard button should appear
    await expect(getDiscardButton(page)).toBeVisible({ timeout: 5_000 });
  });

  test("Discard confirm — clicking No keeps changes", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openPipelineSettings(page);

    const textarea = getDescriptionTextarea(page);
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    const original = await textarea.inputValue();
    const dirtyValue = "e2e-discard-no-test";
    await textarea.fill(dirtyValue);

    // Click Discard
    await getDiscardButton(page).click();

    // Inline confirm should appear
    await expect(page.getByText("Discard?")).toBeVisible({ timeout: 3_000 });
    const noBtn = page.locator("button").filter({ hasText: /^No$/ });
    await expect(noBtn).toBeVisible();

    // Click No — changes should be retained
    await noBtn.click();

    await expect(page.getByText("Discard?")).not.toBeVisible();
    await expect(textarea).toHaveValue(dirtyValue);
    await expect(getSaveButton(page)).toHaveClass(/bg-blue-600/);
  });

  test("Discard confirm — clicking Yes restores original value", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await openPipelineSettings(page);

    const textarea = getDescriptionTextarea(page);
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    const original = await textarea.inputValue();
    await textarea.fill("e2e-discard-yes-test");

    // Click Discard → Yes
    await getDiscardButton(page).click();
    await expect(page.getByText("Discard?")).toBeVisible({ timeout: 3_000 });
    await page.locator("button").filter({ hasText: /^Yes$/ }).click();

    // Value should revert, Save button should be disabled again
    await expect(textarea).toHaveValue(original, { timeout: 5_000 });
    await expect(getSaveButton(page)).toHaveClass(/cursor-not-allowed/, { timeout: 5_000 });
  });

  test("Save shows Saved indicator on success", async ({ page }) => {
    const pipelineId = await createTestPipeline();
    try {
      await openWorkbench(page);
      await selectPipelineById(page, pipelineId);
      await openPipelineSettings(page);

      const textarea = getDescriptionTextarea(page);
      await expect(textarea).toBeVisible({ timeout: 5_000 });
      await textarea.fill("e2e-save-success-test");

      const saveBtn = getSaveButton(page);
      await expect(saveBtn).toHaveClass(/bg-blue-600/, { timeout: 5_000 });
      await saveBtn.click();

      // "Saved" green text should appear
      const savedText = page.locator("span.text-green-400").filter({ hasText: "Saved" });
      await expect(savedText).toBeVisible({ timeout: 10_000 });

      // After 2s it should disappear
      await expect(savedText).not.toBeVisible({ timeout: 5_000 });

      // Save button should be disabled again
      await expect(getSaveButton(page)).toHaveClass(/cursor-not-allowed/, { timeout: 5_000 });
    } finally {
      await deleteTestPipeline(pipelineId);
    }
  });

  test("Ctrl+S / Cmd+S keyboard shortcut triggers save", async ({ page }) => {
    const pipelineId = await createTestPipeline();
    try {
      await openWorkbench(page);
      await selectPipelineById(page, pipelineId);
      await openPipelineSettings(page);

      const textarea = getDescriptionTextarea(page);
      await expect(textarea).toBeVisible({ timeout: 5_000 });
      await textarea.fill("e2e-keyboard-save-test");

      await expect(getSaveButton(page)).toHaveClass(/bg-blue-600/, { timeout: 5_000 });

      // Press Cmd+S (Mac) or Ctrl+S
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+s`);

      // Should trigger save — look for "Saving..." or "Saved"
      const savedText = page.locator("span.text-green-400").filter({ hasText: "Saved" });
      await expect(savedText).toBeVisible({ timeout: 10_000 });

      await expect(getSaveButton(page)).toHaveClass(/cursor-not-allowed/, { timeout: 5_000 });
    } finally {
      await deleteTestPipeline(pipelineId);
    }
  });
});
