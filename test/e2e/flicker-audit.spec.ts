/// <reference lib="dom" />
// Every surface is whole on its first frame (docs/design.md). Each journey
// slows the link so every answer, push and code chunk arrives late, watches
// every animation frame from the action until the page is quiet, and fails on
// anything that arrives after the surface's first frame, moves, changes its
// words outside a placeholder, or is still a placeholder at the end. The same
// watch runs in the desktop app in settings-cards-desktop.spec.ts, where code
// chunks come through the app's own protocol.
import type { Page } from "@playwright/test";
import { type Delay, type WholeFinding, type WholeFrame, type WholeOptions, collectWhole, delayEverything, settled, watchFromLoad, watchWhole, wholeFindings } from "./flicker-probe.ts";
import { expect, test, waitReady } from "./fixtures.ts";

/** Long enough that every loading state shows on a fast machine. */
const DELAY_MS = 600;

test.use({ seed: "design", video: process.env["GL_E2E_RECORD"] ? "on" : "off", comfyUrl: "http://127.0.0.1:1" });

/** Collect, print and keep each step's findings, so one run lists everything. */
function recorder() {
  const all: WholeFinding[] = [];
  return {
    all,
    check(step: string, frames: readonly WholeFrame[]) {
      const found = wholeFindings(step, frames);
      const from = frames.findIndex((f) => f.arrived);
      console.log(`WHOLE ${step}: ${frames.length} frames, first shown at frame ${from}, ${found.length} findings`);
      for (const f of found) console.log(`WHOLE FINDING ${JSON.stringify(f)}`);
      all.push(...found);
    },
  };
}

async function ready(page: Page, delay: Delay): Promise<void> {
  await waitReady(page);
  await settled(delay);
}

const section = (name: string): WholeOptions => ({ root: ".set", arrive: { selector: ".set-h h1, .mp-head h1", text: name } });

test("every Settings section is whole on its first frame", async ({ page, open }) => {
  test.setTimeout(120_000);
  const delay = await delayEverything(page, DELAY_MS);
  await open();
  await ready(page, delay);
  const r = recorder();
  r.check("open Settings", await watchWhole(page, section("General"), () => page.keyboard.press("Control+Comma"), delay));
  const names = (await page.locator(".snav button:not(.back)").allInnerTexts()).map((t) => t.trim()).filter((t) => t !== "" && t !== "General");
  expect(names, "the sections this journey visits").toContain("Models");
  for (const name of names) {
    await settled(delay, 3000);
    const button = page.locator(".snav").getByRole("button", { name, exact: true });
    r.check(`first visit to ${name}`, await watchWhole(page, section(name), () => button.click(), delay));
    if (name === "Models") {
      await settled(delay, 3000);
      r.check("Models, Download tab", await watchWhole(page, { root: ".set", arrive: { selector: ".mp-tab[aria-selected=true] .mp-lbl", text: "Download" } }, () => page.getByRole("tab", { name: /Download/ }).click(), delay));
      await settled(delay, 3000);
      r.check("Models, back to Installed", await watchWhole(page, { root: ".set", arrive: { selector: ".mp-tab[aria-selected=true] .mp-lbl", text: "Installed" } }, () => page.getByRole("tab", { name: /Installed/ }).click(), delay));
    }
  }
  await settled(delay, 3000);
  r.check("General, second visit", await watchWhole(page, section("General"), () => page.locator(".snav").getByRole("button", { name: "General", exact: true }).click(), delay));
  expect(r.all, "Settings: what arrived late, moved or changed its words").toEqual([]);
});

