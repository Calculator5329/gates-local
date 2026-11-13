// Journey: Settings › Models. The Installed tab lists what is installed, the
// row menu makes another model the default, and the Download tab is the
// download flow as it always was: progress and Cancel download in the row,
// Installed when it is done, and the model then listed under Installed.
import { expect, openModels, stack, test, waitReady } from "./fixtures.ts";

// Guards the owner's ruling on Models: the default is set from the row menu and a download lands under Installed.
test("set a default from the row menu, then download a model into the list", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await openModels(page);

  const installedTab = page.getByRole("tab", { name: /^Installed/ });
  await expect(installedTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".mp-row[data-dm]")).toHaveCount(3);
  await expect(page.locator('.mp-row[data-dm="qwen3.5:9b"] .mp-l1 .mp-chip')).toHaveText("Default");

  // another default, from the row menu
  const gemma = page.locator('.mp-row[data-dm="gemma4:12b"]');
  await gemma.getByRole("button", { name: "More for Gemma 4 12B" }).click();
  await page.getByRole("menuitem", { name: "Use as default" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(gemma.locator(".mp-l1 .mp-chip")).toHaveText("Default");
  await expect(page.getByRole("button", { name: /^Default for new chats:/ })).toHaveAccessibleName("Default for new chats: Gemma 4 12B");

  // download one from the Download tab
  await page.getByRole("tab", { name: /^Download/ }).click();
  const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
  // the button is labelled with the download's size (row 18)
  await row.getByRole("button", { name: /^Download \d/ }).click();
  await expect(row.locator(".dl-done")).toHaveText("Installed", { timeout: 20_000 });

  await expect(installedTab).toContainText("4");
  await installedTab.click();
  await expect(page.locator('.mp-row[data-dm="qwen3.5:4b"]')).toBeVisible();
});

// Guards the owner's ruling on Models downloads: progress stays in the row, on Installed too, and Cancel puts it back.
test("a running download shows its detail in the row and on Installed, and Cancel download puts it back", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await stack.scenario("models", { pullTickMs: 1000, pullChunkBytes: 100 * 1024 ** 2 });
  await openModels(page);
  await page.getByRole("tab", { name: /^Download/ }).click();

  const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
  await row.getByRole("button", { name: /^Download \d/ }).click();
  // \s: a number stays on the line with its unit (a no-break space). The Download row's
  // second line has bytes and time left; its button fills with the percent (row 18).
  const line = /^[\d.]+ of [\d.]+\sGB · about .+ left$/;
  await expect(row.locator(".dl-status")).toHaveText(line, { timeout: 15_000 });
  await expect(row.getByRole("progressbar", { name: "Qwen 3.5 4B download" })).toHaveText(/^\d+%$/);

  // Installed keeps showing it with its own Cancel download
  await page.getByRole("tab", { name: /^Installed/ }).click();
  const running = page.locator('.mp-row.mp-dling[data-pull="qwen3.5:4b"]');
  await expect(running.locator(".prog-l span")).toHaveText(/^[\d.]+ of [\d.]+\sGB · \d+\sMB\/s · about .+ left$/);
  await expect(running.getByRole("button", { name: "Cancel download" })).toBeVisible();

  await page.getByRole("tab", { name: /^Download/ }).click();
  await row.getByRole("button", { name: "Cancel download" }).click();
  await expect(row.getByRole("button", { name: /^Download \d/ })).toBeVisible();
  await expect(row.getByRole("progressbar")).toHaveCount(0);
});

// Guards the owner's 2026-11-13 note on the model name field ("ew double border"): one ring when focused,
// and a command pasted from the Ollama site downloads the model it names.
test("the model name field has one focus ring and takes a pasted ollama command", async ({ page, open }, testInfo) => {
  await open();
  await waitReady(page);
  await openModels(page);
  await page.getByRole("tab", { name: /^Download/ }).click();

  const field = page.getByRole("textbox", { name: "Model name" });
  await field.fill("ollama run qwen3.5:4b");
  await expect(field).toBeFocused();
  const ring = await field.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { outline: cs.outlineStyle === "none" || cs.outlineWidth === "0px", shadow: cs.boxShadow };
  });
  expect(ring.outline, "the browser outline is off; the ring is the field's own edge").toBe(true);
  expect(ring.shadow).not.toBe("none");
  await field.locator("xpath=ancestor::*[contains(@class,'srow')][1]").screenshot({ path: testInfo.outputPath("model-name-focus.png") });

  await page.getByRole("button", { name: /^Download/ }).last().click();
  await expect(page.locator('.dlrow[data-cat="qwen3.5:4b"] .dl-done')).toHaveText("Installed", { timeout: 20_000 });
});
