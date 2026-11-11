/// <reference lib="dom" />
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { CHECKOUT_CACHE } from "./env.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

async function library(page: Page) {
  await waitReady(page); await page.keyboard.press("Control+Comma");
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    await page.getByRole("button", { name: "Back to Settings" }).click();
    await page.locator(".set-list").getByRole("button", { name: "Library" }).click();
  } else await page.locator(".snav").getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator('[data-db="sample:chinook"]')).toBeVisible();
}
async function shot(page: Page, info: TestInfo, name: string) { await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true }); }
async function size(button: Locator) { const box = await button.boundingBox(); expect(box).not.toBeNull(); return box; }
const remove = async (page: Page, label: string) => {
  await page.getByRole("button", { name: `More for ${label}` }).click();
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
};
/** A sample's slot: at rest, while its button fills, and once it is the database (the fixture file has one table). */
const slot = (page: Page, id: string) => page.locator(`[data-db="sample:${id}"]`);
const fill = (row: Locator) => row.locator(".fill-btn");
const isDatabase = (row: Locator, label: string) => expect(row.getByRole("button", { name: `Remove ${label}` })).toBeVisible({ timeout: 15_000 });

test("a sample downloads in its own row: same place and height throughout, one row at the end", async ({ page, open }, info) => {
  await open(); await library(page);
  const row = slot(page, "chinook"); const button = fill(row);
  const add = page.getByRole("button", { name: "Add database…" });
  await expect(button).toHaveText("Download"); await expect(row).toContainText("Sample ·"); await expect(row.locator(".import-rest")).toContainText("8 KB");
  const before = await size(row); const addBefore = await size(add); const buttonBefore = await size(button);
  await shot(page, info, "library-at-rest");
  await button.click(); await expect(button).toHaveText(/^\d+%$/);
  await expect(button).toHaveAttribute("data-tip", "Cancel download");
  for (let n = 0; n < 4; n++) { expect(await size(row)).toEqual(before); expect(await size(button)).toEqual(buttonBefore); await shot(page, info, `progress-${n}`); }
  // Part filled: the fake sends 512 bytes every 200 ms and the list polls every 500 ms.
  await expect(button).toHaveText(/^[3-7]\d%$/); expect(await size(button)).toEqual(buttonBefore); await shot(page, info, "library-mid");
  // Pressing the filling button cancels; the grey line says so and the button offers Retry.
  await button.click(); await expect(button).toHaveText("Retry"); await expect(row.locator(".import-status")).toContainText("Cancelled.");
  expect(await size(row)).toEqual(before); await shot(page, info, "cancelled");
  await button.click(); await expect(button).toHaveText(/^\d+%$/);
  await isDatabase(row, "Chinook");
  expect(await size(row)).toEqual(before);
  await expect(row).toContainText("1 table");
  // One row for the database: no second row, no "Ready in Library", no "Added"; the Add row has not moved.
  await expect(page.locator(".db-row", { hasText: "Chinook" })).toHaveCount(1);
  await expect(page.getByText("Ready in Library")).toHaveCount(0); await expect(page.getByText("Added", { exact: true })).toHaveCount(0);
  expect(await size(add)).toEqual(addBefore);
  await shot(page, info, "library-after");
  // Removing it turns the slot back into the sample, in place.
  await row.getByRole("button", { name: "Remove Chinook" }).click(); await expect(button).toHaveText("Download");
  expect(await size(row)).toEqual(before);
  const northwind = slot(page, "northwind"); await fill(northwind).click();
  await expect(northwind.getByRole("alert")).toContainText("Check your connection and retry"); await expect(fill(northwind)).toHaveText("Retry");
  await shot(page, info, "offline"); await fill(northwind).click(); await isDatabase(northwind, "Northwind");
});

test("an opened sample lists its tables and asks its questions in a new chat", async ({ page, open }, info) => {
  await open(); await library(page);
  const row = slot(page, "chinook");
  await row.locator(".db-open").click();
  await expect(row.locator(".db-open")).toHaveAttribute("aria-expanded", "true");
  // Not downloaded: the catalog's tables, and questions that say why they wait.
  await expect(row.locator(".db-t")).toHaveCount(11);
  await expect(row.locator(".db-why")).toHaveText("Download it to ask these.");
  await expect(row.locator(".db-q")).toHaveCount(4);
  for (const q of await row.locator(".db-q").all()) await expect(q).toBeDisabled();
  await expect(row.getByRole("link", { name: "Source" })).toHaveAttribute("href", /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[0-9a-f]{40}$/);
  const before = await size(row.locator(".db-open"));
  await fill(row).click(); await isDatabase(row, "Chinook");
  expect(await size(row.locator(".db-open"))).toEqual(before);
  await expect(row.locator(".db-why")).toHaveCount(0);
  await shot(page, info, "library-open");
  const question = row.locator(".db-q").first(); const words = (await question.innerText()).trim();
  await question.click();
  // Settings is gone, the new chat is on screen with the question sent and its reply under way, and the caret is in its message box.
  await expect(page.locator(".set")).toHaveCount(0);
  await expect(page.locator(".turn.u").last()).toContainText(words);
  await expect(page.locator(".turn.a").last()).toBeVisible();
  await expect(page.locator("#ta")).toHaveValue("");
  await expect(page.locator("#ta")).toBeFocused();
  await shot(page, info, "library-asked");
});

