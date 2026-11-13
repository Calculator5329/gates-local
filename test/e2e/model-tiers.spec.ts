// Settings rows 18 and 21, the owner 2026-11-13 after a fresh Windows install. Row 21: recommend by
// the computer's memory, a tier per GPU size and per system memory size without a GPU (the picks
// are in apps/server/src/runtime/tiers.ts). Row 18, the layout he picked (A): a verdict every row
// shares is said once above the list, the size is the download button's label, and models that
// cannot run sit in a closed last group, "Too big for this computer", with what they need.
import type { Page } from "@playwright/test";
import { expect, openModels, stack, test, waitReady } from "./fixtures.ts";

interface Profile {
  readonly name: string;
  readonly shot: string;
  /** Sets the computer up after the reset; undefined: the stack's 16 GB card and 32 GB of memory. */
  readonly computer?: () => Promise<unknown>;
  /** The Recommended group, in order. */
  readonly picks: readonly string[];
  /** The line said once above the list. */
  readonly once: string | RegExp;
  readonly tooBig: readonly string[];
  /** Start this download and shoot it running. */
  readonly download?: string;
}

const INSTALLED = ["qwen3.5:9b", "gemma4:12b"];
const NO_GPU_ONCE = "No supported GPU, so these run in system memory and replies are slower.";
/** Some rows run on the GPU and some slower: the line says the GPU, the slower rows say so themselves. */
const SPLIT_ONCE = /^These run on your .+, except the ones marked slower\.$/;
const PROFILES: readonly Profile[] = [
  {
    name: "no GPU and 16 GB of memory",
    shot: "dl-a-after-nogpu-16gb.png",
    computer: () => stack.computer(15.6, "none"),
    picks: ["qwen3.5:4b", "qwen3.5:9b", "qwen3-vl:8b"],
    once: NO_GPU_ONCE,
    tooBig: ["gpt-oss:20b", "mistral-small3.2:24b"],
  },
  { name: "a 16 GB card", shot: "dl-a-after-gpu-16gb.png", picks: ["qwen3.5:9b", "qwen3:14b", "gpt-oss:20b"], once: SPLIT_ONCE, tooBig: [] },
  {
    name: "a 24 GB card",
    shot: "dl-a-after-all-fit.png",
    computer: () => stack.gpu(0, 24 * 1024 - 150),
    picks: ["mistral-small3.2:24b", "gpt-oss:20b", "qwen3:14b"],
    once: /^These run on your .+\.$/,
    tooBig: [],
  },
  {
    name: "an 8 GB card and 8 GB of memory, one downloading",
    shot: "dl-a-after-8gb-downloading.png",
    computer: async () => { await stack.computer(7.6); await stack.gpu(0, 8 * 1024 - 150); },
    picks: ["qwen3.5:9b", "qwen3.5:4b", "qwen3-vl:8b"],
    once: SPLIT_ONCE,
    tooBig: ["gpt-oss:20b", "mistral-small3.2:24b"],
    download: "qwen3.5:4b",
  },
];

const group = (page: Page, title: RegExp) => page.locator(".mp .grp").filter({ has: page.locator(".grp-t", { hasText: title }) });
const tags = (rows: ReturnType<Page["locator"]>) => rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-cat") ?? ""));

