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
import { expect, stack, test, waitReady } from "./fixtures.ts";

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

// Guards the owner's ruling (N21): nothing pops in late; every Settings section is whole on its first frame.
test("every Settings section is whole on its first frame", async ({ page, open }) => {
  test.setTimeout(120_000);
  const delay = await delayEverything(page, DELAY_MS);
  await open();
  await ready(page, delay);
  const r = recorder();
  r.check("open Settings", await watchWhole(page, section("General"), () => page.keyboard.press("Control+Comma"), delay));
  const names = (await page.locator(".snav button:not(.back)").allInnerTexts()).map((t) => t.trim()).filter((t) => t !== "" && t !== "General");
  expect(names, "Models is the footer's own pop-up, not a section (settings row 6)").not.toContain("Models");
  for (const name of names) {
    await settled(delay, 3000);
    const button = page.getByTestId(`settings.nav.open-${name === "Image generation" ? "images" : name.toLowerCase()}`);
    r.check(`first visit to ${name}`, await watchWhole(page, section(name), () => button.click(), delay));
  }
  await settled(delay, 3000);
  r.check("General, second visit", await watchWhole(page, section("General"), () => page.getByTestId("settings.nav.open-general").click(), delay));
  // Settings is a pop-up: it closes before the footer's Models opens its own
  await page.keyboard.press("Escape");
  await expect(page.locator(".dlg")).toHaveCount(0);
  await settled(delay, 3000);
  r.check("open Models", await watchWhole(page, { root: ".dlg", arrive: { selector: ".dlg-head h2", text: "Models" } }, () => page.locator(".sb-foot").getByRole("button", { name: /^Models/ }).click(), delay));
  await settled(delay, 3000);
  r.check("Models, Download tab", await watchWhole(page, { root: ".dlg", arrive: { selector: ".mp-tab[aria-selected=true] .mp-lbl", text: "Download" } }, () => page.getByRole("tab", { name: /Download/ }).click(), delay));
  await settled(delay, 3000);
  r.check("Models, back to Installed", await watchWhole(page, { root: ".dlg", arrive: { selector: ".mp-tab[aria-selected=true] .mp-lbl", text: "Installed" } }, () => page.getByRole("tab", { name: /Installed/ }).click(), delay));
  expect(r.all, "Settings: what arrived late, moved or changed its words").toEqual([]);
});

// Guards the owner's ruling (N21) and report on the Library size jump: whole after a download.
test("Library after a download is whole on its first frame", async ({ page, open }) => {
  test.setTimeout(90_000);
  const delay = await delayEverything(page, DELAY_MS);
  await open();
  await ready(page, delay);
  await page.keyboard.press("Control+Comma");
  const library = page.getByTestId("settings.nav.open-library");
  await library.click();
  const row = page.locator('[data-db="sample:chinook"]');
  await row.getByRole("button", { name: "Download Chinook" }).click();
  await expect(row.getByRole("button", { name: "Remove Chinook" })).toBeVisible({ timeout: 30_000 });
  await settled(delay, 3000);
  await page.getByTestId("settings.nav.open-general").click();
  await settled(delay, 3000);
  const r = recorder();
  r.check("Library after a download", await watchWhole(page, section("Library"), () => library.click(), delay));
  expect(r.all, "Library after a download: what arrived late, moved or changed its words").toEqual([]);
});

// Guards the owner's ruling (N21): opening the app is whole on its first frame.
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

// Guards the owner's ruling (N21): switching threads is whole on its first frame.
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

// Guards the owner's ruling (N21): the model picker is whole on its first frame.
test("the model picker is whole on its first frame", async ({ page, open }) => {
  test.setTimeout(60_000);
  const delay = await delayEverything(page, DELAY_MS);
  await open();
  await ready(page, delay);
  const r = recorder();
  r.check("open the picker", await watchWhole(page, { root: "#picker", arrive: { selector: "#picker.open" } }, () => page.locator("#modelBtn").click(), delay));
  expect(r.all, "picker: what arrived late, moved or changed its words").toEqual([]);
});

// Guards the owner's ruling (N21): the fit panel is whole on its first frame.
test("the fit panel is whole on its first frame", async ({ page, open }) => {
  test.setTimeout(60_000);
  // A computer where the 27B cannot load (the 16 GB card and 8 GB of memory), so its row offers
  // Memory details: the one step from the picker onto Settings › Advanced.
  await stack.computer(8);
  const delay = await delayEverything(page, DELAY_MS);
  await open();
  await ready(page, delay);
  const r = recorder();
  await page.locator("#modelBtn").click();
  await expect(page.locator("#picker.open")).toBeVisible();
  await settled(delay, 3000);
  await page.locator('#picker .pk-r[data-m="qwen3.8-abliterated:27b"]').hover();
  // No other route here: a detour through Settings would be watched as a passing screen.
  const details = page.locator("#picker").getByRole("button", { name: "Memory details", exact: true });
  await expect(details).toBeVisible();
  r.check("open the fit panel", await watchWhole(page, { root: ".set", arrive: { selector: ".set-h h1", text: "Advanced" } }, () => details.click(), delay));
  expect(r.all, "fit panel: what arrived late, moved or changed its words").toEqual([]);
});

test.describe("first run", () => {
  test.use({ skipFirstRun: false, seed: 0 });
  // Guards the owner's ruling (N21): first run is whole on its first frame.
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
