// Journey: Models, one screen (the owner 2026-11-20: "do installed and download need to be
// different screens? I think probably not"). What is installed is on top, the models to download
// are under it, and a row stays where it is while it downloads and once it is installed.
import { expect, modelRow, openModels, stack, test, waitReady } from "./fixtures.ts";

// Guards the owner's ruling on Models: the default is set from the row menu, and a download installs in its row.
test("set a default from the row menu, then download a model into the list", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await openModels(page);

  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator(".mp-row[data-dm]")).toHaveCount(3);
  await expect(page.locator('.mp-row[data-dm="qwen3.5:9b"] .mp-l1 .mp-chip')).toHaveText("Default");

  // another default, from the row menu
  const gemma = page.locator('.mp-row[data-dm="gemma4:12b"]');
  await gemma.getByTestId("models.row-menu.open").click();
  await page.getByTestId("models.row-menu.make-default").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(gemma.locator(".mp-l1 .mp-chip")).toHaveText("Default");
  // the chip is the only mark of the default (decision 10): one row carries it
  await expect(page.locator(".mp-row[data-dm] .mp-l1 .mp-chip", { hasText: "Default" })).toHaveCount(1);

  // download one from the list under the installed models
  const row = modelRow(page, "qwen3.5:4b");
  const before = await row.evaluate((el) => [...document.querySelectorAll(".mp .mp-row")].indexOf(el));
  // the button's name says the model and the download's size
  await row.getByRole("button", { name: /^Download Qwen 3\.5 4B, \d/ }).click();
  await expect(row).toHaveAttribute("data-dm", "qwen3.5:4b", { timeout: 20_000 });
  expect(await row.evaluate((el) => [...document.querySelectorAll(".mp .mp-row")].indexOf(el)), "installed in the place it was offered").toBe(before);
  await expect(page.locator(".mp-row[data-dm]")).toHaveCount(4);
  await expect(page.getByTestId("models.list.installed").locator(".mp-row[data-dm]"), "the installed list above did not grow under the pointer").toHaveCount(3);
});

// Guards the owner's ruling on Models downloads: progress stays in the row, and Cancel puts the row back.
test("a running download shows its detail in its row, and Cancel download puts the row back", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await stack.scenario("models", { pullTickMs: 1000, pullChunkBytes: 100 * 1024 ** 2 });
  await openModels(page);

  const row = modelRow(page, "qwen3.5:4b");
  await row.getByTestId("models.offered.download").click();
  await expect(row).toHaveAttribute("data-pull", "qwen3.5:4b");
  // \s: a number stays on the line with its unit (a no-break space)
  await expect(row.locator(".prog-l span")).toHaveText(/^[\d.]+ of [\d.]+\sGB · \d+\sMB\/s · about .+ left$/, { timeout: 15_000 });
  await expect(row.getByRole("progressbar", { name: "Qwen 3.5 4B download" })).toHaveAttribute("aria-valuenow", /^[1-9]\d*$/);

  await row.getByTestId("models.downloading.cancel").click();
  await expect(row.getByTestId("models.offered.download")).toBeVisible();
  await expect(row.getByRole("progressbar")).toHaveCount(0);
});

// Guards the owner's 2026-11-13 note on the model name field ("ew double border"): one ring when focused,
// and a command pasted from the Ollama site downloads the model it names.
test("the model name field has one focus ring and takes a pasted ollama command", async ({ page, open }, testInfo) => {
  await open();
  await waitReady(page);
  await openModels(page);

  const field = page.getByTestId("models.custom.name");
  await field.fill("ollama run qwen3.5:4b");
  await expect(field).toBeFocused();
  const ring = await field.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { outline: cs.outlineStyle === "none" || cs.outlineWidth === "0px", shadow: cs.boxShadow };
  });
  expect(ring.outline, "the browser outline is off; the ring is the field's own edge").toBe(true);
  expect(ring.shadow).not.toBe("none");
  await field.locator("xpath=ancestor::*[contains(@class,'srow')][1]").screenshot({ path: testInfo.outputPath("model-name-focus.png") });

  await page.getByTestId("models.download.start").click();
  await expect(page.locator('.mp-row[data-dm="qwen3.5:4b"]')).toBeVisible({ timeout: 20_000 });
});

test.describe("the desktop's model rows", () => {
  // Thu 2026-11-12 14:00 in Chicago, as in the screenshot rig
  test.use({ seed: "design", seedAt: Date.UTC(2026, 10, 12, 20, 0), timezoneId: "America/Chicago", locale: "en-US", viewport: { width: 1440, height: 900 } });
  // Guards the owner's ruling: Remove lives in a model row's ⋯ menu.
  test("Remove is in the row's ⋯ menu and nowhere under the row", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await openModels(page);
    const row = page.locator('.mp-row[data-dm="gemma4:12b"]');
    await expect(row).toBeVisible();
    await expect(page.locator(".mp")).not.toContainText("Remove");
    await row.getByTestId("models.row-menu.open").click();
    await expect(row.getByTestId("models.row-menu.remove")).toBeVisible();
  });
});
