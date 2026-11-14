// Settings rows 18 and 21, the owner 2026-11-13 after a fresh Windows install. Row 21: recommend by
// the computer's memory, a tier per GPU size and per system memory size without a GPU (the picks
// are in packages/contracts/src/chat-models.json). Row 18, the layout he picked (A): the size is the
// download button's label, and models that cannot run sit in a closed last group, "Too big for this
// computer", with what they need. Decision 11: the memory mark alone says slower; no line above the list.
import type { Page } from "@playwright/test";
import { expect, openModels, stack, test, waitReady } from "./fixtures.ts";

interface Profile {
  readonly name: string;
  readonly shot: string;
  /** Sets the computer up after the reset; undefined: the stack's 16 GB card and 32 GB of memory. */
  readonly computer?: () => Promise<unknown>;
  /** The Recommended group, in order. */
  readonly picks: readonly string[];
  /** Where the rows run: none on a GPU, some slower, or all on the GPU (decision 11: the marks alone say it). */
  readonly runs: "cpu" | "split" | "gpu";
  readonly tooBig: readonly string[];
  /** Start this download and shoot it running. */
  readonly download?: string;
}

const INSTALLED = ["qwen3.5:9b", "gemma4:12b"];
const PROFILES: readonly Profile[] = [
  {
    name: "no GPU and 16 GB of memory",
    shot: "dl-a-after-nogpu-16gb.png",
    computer: () => stack.computer(15.6, "none"),
    picks: ["qwen3.5:4b", "qwen3.5:9b"],
    runs: "cpu",
    tooBig: ["gpt-oss:20b", "qwen3.8:27b"],
  },
  { name: "a 16 GB card", shot: "dl-a-after-gpu-16gb.png", picks: ["qwen3.5:9b", "gpt-oss:20b", "gemma4:12b"], runs: "split", tooBig: [] },
  {
    name: "a 24 GB card",
    shot: "dl-a-after-all-fit.png",
    computer: () => stack.gpu(0, 24 * 1024 - 150),
    picks: ["qwen3.8:27b", "gpt-oss:20b", "gemma4:12b"],
    runs: "gpu",
    tooBig: [],
  },
  {
    name: "an 8 GB card and 8 GB of memory, one downloading",
    shot: "dl-a-after-8gb-downloading.png",
    computer: async () => { await stack.computer(7.6); await stack.gpu(0, 8 * 1024 - 150); },
    picks: ["qwen3.5:9b", "qwen3.5:4b"],
    runs: "split",
    tooBig: ["gpt-oss:20b", "qwen3.8:27b"],
    download: "qwen3.5:4b",
  },
];

const group = (page: Page, title: RegExp) => page.locator(".mp .grp").filter({ has: page.locator(".grp-t", { hasText: title }) });
const tags = (rows: ReturnType<Page["locator"]>) => rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-cat") ?? ""));

