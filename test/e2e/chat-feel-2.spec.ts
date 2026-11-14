/// <reference lib="dom" />
// Journeys from Ethan's second pass: a long model name never pushes the
// composer's controls out, an 8k context, a toolbar that holds still while a
// model loads, and the thread menu on right-click.
import type { Locator, Page } from "@playwright/test";
import { decodePayload, decodeRequest, decodeResult, decodeServerMessage } from "@gates-local/contracts";
import { LONG_NAME } from "../fake-ollama/models.ts";
import { FAKE_URL } from "./env.ts";
import { expect, openModels, sendMessage, stack, test, waitReady } from "./fixtures.ts";

interface Box {
  readonly l: number;
  readonly r: number;
  readonly t: number;
  readonly b: number;
}

/** The composer's box, the footer row's overflow and every footer control's box. */
async function footer(page: Page) {
  return page.evaluate(() => {
    // page coordinates (scroll is 0 in these tests); the closure keeps it in the page function
    const sx = window.scrollX;
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { l: r.left + sx, r: r.right + sx, t: r.top, b: r.bottom };
    };
    const comp = document.querySelector(".composer");
    const cf = document.querySelector(".composer .cf");
    if (!comp || !cf) throw new Error("no composer");
    // only what is on screen: each width hides the controls that belong to the other layout
    const controls = [...cf.querySelectorAll(".cf-l > *, .cf-r > *")].filter((el) => el.getClientRects().length > 0).map((el) => ({ id: el.id || el.getAttribute("aria-label") || el.className, ...box(el) }));
    const send = document.querySelector(".composer .send");
    return { comp: box(comp), overflow: cf.scrollWidth - cf.clientWidth, height: cf.getBoundingClientRect().height, controls, send: send ? box(send) : null };
  });
}

test.describe("long model name", () => {
  test.use({ scenario: "long-name" });
  for (const width of [1440, 412]) longName(width);
});

function longName(width: number): void {
  // Guards the owner's report: a long model name pushed the composer's controls out.
  test(`a long model name truncates in the composer at ${width} px; nothing leaves the composer and Send stays put`, async ({ page, open }) => {
    await page.setViewportSize({ width, height: 900 });
    await open();
    await waitReady(page);
    // At phone width the sidebar is a drawer (the mobile layout, lane/mobile). Until that
    // layout is on this branch the sidebar still takes 256 px in flow and leaves a 108 px
    // composer; stand in for the drawer only while that is so, so this retires itself.
    if (width < 1024 && (await page.locator(".sb").evaluate((el) => getComputedStyle(el).position !== "fixed"))) {
      await page.addStyleTag({ content: ".sb{display:none}" });
    }
    const before = await footer(page);

    await page.locator("#modelBtn").click();
    await page.locator("#pkSearch").fill("heretic");
    const row = page.locator(`#picker .pk-r[data-m="${LONG_NAME}"]`);
    await expect(row).toBeVisible();
    // the picker row keeps the long name inside the picker
    const fits = await row.evaluate((el) => {
      const p = el.closest("#picker")?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const kids = [...el.querySelectorAll("*")].map((k) => k.getBoundingClientRect());
      return { rowOverflow: el.scrollWidth - el.clientWidth, inside: p !== undefined && r.right <= p.right + 0.5 && kids.every((k) => k.right <= r.right + 0.5) };
    });
    expect(fits).toEqual({ rowOverflow: 0, inside: true });
    await row.click();
    if (width < 700) await page.locator('#picker [data-ctx="16384"]').click();
    await expect(page.locator("#picker")).toBeHidden();

    const btn = page.locator("#modelBtn");
    await expect(btn).toHaveAttribute("data-tip", new RegExp(LONG_NAME));
    // the whole tag once: a tag the catalog does not know is its own name
    expect((await btn.getAttribute("data-tip"))?.split(LONG_NAME).length, "the tag appears once in the tooltip").toBe(2);
    const label = await btn.locator(":scope > span:not(.maker-mark)").evaluate((el) => ({ clipped: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow }));
    expect.soft(label).toEqual({ clipped: true, ellipsis: "ellipsis" });

    const after = await footer(page);
    expect(after.overflow).toBe(0);
    expect(after.height).toBe(before.height);
    for (const c of after.controls) {
      expect(c.l, `${c.id} left`).toBeGreaterThanOrEqual(after.comp.l);
      expect(c.r, `${c.id} right`).toBeLessThanOrEqual(after.comp.r);
      // one row: every control sits inside the footer's single line
      expect(c.t, `${c.id} top`).toBeGreaterThanOrEqual((after.send?.t ?? 0) - 4);
      expect(c.b, `${c.id} bottom`).toBeLessThanOrEqual((after.send?.b ?? 0) + 4);
    }
    expect(after.send).toEqual(before.send);
  });
}

interface Frame {
  /** The control's name, its visible state, and where it sits. */
  readonly k: string;
  readonly s: string;
  readonly l: number;
  readonly w: number;
}

