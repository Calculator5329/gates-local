/// <reference lib="dom" />
// The model picker's layout: it opens whole and holds its columns, the context
// column sets the size a turn runs at (8k to 64k, and Settings has none), rows
// open no tooltip, a long model name stays inside the composer, and the model
// button keeps one width.
import type { Page } from "@playwright/test";
import { LONG_NAME } from "../fake-ollama/models.ts";
import { FAKE_URL } from "./env.ts";
import { expect, modelRow, openModels, sendMessage, test, waitReady } from "./fixtures.ts";
import { holds } from "./waits.ts";

test.use({ viewport: { width: 1137, height: 749 } });

// Guards the owner's ruling that the picker is whole when it opens: skeletons fill in place and nothing moves.
test("the picker opens before the first table with skeletons, and the table fills them in place", async ({ page, open }) => {
  let holding = true;
  const held: (() => void)[] = [];
  await page.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer(), requests = new Set<unknown>();
    ws.onMessage(message => {
      const frame = JSON.parse(String(message)) as { id?: unknown; method?: string };
      if (frame.method === "fit.table") requests.add(frame.id);
      server.send(message);
    });
    server.onMessage(message => {
      const frame = JSON.parse(String(message)) as { id?: unknown; type?: string; channel?: string };
      const table = (frame.type === "response" && requests.delete(frame.id)) || (frame.type === "push" && frame.channel === "fit.changed");
      if (table && holding) held.push(() => ws.send(message));
      else ws.send(message);
    });
  });
  await open(); await waitReady(page);
  try {
    await page.locator("#modelBtn").click();
    const picker = page.locator("#picker"), search = page.locator("#pkSearch");
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(picker).toBeVisible();
    await expect(search).toBeFocused();
    await expect(picker.locator(".pk-cost .fit-skel").first()).toBeVisible();
    const before = await picker.boundingBox();
    holding = false;
    for (const release of held.splice(0)) release();
    await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
    const bounds = await picker.boundingBox();
    expect(bounds, "the table fills the skeletons without moving the picker").toEqual(before);
    await search.fill("qwen");
    await search.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("8k");
    await page.locator("#modelBtn").click();
    expect(await picker.boundingBox()).toEqual(bounds);
  } finally {
    holding = false;
    for (const release of held.splice(0)) release();
  }
});

// Guards the owner's rule that nothing moves, on the picker he reworked: its columns hold through hover and filtering.
test("approved picker keeps its columns fixed through hover, filtering and empty results", async ({ page, open }) => {
  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  await expect(picker.locator(".pk-context")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelBtn")).toBeFocused();
  await page.locator("#modelBtn").click();
  await expect(picker.locator(".pk-context")).toBeVisible();
  const box = await picker.boundingBox();
  await expect(picker.locator(".pk-cost.gpu").first()).toBeVisible();
  await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
  await picker.locator('[data-m="gemma4:12b"]').hover();
  await expect(picker.getByRole("radiogroup")).toHaveAccessibleName("Context length for Gemma 4 12B");
  expect(await picker.boundingBox()).toEqual(box);
  await picker.locator("#pkSearch").fill("no matching local model");
  await expect(picker.getByRole("option")).toHaveCount(0);
  expect(await picker.boundingBox()).toEqual(box);
  await picker.locator("#pkSearch").fill("qwen 3.5");
  await picker.locator("#pkSearch").press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("8k");
  await expect(page.locator("#ta")).toBeFocused();
});

// Guards the owner's ask that models download from Models (unsure: he may not need it to start from the picker).
test("Download models shows the models to download and can start a pull", async ({ page, open }) => {
  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  await page.getByTestId("models.picker.download-models").click();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(page.locator(".mp-row[data-cat]").first(), "the page opens scrolled to the models on offer").toBeInViewport();
  const row = modelRow(page, "qwen3.5:4b");
  await row.getByTestId("models.offered.download").click();
  await expect(row).toHaveAttribute("data-dm", "qwen3.5:4b", { timeout: 20_000 });
});

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

async function openPicker(page: Page) {
  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".pk-v").filter({ hasText: "Checking" })).toHaveCount(0);
  return picker;
}

