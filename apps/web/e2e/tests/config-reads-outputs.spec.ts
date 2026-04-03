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

const selectFirstStageConfig = async (page: import("@playwright/test").Page) => {
  const stageCards = page.locator('[role="button"]').filter({
    has: page.locator(".text-sm.font-bold.text-zinc-100"),
  });
  await expect(stageCards.first()).toBeVisible({ timeout: 10_000 });
  await stageCards.first().click();
  const configTab = page.locator("button").filter({ hasText: /^Config$/ });
  await expect(configTab).toBeVisible({ timeout: 5_000 });
  await configTab.click();
};

test.describe("Config — Reads Editor", () => {
  test("Reads field displays select dropdowns for existing entries", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    // Look for "Reads" label — agent stages have a ReadsEditor
    const readsLabel = page.locator("label").filter({ hasText: "Reads" });
    if (!(await readsLabel.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No Reads field on first stage");
      return;
    }

    // ReadsEditor has select elements for path mapping
    const readsSection = readsLabel.locator("..");
    const selects = readsSection.locator("select");
    const selectCount = await selects.count();

    if (selectCount > 0) {
      // Verify selects are interactive
      const firstSelect = selects.first();
      await expect(firstSelect).toBeVisible();
      const options = firstSelect.locator("option");
      expect(await options.count()).toBeGreaterThan(0);
    }
  });

  test("Reads editor Add button creates new entry", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);
    await selectFirstStageConfig(page);

    const readsLabel = page.locator("label").filter({ hasText: "Reads" });
    if (!(await readsLabel.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No Reads field on first stage");
      return;
    }

    const readsSection = readsLabel.locator("..");
    const addBtn = readsSection.locator("button").filter({ hasText: /add|Add|\+/i });
    if (!(await addBtn.isVisible({ timeout: 2_000 }).catch(() => false))) {
      test.skip(true, "No Add button for reads");
      return;
    }

    const selectsBefore = await readsSection.locator("select").count();
    await addBtn.click();
    const selectsAfter = await readsSection.locator("select").count();
    expect(selectsAfter).toBeGreaterThan(selectsBefore);
  });
});

test.describe("Config — Output Schema Editor", () => {
  test("Outputs tab shows field editors for stages with outputs", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    // Select a stage and go to Outputs tab
    const stageCards = page.locator('[role="button"]').filter({
      has: page.locator(".text-sm.font-bold.text-zinc-100"),
    });
    await expect(stageCards.first()).toBeVisible({ timeout: 10_000 });
    await stageCards.first().click();

    const outputsTab = page.locator("button").filter({ hasText: /^Outputs$/ });
    if (!(await outputsTab.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No Outputs tab");
      return;
    }
    await outputsTab.click();

    // If stage has outputs, OutputSchemaEditor renders with field key inputs
    const keyInput = page.locator('input[placeholder="key"]').first();
    if (!(await keyInput.isVisible({ timeout: 3_000 }).catch(() => false))) {
      // No output schema — look for "Generate from writes" button
      const generateBtn = page.locator("button").filter({ hasText: /Generate from writes/i });
      if (await generateBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await generateBtn.click();
        // After clicking, output schema should appear
        await expect(page.locator('input[placeholder="key"]').first()).toBeVisible({ timeout: 5_000 });
      } else {
        test.skip(true, "No outputs and no writes to generate from");
        return;
      }
    }

    // Verify field editors exist: key input, type select, description input
    await expect(keyInput).toBeVisible();
    const typeSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "string" }) }).first();
    await expect(typeSelect).toBeVisible();
    const descInput = page.locator('input[placeholder="Description"]').first();
    await expect(descInput).toBeVisible();
  });

  test("Output field type select can be changed", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    const stageCards = page.locator('[role="button"]').filter({
      has: page.locator(".text-sm.font-bold.text-zinc-100"),
    });
    await stageCards.first().click();

    const outputsTab = page.locator("button").filter({ hasText: /^Outputs$/ });
    if (!(await outputsTab.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No Outputs tab");
      return;
    }
    await outputsTab.click();

    const typeSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "markdown" }) }).first();
    if (!(await typeSelect.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No output type select");
      return;
    }

    await typeSelect.selectOption("number");
    await expect(typeSelect).toHaveValue("number");
  });

  test("Output display_hint select has link/badge/code options", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    const stageCards = page.locator('[role="button"]').filter({
      has: page.locator(".text-sm.font-bold.text-zinc-100"),
    });
    await stageCards.first().click();

    const outputsTab = page.locator("button").filter({ hasText: /^Outputs$/ });
    if (!(await outputsTab.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No Outputs tab");
      return;
    }
    await outputsTab.click();

    // display_hint select has options: none, link, badge, code
    const hintSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "badge" }) }).first();
    if (!(await hintSelect.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No display hint select");
      return;
    }

    await expect(hintSelect.locator("option")).toHaveCount(4); // none, link, badge, code
    await hintSelect.selectOption("link");
    await expect(hintSelect).toHaveValue("link");
  });

  test("Output hidden checkbox toggles", async ({ page }) => {
    await openWorkbench(page);
    await selectFirstPipeline(page);

    const stageCards = page.locator('[role="button"]').filter({
      has: page.locator(".text-sm.font-bold.text-zinc-100"),
    });
    await stageCards.first().click();

    const outputsTab = page.locator("button").filter({ hasText: /^Outputs$/ });
    if (!(await outputsTab.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No Outputs tab");
      return;
    }
    await outputsTab.click();

    // Hidden checkbox
    const hiddenCheckbox = page.locator('input[type="checkbox"]').first();
    if (!(await hiddenCheckbox.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip(true, "No hidden checkbox");
      return;
    }

    const wasChecked = await hiddenCheckbox.isChecked();
    await hiddenCheckbox.click();
    if (wasChecked) {
      await expect(hiddenCheckbox).not.toBeChecked();
    } else {
      await expect(hiddenCheckbox).toBeChecked();
    }
    // Toggle back
    await hiddenCheckbox.click();
  });
});
