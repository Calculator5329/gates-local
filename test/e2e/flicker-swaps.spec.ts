/// <reference lib="dom" />
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "@playwright/test";
import { decodeRequest } from "@gates-local/contracts";
import { CHECKOUT_CACHE } from "./env.ts";
import { burst, delayedMemory, type Frame, transitionMetrics } from "./flicker-probe.ts";
import { expect, sendMessage, stack, test, waitComposer, waitReady } from "./fixtures.ts";

test.use({ seed: "design", video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off", comfyUrl: "http://127.0.0.1:1" });

async function section(page: Page, name: string, first = false) {
  if (first) await page.keyboard.press("Control+Comma");
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    await page.getByRole("button", { name: "Back to Settings" }).click();
    await page.locator(".set-list").getByRole("button", { name }).click();
  } else await page.locator(".snav").getByRole("button", { name, exact: true }).click();
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

function sources() {
  const folder = path.join(CHECKOUT_CACHE, "size-swap-fixtures");
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "note.txt");
  writeFileSync(file, "A short Library fixture.\n");
  const sqlite = path.join(folder, "size.sqlite");
  const db = new DatabaseSync(sqlite);
  db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT); INSERT OR IGNORE INTO notes VALUES (1, 'fixture');");
  db.close();
  return { folder, file, sqlite };
}

const groupOf = (page: Page, kind: string) => page.locator(".set .grp").filter({ has: page.locator(".grp-t", { hasText: kind === "sqlite" ? "Databases" : "Files and folders" }) });
/** An own database's row has Refresh and Remove by icon; a folder or file's are in its More menu. */
const ownRow = (group: Locator, kind: string, label: string) => group.locator(kind === "sqlite" ? ".db-row" : ".src").filter({ hasText: label });
const boxFor = (page: Page, control: Locator) => page.locator(".set .grp").filter({ has: control }).locator(":scope > .box");
const nounOf = (kind: string) => kind === "sqlite" ? "database" : kind;

/** The fit table's answer and its pushes, which the routes below hold back. */
function fitTraffic() {
  const asked = new Set<unknown>();
  return {
    sent(request: { method?: unknown; id?: unknown }) { if (request.method === "fit.table") asked.add(request.id); },
    is(message: { type?: unknown; id?: unknown; channel?: unknown }) { return (message.type === "response" && asked.delete(message.id)) || (message.type === "push" && message.channel === "fit.changed"); },
  };
}

async function refuseAction(page: Page, method: string) {
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const req = JSON.parse(String(message)) as { method?: unknown; id?: unknown };
      if (req.method === method) setTimeout(() => ws.send(JSON.stringify({ type: "response", id: req.id, ok: false, error: { code: "internal", message: "Fixture action refused." } })), 150);
      else server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
}

/** Keep a real Refreshing push visible like a larger copy; never replace its contents. */
async function libraryTraffic(page: Page) {
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    const delayed = new Set<unknown>();
    let refreshingUntil = 0;
    ws.onMessage((message) => {
      const req = JSON.parse(String(message)) as { method?: unknown; id?: unknown };
      if (typeof req.method === "string" && ["sources.add", "sources.remove", "sources.refresh"].includes(req.method)) delayed.add(req.id);
      server.send(message);
    });
    server.onMessage((message) => {
      const res = JSON.parse(String(message)) as { type?: unknown; id?: unknown; channel?: unknown; payload?: unknown };
      const sourcePush = res.type === "push" && res.channel === "sources.changed";
      const refreshing = sourcePush && Array.isArray(res.payload) && res.payload.some((v: unknown) => typeof v === "object" && v !== null && "state" in v && v.state === "refreshing");
      if (refreshing) refreshingUntil = Date.now() + 150;
      const wait = res.type === "response" && delayed.delete(res.id) ? 150 : sourcePush && !refreshing ? Math.max(0, refreshingUntil - Date.now()) : 0;
      if (wait > 0) setTimeout(() => ws.send(message), wait);
      else ws.send(message);
    });
  });
}