// Guards the owner's rows 18 (layout A) and 21 (recommend by memory tier).
for (const profile of PROFILES) {
  test(`Download on ${profile.name}: the tier's picks, the marks alone saying slower, the size on each button`, async ({ page, open }, info) => {
    // two models installed, so every verdict above comes from the curated list; a scenario resets the GPU, so it goes first
    // with one downloading, Gemma 4 12B stays out so an idle row still shows its size on the button
    await stack.scenario("models", { installed: profile.download === undefined ? INSTALLED : ["qwen3.5:9b"], ...profile.download === undefined ? {} : { pullTickMs: 1000, pullChunkBytes: 100 * 1024 ** 2 } });
    await profile.computer?.();
    await open();
    await waitReady(page);
    await openModels(page);
    await page.getByTestId("models.tabs.download").click();
    const list = page.locator(".mp");
    await expect(list.locator('.dlrow[data-cat="qwen3.5:4b"]')).toBeVisible();
    await expect(list.locator("[aria-busy=true]")).toHaveCount(0);
    if (profile.download !== undefined) {
      await list.locator(`.dlrow[data-cat="${profile.download}"]`).getByTestId("models.download.start").click();
      await expect(list.locator(`.dlrow[data-cat="${profile.download}"]`).getByRole("progressbar")).toBeVisible();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(2500);
    }
    await page.screenshot({ path: info.outputPath(profile.shot), animations: "disabled" });

    expect(await tags(group(page, /^Recommended/).locator(".dlrow[data-cat]")), "the tier's picks, first pick first").toEqual(profile.picks);
    // decision 11: no line above the list and no verdict words on a row; the orange mark alone says slower
    await expect(list.locator(".dl-once")).toHaveCount(0);
    await expect(list.locator(".dlrow .vl")).toHaveCount(0);
    if (profile.runs === "split") await expect(list.locator(".dlrow .mm.spill").first()).toBeVisible();
    if (profile.runs === "gpu") await expect(list.locator(".dlrow .mm.spill")).toHaveCount(0);
    // the size is the button's label
    const idle = profile.download === "qwen3.5:4b" ? "gemma4:12b" : "qwen3.5:4b";
    await expect(list.locator(`.dlrow[data-cat="${idle}"]`).getByRole("button", { name: /^Download \d+\.\d\sGB$/ })).toHaveText(/^\d+\.\d\sGB$/);

    const big = list.locator("details.dl-bigs");
    if (profile.tooBig.length === 0) await expect(big).toHaveCount(0);
    else {
      await expect(big, "the Too big group starts closed").not.toHaveAttribute("open", /.*/);
      await big.locator("summary").click();
      expect((await tags(big.locator(".dlrow[data-cat]"))).toSorted()).toEqual([...profile.tooBig].toSorted());
      for (const row of await big.locator(".dlrow").all()) {
        // what it needs, as the memory mark over the computer's whole (row 28)
        await expect(row.locator(".mm")).toHaveAttribute("aria-label", /^Too big for this computer: (\d\.\d|\d{2,}) of \d+ GB$/);
        await expect(row.getByRole("button")).toHaveCount(0);
      }
    }
    if (profile.runs === "cpu") await expect(list).not.toContainText(/on (?:the |your )?GPU/);
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
  await page.getByTestId("models.tabs.download").click();
  const field = page.getByTestId("models.custom.name");
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

  // decision 26: the name is looked up on Enter (or Download), never while it is typed
  await field.fill("qwen3.5:4b");
  await expect(row.getByRole("button", { name: /^Download \d+\.\d\sGB$/ })).toHaveCount(0);
  await field.press("Enter");
  await expect(row.getByRole("button", { name: /^Download \d+\.\d\sGB$/ })).toBeEnabled();
  await expect(said, "a model that runs on the GPU needs no words").toHaveCount(0);
  await shot("typed-fits.png");

  await field.fill("qwen3.8:27b");
  await expect(said).toHaveCount(0);
  await field.press("Enter");
  await expect(said).toHaveText(/^Too big for this computer · needs \d+\.\d\sGB$/);
  await expect(row.getByRole("button", { name: /^Download \d+\.\d\sGB$/ })).toBeDisabled();
  await row.getByTestId("models.custom.more").click();
  const anyway = page.getByTestId("models.custom.download-anyway");
  await expect(anyway).toBeVisible();
  // the size is said whole in the menu (it was cut to "14.1 G")
  expect(await anyway.locator(".mp-k").evaluate(el => el.scrollWidth <= el.clientWidth), "the menu's size is not cut").toBe(true);
  await shot("typed-too-big.png");
  // Escape closes the row menu, not the Models pop-up
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("models.custom.download-anyway")).toHaveCount(0);
  await expect(row.getByTestId("models.custom.more")).toBeFocused();

  await field.fill("no-such-model:1b");
  await field.press("Enter");
  await expect(said).toHaveText("Not in the Ollama library. Check the name.");
  await expect(row.getByTestId("models.download.start")).toBeDisabled();
  await shot("typed-unknown.png");
});
