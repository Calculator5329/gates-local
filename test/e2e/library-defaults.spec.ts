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
  await expect(page.locator('[data-import="chinook"]')).toBeVisible();
}
async function shot(page: Page, info: TestInfo, name: string) { await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true }); }
async function size(button: Locator) { const box = await button.boundingBox(); expect(box).not.toBeNull(); return box; }
const remove = async (page: Page, label: string) => {
  await page.getByRole("button", { name: `More for ${label}` }).click();
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
};

test("Library samples keep their control size through download, cancel, retry and added", async ({ page, open }, info) => {
  await open(); await library(page);
  const row = page.locator('[data-import="chinook"]'); const button = row.getByRole("button");
  await expect(button).toHaveText("Download"); await expect(row).toContainText("8 KiB");
  const before = await size(button); await shot(page, info, "01-before");
  await button.click(); await expect(button).toHaveText("Cancel");
  for (let n = 0; n < 4; n++) { expect(await size(button)).toEqual(before); await shot(page, info, `02-progress-${n}`); }
  await button.click(); await expect(button).toHaveText("Retry"); expect(await size(button)).toEqual(before); await shot(page, info, "03-cancelled");
  await button.click(); await expect(button).toHaveText("Added"); expect(await size(button)).toEqual(before); await expect(button).toBeDisabled();
  await shot(page, info, "04-added");
  await expect(page.locator(".srow.src .sl b", { hasText: "Chinook" })).toHaveCount(1);
  await remove(page, "Chinook"); await expect(button).toHaveText("Download");
  const northwind = page.locator('[data-import="northwind"]'); await northwind.getByRole("button").click();
  await expect(northwind.getByRole("alert")).toContainText("Check your connection and retry"); await expect(northwind.getByRole("button")).toHaveText("Retry");
  await shot(page, info, "05-offline"); await northwind.getByRole("button").click(); await expect(northwind.getByRole("button")).toHaveText("Added");
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

test("Library import controls keep their dimensions on a phone", async ({ page, open }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(); await library(page);
  const button = page.locator('[data-import="chinook"]').getByRole("button"); const before = await size(button);
  await shot(page, info, "phone-before"); await button.click(); await expect(button).toHaveText("Cancel");
  for (let n = 0; n < 4; n++) { expect(await size(button)).toEqual(before); await shot(page, info, `phone-progress-${n}`); }
  await expect(button).toHaveText("Added"); expect(await size(button)).toEqual(before); await shot(page, info, "phone-added");
  const input = page.getByRole("textbox", { name: "Public GitHub repository URL" });
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