for (const width of [1440, 360]) {
  test.describe(`state swaps at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const kind of ["folder", "file", "sqlite"] as const) {
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

    test("Library Add preserves the size and positions of a populated list", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await section(page, "Library", true);
      const group = groupOf(page, "folder");
      await group.getByRole("button", { name: "Add folder…", exact: true }).click();
      await page.getByRole("textbox", { name: "Add a folder path" }).fill(sources().folder);
      await group.getByRole("button", { name: "Add", exact: true }).click();
      await expect(group.locator(".src")).toHaveCount(1);
      await libraryBoxes(page);
      await group.scrollIntoViewIfNeeded();
      await mark(group.locator(".src"), "existing-source");
      const frames = await burst(page, `r2-${width}/library-populated`, ".set", () => group.getByRole("button", { name: "Add file…", exact: true }).click());
      stableSize(frames, "body-0", `library-populated-${width}`);
      expect(sizeChange(frames, "existing-source").positionPx, "opening an editor must not move existing sources").toBeLessThanOrEqual(0.5);
    });

    test("expanded GPU details keep their size when the verdict changes to spill", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await page.keyboard.press("Control+Comma");
      if (width <= 640) {
        await page.getByRole("button", { name: "Back to Settings" }).click();
        await page.locator(".set-list").getByRole("button", { name: "Advanced" }).click();
      } else await page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).click();
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

    test("Download groups the fit table that lands within a second, on placeholders until then", async ({ page, open }) => {
      // the page's clock stands still from the tab's opening, so "within a second" is the
      // page's second, not the test machine's: the table lands, then the second passes
      const fits = await holdFits(page);
      await page.clock.install();
      await open();
      await waitReady(page);
      await section(page, "Models", true);
      // the clock still runs until it pauses: aim far enough ahead that the pause is not in its past;
      // the Download tab has not opened, so its one-second bound has not started
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
      await page.getByRole("tab", { name: /Download/ }).click();
      const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
      await expect.poll(fits.held).toBeGreaterThan(0);
      // nothing answered yet: no row claims a group
      await expect(page.locator('.mp .grp-skel[aria-busy="true"] > [data-skel]')).toBeVisible();
      await expect(row).toHaveCount(0);
      fits.release();
      const placed = dlGroup(page, "Recommended").locator('.dlrow[data-cat="qwen3.5:4b"]');
      await expect(placed, "an answer inside the bound places the row").toBeVisible();
      await page.clock.runFor(1000);
      await expect(placed, "the bound passing moves nothing").toBeVisible();
      await expect(row.locator(".vl")).toBeVisible();
    });

    test("Download groups after a second without a fit table, and a late table moves nothing until the next visit", async ({ page, open }) => {
      const fits = await holdFits(page);
      await open();
      await waitReady(page);
      await section(page, "Models", true);
      await page.getByRole("tab", { name: /Download/ }).click();
      const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
      await expect.poll(fits.held).toBeGreaterThan(0);
      // the top of "Something else", and whether the groups' placeholder is up, read in one frame
      const below = () => page.evaluate(() => {
        const grp = [...document.querySelectorAll(".mp .grp")].find(g => g.querySelector(".grp-t")?.textContent?.startsWith("Something else"));
        return { held: document.querySelector(".mp .grp-skel") !== null, top: grp?.getBoundingClientRect().top };
      });
      let before: { held: boolean; top: number | undefined } = { held: false, top: undefined };
      await expect.poll(async () => { before = await below(); return before.held && before.top !== undefined; }, "read on the placeholder").toBe(true);
      // at the bound a row with no answer is not recommended
      await expect(dlGroup(page, "Also available").locator('.dlrow[data-cat="qwen3.5:4b"]')).toBeVisible();
      const after = await below();
      expect(after.held).toBe(false);
      test.info().annotations.push({ type: "something-else-top", description: `placeholder ${before.top}, groups ${after.top}` });
      console.log(`something-else-top placeholder=${before.top} groups=${after.top}`);
      // within a pixel: sub-pixel line boxes round differently between a placeholder bar and a word
      expect(Math.abs((after.top ?? 0) - (before.top ?? 0)), "Something else stays where the placeholder put it").toBeLessThanOrEqual(1);
      await expect(row.locator(".vl")).toHaveCount(0);
      const box = await row.boundingBox();
      fits.release();
      await expect(row.locator(".vl")).toBeVisible();
      await expect(dlGroup(page, "Also available").locator('.dlrow[data-cat="qwen3.5:4b"]'), "a late table that fits does not move the row").toBeVisible();
      expect(await row.boundingBox(), "the row stays where it is").toEqual(box);
      await page.getByRole("tab", { name: /Installed/ }).click();
      await page.getByRole("tab", { name: /Download/ }).click();
      await expect(dlGroup(page, "Recommended").locator('.dlrow[data-cat="qwen3.5:4b"]'), "a new visit groups by the answers in hand").toBeVisible();
    });

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
        await row.getByRole("button", { name: "Download", exact: true }).click();
        await expect(row.getByRole("button", { name: "Cancel download" })).toBeVisible();
        holdingFits = false;
        for (const deliver of heldFits.splice(0)) deliver();
        await expect(row.locator(".vl")).toBeVisible();
      });
      stableSize(frames, "surface", `download-start-${width}`);
      expect.soft(sizeChange(frames, "surface").positionPx, "starting and progressing must keep the clicked row in place").toBeLessThanOrEqual(0.5);
      expect.soft(await original.evaluate(node => node === document.querySelector('.dlrow[data-cat="qwen3.5:4b"]')), "a fit table must not remount the download row").toBe(true);
      await page.screenshot({ path: test.info().outputPath("download-progress-in-place.png") });
      const cancelled = await burst(page, `r2-${width}/download-cancel`, '.dlrow[data-cat="qwen3.5:4b"]', () => row.getByRole("button", { name: "Cancel download" }).click());
      stableSize(cancelled, "surface", `download-cancel-${width}`);
      expect(sizeChange(cancelled, "surface").positionPx, "cancelling must keep the row in place").toBeLessThanOrEqual(0.5);
      expect(await original.evaluate(node => node === document.querySelector('.dlrow[data-cat="qwen3.5:4b"]')), "cancelling must preserve the row").toBe(true);
      await page.getByRole("tab", { name: /Installed/ }).click();
      await page.getByRole("tab", { name: /Download/ }).click();
      const recommended = page.locator(".mp .grp").filter({ has: page.locator(".grp-t", { hasText: /^Recommended$/ }) });
      await expect(recommended.locator('.dlrow[data-cat="qwen3.5:4b"]'), "a new visit uses the current fit grouping").toBeVisible();
    });

    test("an Installed download row keeps its size when it becomes ready", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await section(page, "Models", true);
      await page.getByRole("tab", { name: /Download/ }).click();
      await stack.scenario("models", { pullTickMs: 250, pullChunkBytes: 256 * 1024 * 1024 });
      await page.locator('.dlrow[data-cat="qwen3.5:4b"]').getByRole("button", { name: "Download", exact: true }).click();
      await page.getByRole("tab", { name: /Installed/ }).click();
      await expect(page.locator('.mp-row[data-pull="qwen3.5:4b"]')).toBeVisible();
      const selector = '.mp-row[data-pull="qwen3.5:4b"], .mp-row[data-dm="qwen3.5:4b"]';
      const frames = await burst(page, `r2-${width}/installed-download-ready`, selector, () => expect(page.locator('.mp-row[data-dm="qwen3.5:4b"]')).toBeVisible({ timeout: 15_000 }));
      stableSize(frames, "surface", `installed-download-ready-${width}`);
      expect(sizeChange(frames, "surface").positionPx, "a completed row must stay in the place it occupied while downloading").toBeLessThanOrEqual(0.5);
      const ready = page.locator('.mp-row[data-dm="qwen3.5:4b"]');
      await ready.getByRole("button", { name: /^More for / }).click();
      await page.getByRole("menuitem", { name: /^Remove/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
      await expect(page.locator(selector), "removing a completed download must not revive its pending row").toHaveCount(0);
    });

    test("a failed download replaces its detail without growing the row", async ({ page, open }) => {
      await refuseAction(page, "models.pull");
      await open();
      await waitReady(page);
      await section(page, "Models", true);
      await page.getByRole("tab", { name: /Download/ }).click();
      const selector = '.dlrow[data-cat="qwen3.5:4b"]';
      const row = page.locator(selector);
      // The first table groups the rows before the measurement starts.
      await expect(row.locator(".vl")).toBeVisible();
      await row.scrollIntoViewIfNeeded();
      const original = await row.elementHandle();
      if (!original) throw new Error("The download row must exist before failure");
      const frames = await burst(page, `r2-${width}/download-error`, selector, () => row.getByRole("button", { name: "Download", exact: true }).click());
      await expect(row.getByRole("alert")).toBeVisible();
      stableSize(frames, "surface", `download-error-${width}`);
      expect(sizeChange(frames, "surface").positionPx, "failure must keep the row in place").toBeLessThanOrEqual(0.5);
      expect(await original.evaluate(node => node === document.querySelector('.dlrow[data-cat="qwen3.5:4b"]')), "failure must preserve the row").toBe(true);
    });

    test("an older pull refusal cannot replace a newer cancellation error", async ({ page, open }) => {
      let refusePull: (() => void) | undefined;
      await page.routeWebSocket(/127\.0\.0\.1:5286/, ws => {
        const server = ws.connectToServer();
        ws.onMessage(message => {
          const req = JSON.parse(String(message)) as { method?: string; id?: string };
          const refuse = (text: string) => ws.send(JSON.stringify({ type: "response", id: req.id, ok: false, error: { code: "internal", message: text } }));
          if (req.method === "models.pull") refusePull = () => refuse("Older pull refused.");
          else if (req.method === "models.cancelPull") refuse("Newer cancellation refused.");
          else server.send(message);
        });
        server.onMessage(message => ws.send(message));
      });
      await open(); await waitReady(page);
      await section(page, "Models", true);
      await page.getByRole("tab", { name: /Download/ }).click();
      const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
      await expect(row.locator(".vl")).toBeVisible();
      await row.getByRole("button", { name: "Download", exact: true }).click();
      await expect.poll(() => refusePull !== undefined).toBe(true);
      await row.getByRole("button", { name: "Cancel download" }).click();
      await expect(row.getByRole("alert")).toContainText("Newer cancellation refused");
      refusePull!();
      await expect(row.getByRole("button", { name: "Download", exact: true })).toBeVisible();
      await expect(row.getByRole("alert")).toContainText("Newer cancellation refused");
    });

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
      await expect(page.locator(".dlrow .vl")).toHaveCount(count);
      await row.getByRole("button", { name: "Download", exact: true }).click();
      await expect(row.getByRole("button", { name: "Cancel download" })).toBeVisible();
      await row.scrollIntoViewIfNeeded();
      const geometry = () => page.locator(".mp").evaluate(root => {
        const rows = [...root.querySelectorAll<HTMLElement>(".dlrow")].map(node => {
          const rect = node.getBoundingClientRect(), verdict = node.querySelector(".dl-v")?.getBoundingClientRect();
          return { name: node.dataset["cat"], y: rect.y, height: rect.height, verdictY: verdict?.y, verdictHeight: verdict?.height };
        });
        const scroll = [];
        for (let node = root.parentElement; node; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight) scroll.push({ className: node.className, top: node.scrollTop });
        }
        return { rows, scroll };
      });
      const before = await geometry();
      await mark(row.locator(".dl-v"), "download-verdict");
      const original = await row.elementHandle();
      if (!original) throw new Error("The download row must exist before completion");
      const frames = await burst(page, `r2-${width}/download-complete`, selector, async () => {
        await expect(row.locator(".badge")).toHaveText("Installed", { timeout: 15_000 });
        await expect(page.locator(".dlrow .vl")).toHaveCount(count);
        console.log(`INSTALL_GEOMETRY ${width} ${JSON.stringify({ before, installed: await geometry() })}`);
      });
      stableSize(frames, "surface", `download-complete-${width}`);
      const heights = frames.map(frame => frame.boxes["download-verdict"]?.[3]).filter((height): height is number => height !== undefined);
      expect(heights, "every frame must include the verdict block").toHaveLength(frames.length);
      expect.soft(Math.max(...heights) - Math.min(...heights), "a new table must preserve the verdict block height").toBeLessThanOrEqual(0.5);
      expect(frames.filter((f) => f.checking), "an installed model keeps its verdicts while the table is rebuilt").toHaveLength(0);
      expect(sizeChange(frames, "surface").positionPx, "completion must keep the row in place").toBeLessThanOrEqual(0.5);
      expect(await original.evaluate(node => node === document.querySelector('.dlrow[data-cat="qwen3.5:4b"]')), "completion must preserve the row").toBe(true);
      expect(frames.filter((f) => f.elements.includes("BUTTON:Download")), "completion must not return to the idle action while the list catches up").toHaveLength(0);
    });

    test("a custom-name download keeps its row when installed", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await section(page, "Models", true);
      await page.getByRole("tab", { name: /Download/ }).click();
      await stack.scenario("models", { pullTickMs: 250, pullChunkBytes: 64 * 1024 * 1024 });
      await page.getByRole("textbox", { name: "Model name", exact: true }).fill("mid-chat:32k");
      await page.locator(".srow").filter({ has: page.getByRole("textbox", { name: "Model name", exact: true }) }).getByRole("button", { name: "Download", exact: true }).click();
      await page.getByRole("tab", { name: /Installed/ }).click();
      await expect(page.locator('.mp-row[data-pull="mid-chat:32k"]')).toBeVisible();
      const selector = '.mp-row[data-pull="mid-chat:32k"], .mp-row[data-dm="mid-chat:32k"]';
      const frames = await burst(page, `r2-${width}/custom-download-ready`, selector, () => expect(page.locator('.mp-row[data-dm="mid-chat:32k"]')).toBeVisible({ timeout: 15_000 }));
      stableSize(frames, "surface", `custom-download-ready-${width}`);
      expect(sizeChange(frames, "surface").positionPx, "custom names need the same ordering before and after completion").toBeLessThanOrEqual(0.5);
    });

    test("a failed cancellation keeps the Installed progress row size", async ({ page, open }) => {
      await refuseAction(page, "models.cancelPull");
      await open();
      await waitReady(page);
      await section(page, "Models", true);
      await page.getByRole("tab", { name: /Download/ }).click();
      await stack.scenario("models", { pullTickMs: 250, pullChunkBytes: 64 * 1024 * 1024 });
      await page.locator('.dlrow[data-cat="qwen3.5:4b"]').getByRole("button", { name: "Download", exact: true }).click();
      await page.getByRole("tab", { name: /Installed/ }).click();
      const selector = '.mp-row[data-pull="qwen3.5:4b"]';
      const row = page.locator(selector);
      const frames = await burst(page, `r2-${width}/download-cancel-error`, selector, () => row.getByRole("button", { name: "Cancel download" }).click());
      await expect(row.getByRole("alert")).toBeVisible();
      stableSize(frames, "surface", `download-cancel-error-${width}`);
    });

    test("the System theme choice keeps its Appearance box size", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await section(page, "General", true);
      const theme = page.getByRole("group", { name: "Theme", exact: true });
      await mark(boxFor(page, theme), "body-0");
      const frames = await burst(page, `r2-${width}/theme-system`, ".set", () => theme.getByRole("button", { name: "System", exact: true }).click());
      stableSize(frames, "body-0", `theme-system-${width}`);
    });

    test("the Tools switch keeps its control row size", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await section(page, "Tools", true);
      const tools = page.getByRole("switch", { name: "Let the model use tools", exact: true });
      await mark(boxFor(page, tools), "body-0");
      await mark(boxFor(page, page.locator(".srow").filter({ has: page.getByText("Read files", { exact: true }) })), "body-1");
      const frames = await burst(page, `r2-${width}/tools-state`, ".set", () => tools.click());
      stableSize(frames, "body-0", `tools-state-${width}`);
      stableSize(frames, "body-1", `tools-permissions-${width}`);
    });

    test("the Images disclosure keeps its trigger row size", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await section(page, "Image generation", true);
      const images = page.getByRole("switch", { name: "Generate images", exact: true });
      await mark(boxFor(page, images), "body-0");
      const frames = await burst(page, `r2-${width}/images-trigger`, ".set", () => images.click());
      stableSize(frames, "body-0", `images-trigger-${width}`);
    });

    test("testing ComfyUI keeps the button and address field still", async ({ page, open }) => {
      await delayedMemory(page, 150, ["image.status"]);
      await open();
      await waitReady(page);
      await section(page, "Image generation", true);
      await page.getByRole("switch", { name: "Generate images" }).click();
      const button = page.getByRole("button", { name: "Test connection", exact: true });
      const input = page.getByRole("textbox", { name: "ComfyUI address" });
      await expect(button).toBeVisible();
      await expect(page.locator(".set")).toContainText("ComfyUI did not answer");
      await mark(button, "test-button");
      await mark(input, "address-input");
      const frames = await burst(page, `r2-${width}/comfy-test-control`, ".set", () => button.click());
      stableSize(frames, "test-button", `comfy-test-control-${width}`);
      expect(sizeChange(frames, "address-input").positionPx, "testing must not nudge the address field").toBeLessThanOrEqual(0.5);
    });
  });
}

for (const delay of [0, 150, 600]) {
  test(`cold picker shows the table it already has without regrouping at ${delay} ms`, async ({ page, open }) => {
    await delayedMemory(page, delay);
    // A routed socket reports a frame when the server sends it, before the
    // delayed copy reaches the page, so the page itself notes the first table.
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (event: MessageEvent) => {
            const message = JSON.parse(String(event.data)) as { type?: string; ok?: boolean; result?: { reading?: unknown; rows?: unknown } };
            if (message.type === "response" && message.ok === true && message.result?.reading !== undefined && Array.isArray(message.result.rows)) (window as { fitTableSeen?: boolean }).fitTableSeen = true;
          });
        }
      };
    });
    const fitCalls: unknown[] = [];
    page.on("websocket", ws => {
      ws.on("framesent", frame => {
        const request = decodeRequest(frame.payload);
        if (request.ok && request.value.method.startsWith("fit.")) fitCalls.push(request.value.method);
      });
    });
    await open();
    await waitReady(page);
    // The deferred picker has no closed DOM. Observe delivery of the first
    // table before the first opening.
    await expect.poll(() => page.evaluate(() => (window as { fitTableSeen?: boolean }).fitTableSeen === true)).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const before = fitCalls.length;
    let observations: Promise<void> | undefined;
    const frames = await burst(page, `r2-cold-picker-${delay}`, "#picker", async () => {
      await page.locator("#modelBtn").click();
      // Observe opening without postponing the capture or its visibility guard.
      observations = page.evaluate(async () => {
        const start = performance.now(), samples = [];
        for (const at of [0, 150, 600]) {
          while (performance.now() - start < at) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const picker = document.getElementById("picker");
          samples.push({ at: Math.round(performance.now() - start), open: picker !== null, busy: document.getElementById("modelBtn")?.getAttribute("aria-busy") === "true", costs: [...(picker?.querySelectorAll(".pk-cost") ?? [])].map(el => el.textContent), footer: picker?.querySelector(".pk-bottom")?.textContent });
        }
        return samples;
      }).then(samples => console.log(`PICKER_OPEN ${delay} ${JSON.stringify(samples)}`));
      await expect(page.locator("#picker")).toBeVisible();
    });
    await observations;
    console.log(`PICKER_FIT_REQUESTS ${delay} ${JSON.stringify(fitCalls.slice(before))}`);
    const visible = frames.filter((f) => f.boxes["surface"] !== undefined);
    console.log(`STATE_SWAP cold-picker-${delay} ${JSON.stringify(transitionMetrics(visible))}`);
    expect(visible.length, "the cold picker must render enough frames to exercise the guard").toBeGreaterThan(10);
    expect(visible.filter((f) => f.checking), "a table already here must not show skeletons").toHaveLength(0);
    expect(fitCalls.slice(before), "opening the picker asks for no fit").toEqual([]);
    expect(transitionMetrics(visible).overshootPx, "opening must not regroup rows back and forth").toBeLessThanOrEqual(0.5);
  });

  test(`an uncached conversation does not flash an unexplained empty timeline at ${delay} ms`, async ({ page, open, seededThread }) => {
    await delayedMemory(page, delay, ["threads.get"]);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await expect(page.locator(".turn").first()).toBeVisible();
    const frames = await burst(page, `r2-thread-open-${delay}`, ".stage", () => page.locator(".sb-row").filter({ hasText: "Fix the backup cron" }).click());
    // turns, or the turn-shaped placeholder that stands in for them while they are read
    const empty = frames.filter((f) => !Object.keys(f.boxes).some((key) => key.startsWith("turn ") || key === "thread-loading"));
    console.log(`STATE_SWAP thread-open-${delay} ${JSON.stringify({ frames: frames.length, unexplainedEmptyFrames: empty.length })}`);
    expect(empty, "a real thread load needs a visible explanation rather than an empty conversation").toHaveLength(0);
    await expect(page.locator(".hdr")).toContainText("Fix the backup cron");
    await expect(page.locator(".turn").first()).toBeVisible();
  });
}

for (const width of [1440, 360]) {
  test.describe(`state-swap assertions at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("Library mutations preserve refresh, error and cancel geometry and restore focus", async ({ page, open }) => {
      test.info().annotations.push({ type: "budget", description: "Refresh, error and cancellation each need a live frame observation window to prove zero layout shift; source mutations and restored focus are checked in the same journey." });
      await libraryTraffic(page);
      await open();
      await waitReady(page);
      await section(page, "Library", true);
      const measure = async (name: string, selector: string, action: () => Promise<unknown>) => {
        if (["library-refresh", "library-error", "library-cancel"].includes(name)) {
          await libraryBoxes(page);
          return burst(page, `library-${width}/${name}`, selector, action);
        }
        await test.step(name, action);
        return [];
      };
      const files = sources();
      for (const kind of ["folder", "file", "sqlite"] as const) {
        const group = groupOf(page, kind);
        const noun = nounOf(kind);
        await measure(`library-${kind}-open`, ".set", () => group.getByRole("button", { name: `Add ${noun}…`, exact: true }).click());
        await page.getByRole("textbox", { name: `Add a ${noun} path` }).fill(files[kind]);
        await measure(`library-${kind}-submit`, ".set", () => group.getByRole("button", { name: "Add", exact: true }).click());
        const label = path.basename(files[kind]);
        const row = ownRow(group, kind, label);
        await expect(row).toBeVisible();
        if (kind === "sqlite") {
          const refreshed = await measure("library-refresh", ".set", () => row.getByRole("button", { name: `Refresh ${label}` }).click());
          stableSize(refreshed, "body-1", `library-refresh-${width}`);
          await measure(`library-${kind}-remove`, ".set", () => row.getByRole("button", { name: `Remove ${label}` }).click());
          continue;
        }
        await measure(`library-${kind}-menu`, ".set", () => row.getByRole("button", { name: `More for ${label}` }).click());
        await measure(`library-${kind}-remove`, ".set", () => page.getByRole("menuitem", { name: "Remove", exact: true }).click());
      }
      const group = groupOf(page, "folder");
      await group.getByRole("button", { name: "Add folder…", exact: true }).click();
      await page.getByRole("textbox", { name: "Add a folder path" }).fill(path.join(CHECKOUT_CACHE, "missing-size-swap-folder"));
      const failure = await measure("library-error", ".set", () => group.getByRole("button", { name: "Add", exact: true }).click());
      stableSize(failure, "body-0", `library-error-${width}`);
      const cancel = await measure("library-cancel", ".set", () => page.getByRole("textbox", { name: "Add a folder path" }).press("Escape"));
      stableSize(cancel, "body-0", `library-cancel-${width}`);
      await expect(group.getByRole("button", { name: "Add folder…", exact: true })).toBeFocused();

    });
    test("queued editing and cancellation keep the row size and removal clears the queue", async ({ page, open }) => {
      await open();
      await waitReady(page);
      const measure = (name: string, selector: string, action: () => Promise<unknown>) => burst(page, `queue-${width}/${name}`, selector, action);
      await stack.scenario("slow-drip", { holdAfterTokens: 46 });
      await sendMessage(page, "How do I check disk space before a download?");
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await sendMessage(page, "A queued edit");
      await expect(page.locator(".qt-r")).toHaveCount(1);
      const editing = await measure("queued-edit", ".qt-r", () => page.locator("[data-edit-queued]").click());
      stableSize(editing, "surface", `queued-edit-${width}`);
      const cancelled = await measure("queued-edit-cancel", ".qt-r", () => page.getByRole("button", { name: "Cancel editing" }).click());
      stableSize(cancelled, "surface", `queued-edit-cancel-${width}`);
      await measure("queued-remove", ".stage", () => page.locator("[data-unqueue]").click());
      // Stop/Retry presentation is owned by the streaming lane; this only
      // ends the fake reply after observing the queue editor.
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(page.locator(".qt-r")).toHaveCount(0);
    });
  });
}