/** Records every footer control on every animation frame until glToolbarStop is set. */
async function sampleToolbar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { glToolbar: Frame[][]; glToolbarStop?: boolean };
    w.glToolbar = [];
    const tick = () => {
      if (w.glToolbarStop) return;
      const cf = document.querySelector(".composer .cf");
      if (cf) {
        w.glToolbar.push(
          [...cf.querySelectorAll(".cf-l > *, .cf-r > *")].map((el) => {
            const r = el.getBoundingClientRect();
            const b = el as HTMLButtonElement;
            // the model tile turning into a spinner and back is the load itself, a real change in a fixed-size tile;
            // so is the context slot showing the load's seconds and back (chat row 16), and its box is still checked
            const text = [...el.childNodes].map((n) => (n instanceof Element && (n.classList.contains("mmark") || n.classList.contains("picker-trigger-ctx")) ? "" : n.textContent)).join("");
            const s = `${text}|pressed=${el.getAttribute("aria-pressed")}|aria-disabled=${el.getAttribute("aria-disabled")}|disabled=${b.disabled}|unavail=${el.classList.contains("unavail")}`;
            return { k: el.getAttribute("aria-label") ?? el.id, s, l: Math.round(r.left * 2) / 2, w: Math.round(r.width * 2) / 2 };
          }),
        );
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Consecutive distinct values, in order. */
function runs(values: readonly string[]): string[] {
  return values.filter((v, i) => i === 0 || v !== values[i - 1]);
}

// Guards the owner's report: the toolbar flickered while a model loaded.
test("the composer toolbar holds still while a picked model loads slowly", async ({ page, open }) => {
  test.info().annotations.push({ type: "budget", description: "Two cold three-second model loads establish the starting allocation and exercise loading, followed by the post-load GPU reading and its rendered fit answer." });
  // gemma4:12b takes 3 s to load and fills the GPU a step at a time, as a real load does
  await stack.scenario("models", { loadDelayMs: 3000 });
  let loaded = false, reading = 0, tables = 0;
  const pending = new Set<string>();
  page.on("websocket", ws => {
    ws.on("framesent", frame => {
      const request = decodeRequest(frame.payload);
      if (request.ok) pending.add(request.value.id);
    });
    ws.on("framereceived", frame => {
      const decoded = decodeServerMessage(frame.payload);
      if (!decoded.ok) return;
      const message = decoded.value;
      if (message.type === "push") {
        const load = message.channel === "models.load" ? decodeResult("models.load", message.payload) : undefined;
        if (load?.ok && load.value.model === "gemma4:12b" && load.value.state === "ready") loaded = true;
        if (message.channel === "gpu.changed" && loaded && decodePayload(message.channel, message.payload).ok) reading++;
        if (message.channel === "fit.changed" && loaded && decodePayload(message.channel, message.payload).ok) tables++;
      } else pending.delete(message.id);
    });
  });
  await open();
  await waitReady(page);
  await expect(page.locator("#modelBtn")).toContainText("Qwen");
  // A recommended model is selected, but is not preloaded until it is picked.
  await page.locator("#modelBtn").click();
  await page.locator('#picker .pk-r[data-m="qwen3.5:9b"]').click();
  await expect(page.locator("#picker")).toBeHidden();
  await page.locator("#ta").fill("Hello");
  await expect.poll(async () => ((await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { loaded: { name: string }[] }).loaded.map(model => model.name)).toContain("qwen3.5:9b");


  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill("gemma");
  await sampleToolbar(page);
  await page.locator(`#picker .pk-r[data-m="gemma4:12b"]`).click();
  await expect(page.locator("#picker")).toBeHidden();
  await expect
    .poll(async () => ((await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { loaded: { name: string }[] }).loaded.map((l) => l.name), { timeout: 10_000 })
    .toContain("gemma4:12b");
  // Loading frames cannot satisfy this: require a fit table pushed after the
  // load, no request outstanding, and the resulting render.
  await expect.poll(async () => {
    if (tables === 0 || pending.size > 0) return false;
    const seen = tables;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    return tables === seen && pending.size === 0;
  }, { timeout: 10_000 }).toBe(true);
  console.log(`TOOLBAR_SETTLED ${JSON.stringify({ postLoadGpuReadings: reading, postLoadTables: tables, pending: pending.size })}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { glToolbar: Frame[][] }).glToolbar.filter(frame => frame.find(control => control.k === "modelBtn")?.s.includes("Gemma")).length)).toBeGreaterThan(60);
  const frames = await page.evaluate(() => {
    const w = window as unknown as { glToolbar: Frame[][]; glToolbarStop?: boolean };
    w.glToolbarStop = true;
    return w.glToolbar;
  });

  const from = frames.findIndex((f) => f.find((c) => c.k === "modelBtn")?.s.includes("Gemma"));
  expect(from, "the trigger shows the picked model").toBeGreaterThanOrEqual(0);
  const after = frames.slice(from);
  expect(after.length, "frames sampled").toBeGreaterThan(60);
  const keys = after[0]?.map((c) => c.k) ?? [];
  // no control comes and goes
  expect(runs(after.map((f) => f.map((c) => c.k).join(", "))), "controls present").toEqual([keys.join(", ")]);
  for (const key of keys) {
    const mine = after.map((f) => f.find((c) => c.k === key));
    // each control changes only on a real change: no value comes back after another
    const states = runs(mine.map((c) => c?.s ?? "-"));
    expect.soft(states.length === new Set(states).size, `${key} went back to an earlier value: ${states.join("  →  ")}`).toBe(true);
    // and nothing moves or changes width once the picked name is up
    const boxes = runs(mine.map((c) => (c ? `left ${c.l} width ${c.w}` : "-")));
    expect.soft(boxes, `${key} moved`).toEqual([boxes[0]]);
  }
});

// Guards the owner's ask: an 8k context option.
test("the picker offers 8k; an 8k turn sends num_ctx 8192", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.locator("#modelBtn").click();
  const ctx = page.locator("#picker").getByRole("radiogroup", { name: "Context length" });
  await expect(ctx.getByRole("radio").locator(":scope > span:first-child")).toHaveText(["8k", "16k", "32k", "64k"]);
  // the default stays 16k
  await expect(ctx.locator('[data-ctx="16384"]')).toHaveAttribute("aria-checked", "true");
  await ctx.locator('[data-ctx="8192"]').click();
  await expect(page.locator("#picker")).toBeHidden();
  await page.locator("#modelBtn").click();
  await expect(ctx.locator('[data-ctx="8192"]')).toHaveAttribute("aria-checked", "true");
  await expect(ctx.locator('[data-ctx="8192"] .pk-cost.gpu')).toHaveCount(1);
  await page.keyboard.press("Escape");

  await sendMessage(page, "A small context");
  await expect(page.locator(".turn.a").last()).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string; body: { options?: { num_ctx?: number } } }[] };
  expect(state.requests.findLast((r) => r.path === "/api/chat")?.body.options?.num_ctx).toBe(8192);
});

// Guards the owner's ask: the memory and context control lives in Advanced, once.
test("Settings > Advanced has one default-context control with 8k on it, and Settings > Models has none", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await openModels(page);
  await expect(page.locator(".mp-row").first()).toBeVisible();
  await expect(page.locator(".set [data-ctx]")).toHaveCount(0);
  await expect(page.locator(".set").getByRole("group", { name: /context/i })).toHaveCount(0);
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-advanced").click();
  // one control: the row inside GPU memory, nothing else on the page sets the default
  const seg = page.locator("#gpuMemory").getByRole("group", { name: "Default context" });
  await expect(seg.getByRole("button")).toHaveText(["8k", "16k", "32k", "64k"]);
  await expect(page.locator(".set").getByRole("group", { name: /context/i })).toHaveCount(1);
  await seg.getByRole("button", { name: "8k" }).click();
  await expect(seg.getByRole("button", { name: "8k" })).toHaveAttribute("aria-pressed", "true");
  // the saved default survives a reload
  await page.reload();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-advanced").click();
  await expect(page.locator("#gpuMemory").getByRole("group", { name: "Default context" }).getByRole("button", { name: "8k" })).toHaveAttribute("aria-pressed", "true");
});

const row = (page: Page, title: string) => page.locator(".sb-row", { hasText: title });

/** Waits out a popover's open animation (it rises 4 px) before its box is measured. */
async function settled(el: Locator): Promise<void> {
  await el.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
}

test.describe("thread menu", () => {
  test.use({ seed: "design" });
  const MENU = ["Rename", "Export as Markdown", "Delete thread"];

  // Guards the owner's ask: right-click a thread for its menu.
  test("right-click a sidebar thread: its actions at the pointer; Rename renames that thread", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const menu = page.locator("#threadMenu");
    const target = row(page, "Fix the backup cron");
    const box = await target.boundingBox();
    if (!box) throw new Error("no row");
    const at = { x: box.x + 40, y: box.y + box.height / 2 };
    await page.mouse.click(at.x, at.y, { button: "right" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText(MENU);
    await settled(menu);
    const mb = await menu.boundingBox();
    expect(Math.abs((mb?.x ?? 0) - at.x), "menu at the pointer (x)").toBeLessThan(2);
    expect(Math.abs((mb?.y ?? 0) - at.y), "menu at the pointer (y)").toBeLessThan(2);
    // the thread under the pointer is not opened by the right-click, and its row is marked while the menu is open
    await expect(page.locator(".hdr h2")).toHaveText("Library: Effect Schema books");
    await expect(target.locator(".sb-menu")).toHaveAttribute("aria-expanded", "true");

    await page.getByTestId("sidebar.thread-menu.rename").click();
    const input = page.getByTestId("chat.header.title");
    await expect(input).toHaveValue("Fix the backup cron");
    await input.fill("Fix the nightly backup");
    await input.press("Enter");
    await expect(row(page, "Fix the nightly backup")).toBeVisible();
    await expect(row(page, "Fix the nightly backup").locator(".sb-menu")).toHaveAttribute("aria-expanded", "false");
    await expect(row(page, "Library: Effect Schema books")).toBeVisible();
    // the server has it
    await page.reload();
    await waitReady(page);
    await expect(row(page, "Fix the nightly backup")).toBeVisible();
  });
});
