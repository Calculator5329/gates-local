/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

async function library(page: Page) {
  await waitReady(page); await page.keyboard.press("Control+Comma");
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    await page.getByTestId("settings.shell.back").click();
    await page.getByTestId("settings.sections.open-library").click();
  } else await page.getByTestId("settings.nav.open-library").click();
  await expect(page.locator('[data-db="sample:chinook"]')).toBeVisible();
}
async function size(button: Locator) { const box = await button.boundingBox(); expect(box).not.toBeNull(); return box; }
/** A sample's slot: at rest, while its button fills, and once it is the database (the fixture file has one table). */
const slot = (page: Page, id: string) => page.locator(`[data-db="sample:${id}"]`);
const fill = (row: Locator) => row.locator(".fill-btn");
const isDatabase = (row: Locator, label: string) => expect(row.getByRole("button", { name: `Remove ${label}` })).toBeVisible({ timeout: 15_000 });

// Guards the owner's rule that nothing moves, on the Library he raised: a sample downloads in place.
test("a sample downloads in its own row: same place and height throughout, one row at the end", async ({ page, open }) => {
  await open(); await library(page);
  const row = slot(page, "chinook"); const button = fill(row);
  const add = page.getByTestId("settings.library.add-sqlite");
  await expect(button).toHaveText("Download"); await expect(row).toContainText("Sample ·"); await expect(row.locator(".import-rest")).toContainText("8 KB");
  const before = await size(row); const addBefore = await size(add); const buttonBefore = await size(button);
  await button.click(); await expect(button).toHaveText(/^\d+%$/);
  await expect(button).toHaveAttribute("data-tip", "Cancel download");
  for (let n = 0; n < 4; n++) { expect(await size(row)).toEqual(before); expect(await size(button)).toEqual(buttonBefore); }
  // Part filled: the fake sends 512 bytes every 200 ms and the list polls every 500 ms.
  await expect(button).toHaveText(/^[3-7]\d%$/); expect(await size(button)).toEqual(buttonBefore);
  // Pressing the filling button cancels; the grey line says so and the button offers Retry.
  await button.click(); await expect(button).toHaveText("Retry"); await expect(row.locator(".import-status")).toContainText("Cancelled.");
  expect(await size(row)).toEqual(before);
  await button.click(); await expect(button).toHaveText(/^\d+%$/);
  await isDatabase(row, "Chinook");
  expect(await size(row)).toEqual(before);
  await expect(row).toContainText("1 table");
  // One row for the database: no second row, no "Ready in Library", no "Added"; the Add row has not moved.
  await expect(page.locator(".db-row", { hasText: "Chinook" })).toHaveCount(1);
  await expect(page.getByText("Ready in Library")).toHaveCount(0); await expect(page.getByText("Added", { exact: true })).toHaveCount(0);
  expect(await size(add)).toEqual(addBefore);
  // Removing it turns the slot back into the sample, in place.
  await row.getByRole("button", { name: "Remove Chinook" }).click(); await expect(button).toHaveText("Download");
  expect(await size(row)).toEqual(before);
});

// Settings row 12 (owner 2026-11-13): "the download library animation isn't good when its quick.
// maybe a minimum animation". The fake hands over the Periodic table at once.
test("a quick download still fills over at least 800 ms, its % with the fill, then the check", async ({ page, open }) => {
  await open(); await library(page);
  const row = slot(page, "elements"); const button = fill(row);
  await expect(button).toHaveText("Download");
  await button.evaluate((el: HTMLElement) => {
    const w = window as unknown as { fillFrames: { at: number; scale: number; label: string; check: number }[] };
    w.fillFrames = [];
    el.addEventListener("pointerdown", () => {
      const from = performance.now();
      const frame = () => {
        const bar = el.querySelector(".fill"); const chk = el.querySelector(".chk");
        if (!el.isConnected || !bar || !chk) return;
        const m = new DOMMatrixReadOnly(getComputedStyle(bar).transform);
        w.fillFrames.push({ at: performance.now() - from, scale: getComputedStyle(bar).transform === "none" ? 1 : m.a, label: el.querySelector(".lab")?.textContent ?? "", check: Number(getComputedStyle(chk).opacity) });
        if (performance.now() - from < 2500) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, { once: true, capture: true });
  });
  await button.click();
  await isDatabase(row, "Periodic table");
  const frames = await page.evaluate(() => (window as unknown as { fillFrames: { at: number; scale: number; label: string; check: number }[] }).fillFrames);
  expect(frames.length, "the frame probe must be live").toBeGreaterThan(20);
  const full = frames.find(f => f.scale >= 0.99);
  expect(full, "the fill reaches full").toBeDefined();
  expect(full!.at, "the fill takes at least 800 ms from the press").toBeGreaterThanOrEqual(800);
  const counts = frames.flatMap(f => /^\d+%$/.test(f.label) ? [Number.parseInt(f.label, 10)] : []);
  expect(new Set(counts.filter(n => n > 0 && n < 100)).size, "the % counts up through the fill").toBeGreaterThanOrEqual(5);
  expect(counts, "the % never goes back").toEqual(counts.toSorted((a, b) => a - b));
  for (const f of frames) if (/^\d+%$/.test(f.label)) expect(Math.abs(Number.parseInt(f.label, 10) - f.scale * 100), `the % is the fill shown at ${Math.round(f.at)} ms`).toBeLessThanOrEqual(10);
  const checked = frames.find(f => f.check > 0);
  expect(checked, "the check shows").toBeDefined();
  expect(checked!.at, "the check waits for the full fill").toBeGreaterThanOrEqual(full!.at);
});

// Guards the owner's ruling: a sample database offers questions to ask it.
test("an opened sample lists its tables and asks its questions in a new chat", async ({ page, open }) => {
  await open(); await library(page);
  const row = slot(page, "chinook");
  await row.locator(".db-open").click();
  await expect(row.locator(".db-open")).toHaveAttribute("aria-expanded", "true");
  // Not downloaded: the catalog's tables, and questions that say why they wait.
  await expect(row.locator(".db-t")).toHaveCount(11);
  await expect(row.locator(".db-why")).toHaveText("Download it to ask these.");
  await expect(row.locator(".db-q")).toHaveCount(4);
  for (const q of await row.locator(".db-q").all()) await expect(q).toBeDisabled();
  await fill(row).click(); await isDatabase(row, "Chinook");
  await expect(row.locator(".db-why")).toHaveCount(0);
  const question = row.locator(".db-q").first(); const words = (await question.innerText()).trim();
  await question.click();
  // Settings is gone, the new chat is on screen with the question sent and its reply under way, and the caret is in its message box.
  await expect(page.locator(".set")).toHaveCount(0);
  await expect(page.locator(".turn.u").last()).toContainText(words);
  await expect(page.locator(".turn.a").last()).toBeVisible();
  await expect(page.locator("#ta")).toHaveValue("");
  await expect(page.locator("#ta")).toBeFocused();
});