test("Library after a download is whole on its first frame", async ({ page, open }) => {
  test.setTimeout(90_000);
  const delay = await delayEverything(page, DELAY_MS);
  await open();
  await ready(page, delay);
  await page.keyboard.press("Control+Comma");
  const library = page.locator(".snav").getByRole("button", { name: "Library", exact: true });
  await library.click();
  const row = page.locator('[data-db="sample:chinook"]');
  await row.getByRole("button", { name: "Download Chinook" }).click();
  await expect(row.getByRole("button", { name: "Remove Chinook" })).toBeVisible({ timeout: 30_000 });
  await settled(delay, 3000);
  await page.locator(".snav").getByRole("button", { name: "General", exact: true }).click();
  await settled(delay, 3000);
  const r = recorder();
  r.check("Library after a download", await watchWhole(page, section("Library"), () => library.click(), delay));
  expect(r.all, "Library after a download: what arrived late, moved or changed its words").toEqual([]);
});

test("app start is whole on its first frame", async ({ page, open }) => {
  test.setTimeout(60_000);
  await watchFromLoad(page, { root: "#app" });
  const delay = await delayEverything(page, DELAY_MS);
  await open();
  await waitReady(page);
  const r = recorder();
  r.check("app start", await collectWhole(page, delay, 1500, 10_000));
  expect(r.all, "app start: what arrived late, moved or changed its words").toEqual([]);
});

test("opening a thread is whole on its first frame", async ({ page, open }) => {
  test.setTimeout(60_000);
  const delay = await delayEverything(page, DELAY_MS);
  await open();
  await ready(page, delay);
  const r = recorder();
  const title = "Fix the backup cron";
  r.check("open a thread", await watchWhole(page, { root: ".main", arrive: { selector: ".hdr h2", text: title } }, () => page.locator(".sb-row").filter({ hasText: title }).click(), delay));
  await settled(delay, 3000);
  const other = "Whisper latency check";
  r.check("switch thread", await watchWhole(page, { root: ".main", arrive: { selector: ".hdr h2", text: other } }, () => page.locator(".sb-row").filter({ hasText: other }).click(), delay));
  expect(r.all, "thread: what arrived late, moved or changed its words").toEqual([]);
});

test("the model picker is whole on its first frame", async ({ page, open }) => {
  test.setTimeout(60_000);
  const delay = await delayEverything(page, DELAY_MS);
  await open();
  await ready(page, delay);
  const r = recorder();
  r.check("open the picker", await watchWhole(page, { root: "#picker", arrive: { selector: "#picker.open" } }, () => page.locator("#modelBtn").click(), delay));
  expect(r.all, "picker: what arrived late, moved or changed its words").toEqual([]);
});

test("the fit panel is whole on its first frame", async ({ page, open }) => {
  test.setTimeout(60_000);
  const delay = await delayEverything(page, DELAY_MS);
  await open();
  await ready(page, delay);
  const r = recorder();
  // The composer and the picker open memory details through openFit, onto Settings › Advanced.
  await page.locator("#modelBtn").click();
  await expect(page.locator("#picker.open")).toBeVisible();
  await settled(delay, 3000);
  const big = page.locator('#picker .pk-r[data-m="qwen3.8-abliterated:27b"]');
  await big.hover();
  const details = page.locator("#picker").getByRole("button", { name: "Memory details", exact: true });
  const action = await details.isVisible() ? () => details.click() : async () => { await page.keyboard.press("Escape"); await page.keyboard.press("Control+Comma"); await page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).click(); };
  r.check("open the fit panel", await watchWhole(page, { root: ".set", arrive: { selector: ".set-h h1", text: "Advanced" } }, action, delay));
  expect(r.all, "fit panel: what arrived late, moved or changed its words").toEqual([]);
});

test.describe("first run", () => {
  test.use({ skipFirstRun: false, seed: 0 });
  test("first run is whole on its first frame", async ({ page, open }) => {
    test.setTimeout(60_000);
    await watchFromLoad(page, { root: ".first" });
    const delay = await delayEverything(page, DELAY_MS);
    await open();
    await expect(page.getByRole("heading", { name: "Ready to chat" })).toBeVisible({ timeout: 15_000 });
    const r = recorder();
    r.check("first run", await collectWhole(page, delay, 1500, 10_000));
    expect(r.all, "first run: what arrived late, moved or changed its words").toEqual([]);
  });
});