// Guards the owner's rows 18 (layout A) and 21 (recommend by memory tier).
for (const profile of PROFILES) {
  test(`Download on ${profile.name}: the tier's picks, the shared verdict said once, the size on each button`, async ({ page, open }, info) => {
    // two models installed, so every verdict above comes from the curated list; a scenario resets the GPU, so it goes first
    await stack.scenario("models", { installed: INSTALLED, ...profile.download === undefined ? {} : { pullTickMs: 1000, pullChunkBytes: 100 * 1024 ** 2 } });
    await profile.computer?.();
    await open();
    await waitReady(page);
    await openModels(page);
    await page.getByRole("tab", { name: /^Download/ }).click();
    const list = page.locator(".mp");
    await expect(list.locator('.dlrow[data-cat="qwen3.5:4b"]')).toBeVisible();
    await expect(list.locator("[aria-busy=true]")).toHaveCount(0);
    if (profile.download !== undefined) {
      await list.locator(`.dlrow[data-cat="${profile.download}"]`).getByRole("button", { name: /^Download/ }).click();
      await expect(list.locator(`.dlrow[data-cat="${profile.download}"]`).getByRole("progressbar")).toBeVisible();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(2500);
    }
    await page.screenshot({ path: info.outputPath(profile.shot), animations: "disabled" });

    expect(await tags(group(page, /^Recommended/).locator(".dlrow[data-cat]")), "the tier's picks, first pick first").toEqual(profile.picks);
    await expect(list.locator(".dl-once")).toHaveText(profile.once);
    // said once: no row repeats a verdict every row shares; when they split, only the slower rows say so
    if (profile.once === SPLIT_ONCE) await expect(list.locator(".dlrow .vl.spill").first()).toBeVisible();
    else await expect(list.locator(".dlrow .vl")).toHaveCount(0);
    await expect(list.locator(".dlrow .vl.gpu")).toHaveCount(0);
    // the size is the button's label
    const idle = profile.download === "qwen3.5:4b" ? "qwen3-vl:8b" : "qwen3.5:4b";
    await expect(list.locator(`.dlrow[data-cat="${idle}"]`).getByRole("button", { name: /^Download \d+\.\d\sGB$/ })).toHaveText(/^\d+\.\d\sGB$/);

    const big = list.locator("details.dl-bigs");
    if (profile.tooBig.length === 0) await expect(big).toHaveCount(0);
    else {
      await expect(big, "the Too big group starts closed").not.toHaveAttribute("open", /.*/);
      await big.locator("summary").click();
      expect((await tags(big.locator(".dlrow[data-cat]"))).toSorted()).toEqual([...profile.tooBig].toSorted());
      for (const row of await big.locator(".dlrow").all()) {
        await expect(row.locator(".dl-need")).toHaveText(/^needs \d+\.\d\sGB of memory$/);
        await expect(row.getByRole("button")).toHaveCount(0);
      }
    }
    if (profile.computer !== undefined && profile.once === NO_GPU_ONCE) await expect(list).not.toContainText(/on (?:the |your )?GPU/);
  });
}

// Row 22, the owner 2026-11-13: a typed name gets the list's check before it downloads. Its size is
// the button, a model too big for this computer turns the button off with Download anyway in a menu,
// and a name the library does not have says so. An 8 GB card with 8 GB of memory.
test("a typed model name: its size and verdict, too big with Download anyway in a menu, and a name the library does not have", async ({ page, open }, info) => {
  await stack.scenario("models", { installed: INSTALLED });
  await stack.computer(7.6);
  await stack.gpu(0, 8 * 1024 - 150);
  await open();
  await waitReady(page);
  await openModels(page);
  await page.getByRole("tab", { name: /^Download/ }).click();
  const field = page.getByRole("textbox", { name: "Model name" });
  const row = field.locator("xpath=ancestor::*[contains(@class,'srow')][1]");
  const said = row.locator(".dl-typed");
  // the row, and the row menu when it is open below it
  const shot = async (file: string) => {
    await page.mouse.move(0, 0);
    const menu = page.locator(".dl-menu");
    const boxes = [await row.boundingBox(), await menu.count() > 0 ? await menu.boundingBox() : null].filter(b => b !== null);
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    const clip = { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
    await page.screenshot({ path: info.outputPath(file), clip, animations: "disabled" });
  };

  await field.fill("qwen3.5:4b");
  await expect(row.getByRole("button", { name: /^Download \d+\.\d\sGB$/ })).toBeEnabled();
  await expect(said, "a model that runs on the GPU needs no words").toHaveCount(0);
  await shot("typed-fits.png");

  await field.fill("mistral-small3.2:24b");
  await expect(said).toHaveText(/^Too big for this computer · needs \d+\.\d\sGB$/);
  await expect(row.getByRole("button", { name: /^Download \d+\.\d\sGB$/ })).toBeDisabled();
  await row.getByRole("button", { name: "More for mistral-small3.2:24b" }).click();
  const anyway = page.getByRole("menuitem", { name: /^Download anyway/ });
  await expect(anyway).toBeVisible();
  // the size is said whole in the menu (it was cut to "14.1 G")
  expect(await anyway.locator(".mp-k").evaluate(el => el.scrollWidth <= el.clientWidth), "the menu's size is not cut").toBe(true);
  await shot("typed-too-big.png");
  // Escape closes the row menu, not the Models pop-up
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: /^Download anyway/ })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "More for mistral-small3.2:24b" })).toBeFocused();

  await field.fill("no-such-model:1b");
  await expect(said).toHaveText("Not in the Ollama library. Check the name.");
  await expect(row.getByRole("button", { name: /^Download/ })).toBeDisabled();
  await shot("typed-unknown.png");
});