test.describe("at the usual window size", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.describe("the context column", () => {
    // no image engine answers here
    test.use({ comfyUrl: "http://127.0.0.1:9" });

    // Guards the owner's ask: the context size is picked inside the model picker.
    test("the picker's context column changes the context size shown in the model trigger", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await expect(page.locator("#fitBtn")).toHaveCount(0);
      await expect(page.locator(".composer")).not.toContainText("on GPU");

      await page.locator("#modelBtn").click();
      const picker = page.locator("#picker");
      const ctx = picker.getByRole("radiogroup", { name: "Context length" });
      await expect(ctx).toBeVisible();
      await expect(ctx.locator('[data-ctx="16384"]')).toHaveAttribute("aria-checked", "true");
      await expect(ctx.locator('[data-ctx="16384"] .pk-cost.gpu')).toHaveCount(1);
      // the fit is on the row's face and in its name; the row opens no tooltip
      await expect(ctx.locator('[data-ctx="16384"] .pk-cost.gpu')).toHaveAccessibleName(/; Fits$/);
      await ctx.locator('[data-ctx="32768"]').click();
      await expect(picker).toBeHidden();
      await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("32k");
      await page.locator("#modelBtn").click();
      await expect(ctx.locator('[data-ctx="32768"]')).toHaveAttribute("aria-checked", "true");
      await expect(ctx.locator('[data-ctx="16384"]')).toHaveAttribute("aria-checked", "false");
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();

      await sendMessage(page, "Use the bigger context");
      await expect(page.locator(".turn.a").last()).toHaveClass(/\bdone\b/, { timeout: 15_000 });
      const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string; body: { options?: { num_ctx?: number } } }[] };
      expect(state.requests.findLast((r) => r.path === "/api/chat")?.body.options?.num_ctx).toBe(32768);
    });
  });

  test.describe("long model name", () => {
    test.use({ scenario: "long-name" });
    for (const width of [1440, 412]) longName(width);
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

  // Decision 13: context is set per model in the picker; Settings has no context control.
  test("Settings has no context control, and a size picked in the picker survives a reload", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await openModels(page);
    await expect(page.locator(".mp-row").first()).toBeVisible();
    await expect(page.locator(".set [data-ctx]")).toHaveCount(0);
    await expect(page.locator(".set").getByRole("group", { name: /context/i })).toHaveCount(0);
    await page.keyboard.press("Control+Comma");
    await page.getByTestId("settings.nav.open-advanced").click();
    await expect(page.locator(".set [data-ctx]")).toHaveCount(0);
    await expect(page.locator(".set").getByText("Default context")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.locator("#modelBtn").click();
    await page.locator('#picker [data-ctx="8192"]').click();
    await expect(page.locator("#modelBtn")).toContainText("8k");
    // the size chosen there is the one the next start begins at
    await page.reload();
    await waitReady(page);
    await expect(page.locator("#modelBtn")).toContainText("8k");
  });

  test.describe("rows and the context header", () => {
    // Guards the owner's ruling (N04): picker rows open no tooltip; their facts stay on the face.
    test("a model row and a context row open no tooltip; a row still names its model, size and fit for screen readers", async ({ page, open }) => {
      await open(); await waitReady(page);
      const picker = await openPicker(page);
      const row = picker.locator('.pk-r[data-m="gemma4:12b"]');
      await row.locator(".pk-n").hover();
      await holds(page, 700, () => page.locator("#tip.open").count(), 0, { message: "a tooltip on a model row" });
      await expect(picker.locator(".pk-r[data-tip], .pk-ctx-row[data-tip]")).toHaveCount(0);
      const select = row.locator(".pk-select");
      await expect(select).toHaveAccessibleName("Gemma 4 12B");
      await expect(select).toHaveAccessibleDescription(/^\d+\.\d\sGB (estimated|measured); .+$/);
      // The context rows say their size and fit on their face; no tooltip repeats it.
      // (The context column follows the hovered row; a click would choose it and close the picker.)
      const ctx = picker.locator(".pk-ctx-row").first();
      await expect(ctx).toBeVisible();
      await ctx.hover();
      await holds(page, 700, () => page.locator("#tip.open").count(), 0, { message: "a tooltip on a context row" });
      // Kept: an icon-only family button still names itself.
      await picker.locator(".pk-fam").first().hover();
      await expect(page.locator("#tip.open")).toBeVisible();
    });

    // N07 had the context header say only "Context length". WIN-MEM-07 (a tester read another row's
    // numbers as the selected model's) replaced it: the header names, once, the row whose numbers it shows.
    test("the wide picker's context header names the model whose numbers it shows, once; the size group names it too", async ({ page, open }) => {
      await open(); await waitReady(page);
      const picker = await openPicker(page);
      await picker.locator('.pk-r[data-m="gemma4:12b"] .pk-n').hover();
      const head = picker.locator(".pk-context-head");
      await expect(head.locator("small")).toHaveCount(0);
      await expect(head).toHaveText("Gemma 4 12B");
      await expect(picker.getByRole("radiogroup")).toHaveAccessibleName("Context length for Gemma 4 12B");
    });
  });

  test.describe("the model button", () => {
    test.use({ installed: ["qwen3.5:4b", "alice/custom:latest"] });

    for (const width of [1440, 360]) {
      test(`the model button keeps one width with its words at both edges, and an unknown maker stays in line, at ${width}px`, async ({ page, open }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await open(); await waitReady(page);
        const trigger = page.locator("#modelBtn");
        await expect(trigger.locator(".picker-trigger-name")).toContainText("Qwen");
        const spacing = await trigger.evaluate(button => {
          const first = button.firstElementChild!;
          const last = button.querySelector(".picker-trigger-ctx")!;
          const box = button.getBoundingClientRect();
          return { left: first.getBoundingClientRect().left - box.left, right: box.right - last.getBoundingClientRect().right };
        });
        expect(spacing.left, "the mark starts at the button's padding").toBeLessThanOrEqual(11);
        expect(Math.abs(spacing.left - spacing.right), "the same padding at both edges").toBeLessThanOrEqual(1);
        const before = await trigger.boundingBox();
        await page.locator(".composer").screenshot({ path: info.outputPath(`model-button-${width}.png`), animations: "disabled" });
        await trigger.focus(); await trigger.press("ArrowDown");
        const search = page.locator("#pkSearch");
        await expect(search).toBeFocused();
        await search.fill("custom");
        const row = page.locator('#picker .pk-r[data-m="alice/custom:latest"]');
        await expect(row.locator(".maker-mark")).toHaveCount(0);
        const columns = await row.evaluate(el => {
          const name = el.querySelector(".pk-name")!.getBoundingClientRect();
          const metric = el.querySelector(".pk-v")!.getBoundingClientRect();
          return { sameLine: Math.abs(name.top + name.height / 2 - metric.top - metric.height / 2) < 1, ordered: name.right <= metric.left };
        });
        expect(columns).toEqual({ sameLine: true, ordered: true });
        await row.locator(".pk-select").click();
        if (width <= 640) await page.locator('#picker [data-ctx="16384"]').click();
        await expect(page.locator("#picker")).toBeHidden();
        await expect(trigger.locator(".maker-mark")).toHaveCount(0);
        await expect(trigger).not.toContainText("?");
        await expect(trigger.locator(".picker-trigger-ctx")).toBeVisible();
        // one width for every usual name: picking another model moves neither end of the button
        if (width > 640) expect(await trigger.boundingBox(), "the button did not move or resize").toEqual(before);
        await page.locator(".composer").screenshot({ path: info.outputPath(`model-button-unknown-${width}.png`), animations: "disabled" });
        await trigger.click();
        await expect(page.locator('.pk-rail [aria-label="Other"]')).toHaveText("Other");
        await page.locator("#pkSearch").press("Escape");
        await expect(trigger).toBeFocused();
        expect(await page.locator(".cf").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      });
    }
  });
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
    // scorecard Q4: the tip holds the whole display name, shown while the button cuts it, and never the Ollama tag
    await expect(btn).toHaveAttribute("data-tipt", "gemma 4 26B A4B IT ultra heretic GGUF Q4_K_M uncensored");
    expect(`${await btn.getAttribute("data-tip") ?? ""}${await btn.getAttribute("data-tipt") ?? ""}`, "the tag is not in the tooltip").not.toContain(LONG_NAME);
    await btn.hover();
    await expect(page.locator("#tip")).toHaveText("gemma 4 26B A4B IT ultra heretic GGUF Q4_K_M uncensored");
    // scorecard Q17: a name too long for the button shows its family and size, not a cut word
    const label = btn.locator(":scope > .picker-trigger-name");
    await expect(label).toHaveAttribute("data-fit", "short");
    await expect(label.locator(".ptn-s")).toHaveText("gemma 26B");
    expect(await label.evaluate((el) => (el.querySelector<HTMLElement>(".ptn-s")?.offsetWidth ?? Infinity) <= el.clientWidth), "the short name fits whole").toBe(true);

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
