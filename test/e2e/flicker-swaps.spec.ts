/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { burst, type Frame } from "./flicker-probe.ts";
import { expect, listButton, navButton, openModels, stack, test, waitComposer, waitReady } from "./fixtures.ts";

test.use({ seed: "design", video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off", comfyUrl: "http://127.0.0.1:1" });

async function section(page: Page, name: string, first = false) {
  const phone = (page.viewportSize()?.width ?? 1440) <= 640;
  // on a desktop width Models is the footer bot's pop-up; Settings' nav lies under it, so Ctrl+, first
  if (!phone && name === "Models") return openModels(page);
  if (first || (!phone && await page.getByRole("dialog", { name: "Models" }).count())) await page.keyboard.press("Control+Comma");
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    await page.getByTestId("settings.shell.back").click();
    await listButton(page, name).click();
  } else await navButton(page, name).click();
}

/** Stable test-only identities survive changes to a row's label and classes. */
async function mark(locator: Locator, key: string) {
  await locator.evaluate((el, id) => { (el as HTMLElement).dataset["flickerBox"] = id; }, key);
}

/** Holds the fit table, its answer and its pushes, until `release` runs. */
async function holdFits(page: Page) {
  const held: Array<() => void> = [];
  let holding = true;
  await page.routeWebSocket(/127\.0\.0\.1:5286/, ws => {
    const server = ws.connectToServer();
    const fits = fitTraffic();
    ws.onMessage(message => {
      fits.sent(JSON.parse(String(message)) as { method?: unknown; id?: unknown });
      server.send(message);
    });
    server.onMessage(message => {
      const response = JSON.parse(String(message)) as { type?: unknown; id?: unknown; channel?: unknown };
      if (fits.is(response) && holding) held.push(() => ws.send(message));
      else ws.send(message);
    });
  });
  return {
    held: () => held.length,
    release: () => { holding = false; for (const deliver of held.splice(0)) deliver(); },
  };
}
/** A Download tab group by the start of its title. */
const dlGroup = (page: Page, title: string) => page.locator(".mp .grp").filter({ has: page.locator(".grp-t", { hasText: new RegExp(`^${title}`) }) });

async function libraryBoxes(page: Page) {
  // Samples and repository imports have their own groups above these lists.
  // Keep box identities attached to manual-source controls after navigation.
  // Index 0 is Files and folders, 1 the databases, whatever order they show in.
  if (await page.locator(".set .grp .src-entry").count() === 0) return;
  await expect(page.locator('[data-db="sample:chinook"]')).toBeVisible();
  const groups = [groupOf(page, "folder"), groupOf(page, "sqlite")];
  for (const [i, group] of groups.entries()) {
    await mark(group, `group-${i}`);
    const head = group.locator(".grp-h");
    if (await head.count()) await mark(head, `head-${i}`);
    await mark(group.locator(":scope > .box"), `body-${i}`);
  }
}

function sizeChange(frames: Frame[], key: string) {
  const visible = frames.filter((f) => f.boxes[key] !== undefined);
  const first = visible[0]?.boxes[key];
  const last = visible.at(-1)?.boxes[key];
  if (!first || !last) throw new Error(`No box samples for ${key}`);
  const delta = (axes: number[]) => Math.max(0, ...visible.flatMap((f) => axes.map((i) => Math.abs((f.boxes[key]?.[i] ?? Infinity) - (first[i] ?? 0)))));
  return { samples: visible.length, missing: frames.length - visible.length, from: first, to: last, sizePx: delta([2, 3]), positionPx: delta([0, 1]) };
}

function stableSize(frames: Frame[], key: string, name: string) {
  const m = sizeChange(frames, key);
  console.log(`STATE_SWAP ${name} ${JSON.stringify(m)}`);
  expect(m.samples, "the frame probe must be live").toBeGreaterThan(10);
  expect(m.missing, "the replacement box must stay mounted").toBe(0);
  expect.soft(m.sizePx, "a state swap must keep its replacement box's size").toBeLessThanOrEqual(0.5);
}

const groupOf = (page: Page, kind: string) => page.locator(".set .grp").filter({ has: page.locator(".grp-t", { hasText: kind === "sqlite" ? "Databases" : "Files and folders" }) });
const nounOf = (kind: string) => kind === "sqlite" ? "database" : kind;

/** The fit table's answer and its pushes, which the routes below hold back. */
function fitTraffic() {
  const asked = new Set<unknown>();
  return {
    sent(request: { method?: unknown; id?: unknown }) { if (request.method === "fit.table") asked.add(request.id); },
    is(message: { type?: unknown; id?: unknown; channel?: unknown }) { return (message.type === "response" && asked.delete(message.id)) || (message.type === "push" && message.channel === "fit.changed"); },
  };
}

for (const width of [1440, 360]) {
  test.describe(`state swaps at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const kind of ["folder", "file", "sqlite"] as const) {
      // Guards the owner's report: the Library card jumped in size on Add database.
      test(`Library Add ${kind} replaces an equal-sized empty state`, async ({ page, open }) => {
        await open();
        await waitReady(page);
        await section(page, "Library", true);
        await libraryBoxes(page);
        const group = groupOf(page, kind);
        await group.scrollIntoViewIfNeeded();
        const noun = nounOf(kind);
        const frames = await burst(page, `r2-${width}/library-empty-${kind}`, ".set", () => group.getByRole("button", { name: `Add ${noun}…`, exact: true }).click());
        stableSize(frames, `body-${kind === "sqlite" ? 1 : 0}`, `library-empty-${kind}-${width}`);
        expect(sizeChange(frames, `head-${kind === "sqlite" ? 1 : 0}`).positionPx, "content above the form stays put").toBeLessThanOrEqual(0.5);
      });
    }

    // Guards the owner's report: GPU memory flickered when a size was picked.
    test("expanded GPU details keep their size when the verdict changes to spill", async ({ page, open }) => {
      // the verdict is against the whole card (owner 2026-11-13), so a 12 GB card: the 9B fits at 16k and spills at 64k
      await stack.gpu(0, 12 * 1024 - 150);
      await open();
      await waitReady(page);
      await page.keyboard.press("Control+Comma");
      if (width <= 640) {
        await page.getByTestId("settings.shell.back").click();
        await page.getByTestId("settings.sections.open-advanced").click();
      } else await page.getByTestId("settings.nav.open-advanced").click();
      const gpu = page.locator("#gpuMemory");
      const verdict = gpu.locator(".fp-v:visible");
      await expect(verdict).toHaveCount(1);
      await expect(verdict).toBeVisible();
      await expect(gpu.locator(".fit-skel")).toHaveCount(0);
      await expect(gpu.locator('[data-ctx="65536"]')).toHaveAttribute("data-tip", /.+/);
      const details = gpu.locator("details.fp-more");
      await details.locator("summary").click();
      await expect(details).toHaveJSProperty("open", true);
      await mark(details, "gpu-details");
      const frames = await burst(page, `r2-${width}/gpu-spill`, "#gpuMemory", () => gpu.locator('[data-ctx="65536"]').click());
      stableSize(frames, "surface", `gpu-spill-${width}`);
      stableSize(frames, "gpu-details", `gpu-details-spill-${width}`);
      await expect(details).toHaveJSProperty("open", true);
      await expect(verdict).toContainText("Should run slower");
    });

    // Guards a shipped bug fix: a late fit table moved the Download rows.
    test("Download groups after a second without a fit table, and a late table moves nothing until the next visit", async ({ page, open }) => {
      const fits = await holdFits(page);
      await open();
      await waitReady(page);
      await section(page, "Models", true);
      await page.getByRole("tab", { name: /Download/ }).click();
      // one of the 16 GB card's recommended picks that is not installed (tiers.ts)
      const tag = "qwen3:14b";
      const row = page.locator(`.dlrow[data-cat="${tag}"]`);
      await expect.poll(fits.held).toBeGreaterThan(0);
      // the top of "Something else", and whether the groups' placeholder is up, read in one frame
      const below = () => page.evaluate(() => {
        const grp = [...document.querySelectorAll(".mp .grp")].find(g => g.querySelector(".grp-t")?.textContent?.startsWith("Something else"));
        return { held: document.querySelector(".mp .grp-skel") !== null, top: grp?.getBoundingClientRect().top };
      });
      let before: { held: boolean; top: number | undefined } = { held: false, top: undefined };
      await expect.poll(async () => { before = await below(); return before.held && before.top !== undefined; }, "read on the placeholder").toBe(true);
      // at the bound a row with no answer is not recommended
      await expect(dlGroup(page, "Also available").locator(`.dlrow[data-cat="${tag}"]`)).toBeVisible();
      const after = await below();
      expect(after.held).toBe(false);
      // within a pixel: sub-pixel line boxes round differently between a placeholder bar and a word
      expect(Math.abs((after.top ?? 0) - (before.top ?? 0)), "Something else stays where the placeholder put it").toBeLessThanOrEqual(1);
      await expect(row).not.toHaveAttribute("data-verdict", /./);
      const box = await row.boundingBox();
      fits.release();
      await expect(row).toHaveAttribute("data-verdict", "fits");
      await expect(dlGroup(page, "Also available").locator(`.dlrow[data-cat="${tag}"]`), "a late table that fits does not move the row").toBeVisible();
      expect(await row.boundingBox(), "the row stays where it is").toEqual(box);
      await page.getByRole("tab", { name: /Installed/ }).click();
      await page.getByRole("tab", { name: /Download/ }).click();
      await expect(dlGroup(page, "Recommended").locator(`.dlrow[data-cat="${tag}"]`), "a new visit groups by the answers in hand").toBeVisible();
    });

    // Guards a shipped bug fix: a download row moved away from where it was clicked.
    test("download progress replaces an equal-sized model row", async ({ page, open }) => {
      // Hold catalog hydration so a probe started before the row exists
      // reliably distinguishes initial loading from a download-state gap.
      const heldCatalog: Array<() => void> = [];
      const heldFits: Array<() => void> = [];
      let holdingCatalog = true;
      let holdingFits = true;
      await page.routeWebSocket(/127\.0\.0\.1:5286/, ws => {
        const server = ws.connectToServer();
        const catalogRequests = new Set<unknown>();
        const fits = fitTraffic();
        ws.onMessage(message => {
          const request = JSON.parse(String(message)) as { method?: unknown; id?: unknown };
          if (request.method === "models.catalog") catalogRequests.add(request.id);
          fits.sent(request);
          server.send(message);
        });
        server.onMessage(message => {
          const response = JSON.parse(String(message)) as { type?: unknown; id?: unknown; channel?: unknown };
          if (response.type === "response" && catalogRequests.delete(response.id) && holdingCatalog) heldCatalog.push(() => ws.send(message));
          else if (fits.is(response) && holdingFits) heldFits.push(() => ws.send(message));
          else ws.send(message);
        });
      });
      await open();
      // the catalog is held, so the first reads have not landed: act on the composer's readiness alone
      await waitComposer(page);
      await section(page, "Models", true);
      await page.getByRole("tab", { name: /Download/ }).click();
      await stack.scenario("models", { pullTickMs: 250, pullChunkBytes: 256 * 1024 * 1024 });
      const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
      await expect.poll(() => heldCatalog.length).toBeGreaterThan(0);
      await expect(row).toHaveCount(0);
      // A bounded hydration delay, deliberately included before measurement.
      setTimeout(() => {
        holdingCatalog = false;
        for (const deliver of heldCatalog.splice(0)) deliver();
      }, 500);
      // Establish the old state before sampling; click() alone waits too late.
      await expect(row).toBeVisible();
      await expect.poll(() => heldFits.length).toBeGreaterThan(0);
      await row.scrollIntoViewIfNeeded();
      const original = await row.elementHandle();
      if (!original) throw new Error("The download row must exist before starting");
      const frames = await burst(page, `r2-${width}/download-start`, '.dlrow[data-cat="qwen3.5:4b"]', async () => {
        await row.getByRole("button", { name: /^Download \d/ }).click();
        await expect(row.getByRole("button", { name: "Cancel download" })).toBeVisible();
        holdingFits = false;
        for (const deliver of heldFits.splice(0)) deliver();
        await expect(row).toHaveAttribute("data-verdict", /.+/);
      });
      stableSize(frames, "surface", `download-start-${width}`);
      expect.soft(sizeChange(frames, "surface").positionPx, "starting and progressing must keep the clicked row in place").toBeLessThanOrEqual(0.5);
      expect.soft(await original.evaluate(node => node === document.querySelector('.dlrow[data-cat="qwen3.5:4b"]')), "a fit table must not remount the download row").toBe(true);
      const cancelled = await burst(page, `r2-${width}/download-cancel`, '.dlrow[data-cat="qwen3.5:4b"]', () => row.getByRole("button", { name: "Cancel download" }).click());
      stableSize(cancelled, "surface", `download-cancel-${width}`);
      expect(sizeChange(cancelled, "surface").positionPx, "cancelling must keep the row in place").toBeLessThanOrEqual(0.5);
      expect(await original.evaluate(node => node === document.querySelector('.dlrow[data-cat="qwen3.5:4b"]')), "cancelling must preserve the row").toBe(true);
      await page.getByRole("tab", { name: /Installed/ }).click();
      await page.getByRole("tab", { name: /Download/ }).click();
      // the 4B runs on a 16 GB card but is not one of its picks (tiers.ts)
      await expect(dlGroup(page, "Also available").locator('.dlrow[data-cat="qwen3.5:4b"]'), "a new visit uses the current fit grouping").toBeVisible();
    });

    // Guards a shipped bug fix: a finished download made the list jump during its fit recheck.
    test("Download finishes in place without briefly offering Download again", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await section(page, "Models", true);
      await page.getByRole("tab", { name: /Download/ }).click();
      await stack.scenario("models", { pullTickMs: 250, pullChunkBytes: 256 * 1024 * 1024 });
      const selector = '.dlrow[data-cat="qwen3.5:4b"]';
      const row = page.locator(selector);
      await expect(row).toBeVisible();
      const count = await page.locator(".dlrow").count();
      await expect(page.locator(".dlrow[data-verdict]")).toHaveCount(count);
      await row.getByRole("button", { name: /^Download \d/ }).click();
      await expect(row.getByRole("button", { name: "Cancel download" })).toBeVisible();
      await row.scrollIntoViewIfNeeded();
      // the button and its × hold the row's action through the download (row 18)
      await mark(row.locator(".dl-a"), "download-verdict");
      const original = await row.elementHandle();
      if (!original) throw new Error("The download row must exist before completion");
      const frames = await burst(page, `r2-${width}/download-complete`, selector, async () => {
        await expect(row.locator(".dl-done")).toHaveText("Installed", { timeout: 15_000 });
        await expect(page.locator(".dlrow[data-verdict]")).toHaveCount(count);
      });
      stableSize(frames, "surface", `download-complete-${width}`);
      const heights = frames.map(frame => frame.boxes["download-verdict"]?.[3]).filter((height): height is number => height !== undefined);
      expect(heights, "every frame must include the verdict block").toHaveLength(frames.length);
      expect.soft(Math.max(...heights) - Math.min(...heights), "a new table must preserve the verdict block height").toBeLessThanOrEqual(0.5);
      expect(frames.filter((f) => f.checking), "an installed model keeps its verdicts while the table is rebuilt").toHaveLength(0);
      expect(sizeChange(frames, "surface").positionPx, "completion must keep the row in place").toBeLessThanOrEqual(0.5);
      expect(await original.evaluate(node => node === document.querySelector('.dlrow[data-cat="qwen3.5:4b"]')), "completion must preserve the row").toBe(true);
      // the idle button's name is "Download" and its size (row 18)
      expect(frames.filter((f) => f.elements.some((e) => e.startsWith("BUTTON:Download"))), "completion must not return to the idle action while the list catches up").toHaveLength(0);
    });
  });
}