test("Library clones a GitHub URL with fixed controls and removing it leaves a hand-added folder", async ({ page, open }, info) => {
  await open(); await library(page);
  const input = page.getByRole("textbox", { name: "Public GitHub repository URL" });
  const row = page.locator(".srow", { has: input }); const button = row.getByRole("button"); const before = await size(button);
  await input.fill("--upload-pack=evil"); await button.click(); await expect(page.getByRole("alert")).toContainText("Paste a public GitHub URL");
  await input.fill("https://github.com/example/docs"); await shot(page, info, "clone-before"); await button.click(); await expect(button).toHaveText("Cancel");
  for (let n = 0; n < 4; n++) { expect(await size(button)).toEqual(before); await shot(page, info, `clone-progress-${n}`); }
  await expect(button).toHaveText("Added"); expect(await size(button)).toEqual(before); await shot(page, info, "clone-added");
  const manual = path.join(CHECKOUT_CACHE, "e2e-library", "manual-keep"); mkdirSync(manual, { recursive: true }); writeFileSync(path.join(manual, "keep.txt"), "keep");
  await page.getByRole("button", { name: "Add folder…" }).click(); await page.getByRole("textbox", { name: "Add a folder path" }).fill(manual); await page.getByRole("button", { name: "Add", exact: true }).click();
  await remove(page, "example/docs"); await expect(page.getByRole("button", { name: "More for manual-keep" })).toBeVisible();
  const { readFileSync } = await import("node:fs"); expect(readFileSync(path.join(manual, "keep.txt"), "utf8")).toBe("keep");
});

test("Library import controls keep their dimensions on a narrow screen", async ({ page, open }, info) => {
  await page.setViewportSize({ width: 360, height: 844 }); await open(); await library(page);
  const row = slot(page, "chinook"); const button = fill(row); const before = await size(row);
  await shot(page, info, "phone-before"); await button.click(); await expect(button).toHaveText(/^\d+%$/);
  for (let n = 0; n < 4; n++) { expect(await size(row)).toEqual(before); await shot(page, info, `phone-progress-${n}`); }
  await isDatabase(row, "Chinook"); expect(await size(row)).toEqual(before);
  await row.locator(".db-open").click(); await expect(row.locator(".db-q")).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "nothing runs off a 360 px screen").toBe(true);
  await shot(page, info, "library-open-360");
  const input = page.getByRole("textbox", { name: "Public GitHub repository URL" });
  // The opened row above pushes the field below the fold; measure it where typing will scroll it to.
  await input.scrollIntoViewIfNeeded();
  const clone = page.locator(".srow", { has: input }).getByRole("button"); const cloneSize = await size(clone);
  await input.fill("https://github.com/example/docs"); await clone.click(); await expect(clone).toHaveText("Cancel");
  for (let n = 0; n < 4; n++) { expect(await size(clone)).toEqual(cloneSize); await shot(page, info, `phone-clone-progress-${n}`); }
  await expect(clone).toHaveText("Added"); expect(await size(clone)).toEqual(cloneSize); await shot(page, info, "phone-clone-added");
});

test.describe("while an import is interrupted", () => {
  // The server is deliberately absent while the client tries to reconnect.
  test.use({ allowedErrors: [/WebSocket connection to .* failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED/] });
  test("Library cancels a clone and recovers a restart mid-clone before retry", async ({ page, open }, info) => {
  await open(); await library(page);
  const input = page.getByRole("textbox", { name: "Public GitHub repository URL" });
  const row = page.locator(".srow", { has: input }); const button = row.getByRole("button");
  await input.fill("https://github.com/example/docs"); await button.click(); await expect(button).toHaveText("Cancel");
  await button.click(); await expect(button).toHaveText("Retry");
  await expect(page.getByRole("button", { name: "More for example/docs" })).toHaveCount(0);
  await button.click(); await expect(button).toHaveText("Cancel");
  await stack.restart();
  await expect(button).toHaveText("Clone", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "More for example/docs" })).toHaveCount(0);
  await button.click(); await expect(button).toHaveText("Added"); await shot(page, info, "restart-retried");
  });
});

for (const width of [1440, 390]) {
  test(`Library Retry returns to cancelled and failed repositories at ${width}px (DG-02)`, async ({ page, open }, info) => {
    test.info().annotations.push({ type: "budget", description: "Both cancelled and failed clone recovery cross Settings remounts and real import-state polling; each retry must finish as the right added source." });
    await page.setViewportSize({ width, height: 900 }); await open(); await library(page);
    const input = page.getByRole("textbox", { name: "Public GitHub repository URL" });
    const button = page.locator(".srow", { has: input }).getByRole("button");
    for (const mode of ["cancelled", "failed"] as const) await test.step(`recover the ${mode} repository`, async () => {
    const key = `https://github.com/example/retry-${mode}`;
    await input.fill(key); await button.click(); await expect(button).toHaveText("Cancel");
    if (mode === "cancelled") { await button.click(); await expect(button).toHaveText("Retry"); }
    await page.keyboard.press("Escape"); await waitReady(page);
    await library(page); await expect(input).toHaveValue(""); await expect(button).toHaveText("Retry");
    await shot(page, info, "retry-returned");
    await button.click(); await expect(input).toHaveValue(key); await expect(button).toHaveText("Added");
    await expect(page.getByRole("button", { name: `More for example/retry-${mode}` })).toBeVisible();
    await shot(page, info, `retry-${mode}-added`);
    });
  });
}