for (const width of [1440, 360]) {
  test.describe(`state-swap survey at ${width}`, () => {
    test.skip(!process.env["GL_FLICKER_MEASURE"], "set GL_FLICKER_MEASURE=1 for diagnostic recordings");
    test.use({ viewport: { width, height: 900 } });
    test("audit disclosures, editors, errors and Library mutations", async ({ page, open, seededThread }) => {
      test.setTimeout(180_000);
      await libraryTraffic(page);
      await open(`#thread=${seededThread ?? ""}`);
      await waitReady(page);
      const measure = async (name: string, selector: string, action: () => Promise<unknown>) => {
        if (await page.locator(".set .grp").count()) await libraryBoxes(page);
        if (await page.locator(".composer").count()) await mark(page.locator(".composer"), "composer");
        const frames = await burst(page, `r2-${width}/audit-${name}`, selector, action);
        console.log(`STATE_SWAP_AUDIT ${width} ${name} ${JSON.stringify(transitionMetrics(frames))}`);
        expect(frames.length).toBeGreaterThan(10);
        return frames;
      };
      const rename = async () => {
        if (width <= 640) {
          await page.getByRole("button", { name: "Open threads" }).click();
          const row = page.locator(".sb-row").filter({ hasText: "Library: Effect Schema books" });
          await row.hover();
          await row.locator(".sb-menu").click();
        } else await page.locator(".sb-row").filter({ hasText: "Library: Effect Schema books" }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      };
      await rename();
      await expect(page.getByRole("textbox", { name: "Thread title" })).toBeVisible();
      await measure("rename-cancel", ".hdr", () => page.getByRole("textbox", { name: "Thread title" }).press("Escape"));
      await measure("rename-open", ".hdr", rename);
      await page.getByRole("textbox", { name: "Thread title" }).press("Escape");
      const sentEdit = page.locator(".turn.u").first().getByRole("button", { name: "Edit", exact: true });
      await sentEdit.scrollIntoViewIfNeeded();
      await measure("sent-edit", ".stage", () => sentEdit.click());
      await measure("composer-grow", ".composer", () => page.locator("#ta").fill("One line\nTwo lines\nThree lines\nFour lines"));
      await page.locator("#ta").fill("");
      await measure("attachment-menu", ".stage", () => page.locator("#plusBtn").click());
      await page.keyboard.press("Escape");
      await section(page, "Library", true);
      const files = sources();
      for (const kind of ["folder", "file", "sqlite"] as const) {
        const group = groupOf(page, kind);
        const noun = nounOf(kind);
        await measure(`library-${kind}-open`, ".set", () => group.getByRole("button", { name: `Add ${noun}…`, exact: true }).click());
        await page.getByRole("textbox", { name: `Add a ${noun} path` }).fill(files[kind]);
        await measure(`library-${kind}-submit`, ".set", () => group.getByRole("button", { name: "Add", exact: true }).click());
        const label = path.basename(files[kind]);
        const row = ownRow(group, kind, label);
        await expect(row).toBeVisible();
        if (kind === "sqlite") {
          const refreshed = await measure("library-refresh", ".set", () => row.getByRole("button", { name: `Refresh ${label}` }).click());
          stableSize(refreshed, "body-1", `library-refresh-${width}`);
          await measure(`library-${kind}-remove`, ".set", () => row.getByRole("button", { name: `Remove ${label}` }).click());
          continue;
        }
        await measure(`library-${kind}-menu`, ".set", () => row.getByRole("button", { name: `More for ${label}` }).click());
        await measure(`library-${kind}-remove`, ".set", () => page.getByRole("menuitem", { name: "Remove", exact: true }).click());
      }
      const group = groupOf(page, "folder");
      await group.getByRole("button", { name: "Add folder…", exact: true }).click();
      await page.getByRole("textbox", { name: "Add a folder path" }).fill(path.join(CHECKOUT_CACHE, "missing-size-swap-folder"));
      const failure = await measure("library-error", ".set", () => group.getByRole("button", { name: "Add", exact: true }).click());
      stableSize(failure, "body-0", `library-error-${width}`);
      const cancel = await measure("library-cancel", ".set", () => page.getByRole("textbox", { name: "Add a folder path" }).press("Escape"));
      stableSize(cancel, "body-0", `library-cancel-${width}`);
      await expect(group.getByRole("button", { name: "Add folder…", exact: true })).toBeFocused();
      await section(page, "General");
      for (const name of ["Light", "System", "Dark"]) await measure(`theme-${name}`, ".set", () => page.getByRole("group", { name: "Theme" }).getByRole("button", { name, exact: true }).click());
      for (const name of ["Large", "Default"]) await measure(`text-${name}`, ".set", () => page.getByRole("group", { name: "Text size" }).getByRole("button", { name, exact: true }).click());
      await section(page, "Tools");
      await measure("tools-off", ".set", () => page.getByRole("switch", { name: "Let the model use tools" }).click());
      await measure("tools-on", ".set", () => page.getByRole("switch", { name: "Let the model use tools" }).click());
      await section(page, "Image generation");
      await measure("images-connect", ".set", () => page.getByRole("switch", { name: "Generate images" }).click());
      await measure("comfy-test", ".set", () => page.getByRole("button", { name: "Test", exact: true }).click());
      await section(page, "Runtime");
      const change = page.getByRole("button", { name: /Use .*Ollama…/ });
      if (await change.count()) {
        await measure("runtime-disclose", ".set", () => change.click());
        await measure("runtime-cancel", ".set", () => page.getByRole("button", { name: "Cancel", exact: true }).click());
      }
      await section(page, "Models");
      const row = page.locator('.mp-row[data-dm="gemma4:12b"]');
      await measure("models-menu", ".set", () => row.getByRole("button", { name: /^More for / }).click());
      await measure("models-default", ".set", () => page.getByRole("menuitem", { name: "Use as default" }).click());
      await row.getByRole("button", { name: /^More for / }).click();
      await measure("models-remove-dialog", ".set", () => page.getByRole("menuitem", { name: /Remove/ }).click());
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.keyboard.press("Escape");
      await stack.scenario("slow-drip", { holdAfterTokens: 46 });
      await sendMessage(page, "How do I check disk space before a download?");
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await sendMessage(page, "A queued edit");
      await expect(page.locator(".qt-r")).toHaveCount(1);
      const editing = await measure("queued-edit", ".qt-r", () => page.locator("[data-edit-queued]").click());
      stableSize(editing, "surface", `queued-edit-${width}`);
      const cancelled = await measure("queued-edit-cancel", ".qt-r", () => page.getByRole("button", { name: "Cancel editing" }).click());
      stableSize(cancelled, "surface", `queued-edit-cancel-${width}`);
      await measure("queued-remove", ".stage", () => page.locator("[data-unqueue]").click());
      // Stop/Retry presentation is owned by the streaming lane; this only
      // ends the fake reply after observing the queue editor.
      await page.getByRole("button", { name: "Stop", exact: true }).click();
    });
  });
}

for (const width of [1440, 360]) {
  test.describe(`notice audit at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("record a refused-send notice without a real service failure", async ({ page, open, seededThread }) => {
      await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
          const req = JSON.parse(String(message)) as { method?: unknown; id?: unknown };
          if (req.method === "chat.send") {
            ws.send(JSON.stringify({ type: "response", id: req.id, ok: false, error: { code: "internal", message: "Fixture could not send this message." } }));
          } else server.send(message);
        });
        server.onMessage((message) => ws.send(message));
      });
      await open(`#thread=${seededThread ?? ""}`);
      await waitReady(page);
      await mark(page.locator(".composer"), "composer");
      const frames = await burst(page, `r2-${width}/audit-notice`, ".stage", () => sendMessage(page, "Notice fixture"));
      console.log(`STATE_SWAP_AUDIT ${width} notice ${JSON.stringify(transitionMetrics(frames))}`);
      await expect(page.locator(".c-note")).toBeVisible();
      const composer = sizeChange(frames, "composer");
      console.log(`STATE_SWAP notice-composer-${width} ${JSON.stringify(composer)}`);
      expect(composer.positionPx, "a notice must not nudge the message box").toBeLessThanOrEqual(0.5);
      const notice = await page.locator(".c-note").boundingBox();
      const reply = await page.locator(".tl .turn").last().boundingBox();
      if (!notice || !reply) throw new Error("The notice and last reply must be visible for the overlap probe");
      const overlap = Math.max(0, reply.y + reply.height - notice.y);
      console.log(`STATE_SWAP notice-overlap-${width} ${JSON.stringify({ overlapPx: overlap, notice, reply })}`);
      expect(overlap, "a steady notice must also leave the reply and its actions uncovered").toBeLessThanOrEqual(0.5);
    });
  });
}
