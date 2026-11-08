/// <reference lib="dom" />
// Journeys from Ethan's second pass: a long model name never pushes the
// composer's controls out, an 8k context, a toolbar that holds still while a
// model loads, and the thread menu on right-click with GPU memory in it.
import type { Page } from "@playwright/test";
import { LONG_NAME } from "../fake-ollama/models.ts";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";

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
    const controls = [...cf.querySelectorAll(".cf-l > *, .cf-r > *")].map((el) => ({ id: el.id || el.getAttribute("aria-label") || el.className, ...box(el) }));
    const send = document.querySelector(".composer .send");
    return { comp: box(comp), overflow: cf.scrollWidth - cf.clientWidth, height: cf.getBoundingClientRect().height, controls, send: send ? box(send) : null };
  });
}

test.describe("long model name", () => {
  test.use({ scenario: "long-name" });
  for (const width of [1440, 412]) longName(width);
});

function longName(width: number): void {
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
    await expect(page.locator("#picker")).toBeHidden();

    const btn = page.locator("#modelBtn");
    await expect(btn).toHaveAttribute("data-tip", new RegExp(LONG_NAME));
    const label = await btn.locator("span").first().evaluate((el) => ({ clipped: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow }));
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

test("the picker offers 8k; an 8k turn sends num_ctx 8192", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.locator("#modelBtn").click();
  const ctx = page.locator("#picker").getByRole("radiogroup", { name: "Context" });
  await expect(ctx.getByRole("radio")).toHaveText(["8k", "16k", "32k", "64k"]);
  // the default stays 16k
  await expect(ctx.getByRole("radio", { name: "16k" })).toHaveAttribute("aria-checked", "true");
  await ctx.getByRole("radio", { name: "8k" }).click();
  await expect(ctx.getByRole("radio", { name: "8k" })).toHaveAttribute("aria-checked", "true");
  await expect(ctx.getByRole("radio", { name: "8k" }).locator(".vd.gpu")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await sendMessage(page, "A small context");
  await expect(page.locator(".turn.a").last()).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string; body: { options?: { num_ctx?: number } } }[] };
  expect(state.requests.findLast((r) => r.path === "/api/chat")?.body.options?.num_ctx).toBe(8192);
});

test("Settings > Models offers 8k as the default context", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
  const seg = page.locator(".set").getByRole("group", { name: "Context window" });
  await expect(seg.getByRole("button")).toHaveText(["8k", "16k", "32k", "64k"]);
  await seg.getByRole("button", { name: "8k" }).click();
  await expect(seg.getByRole("button", { name: "8k" })).toHaveAttribute("aria-pressed", "true");
  // the saved default survives a reload
  await page.reload();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.locator(".set").getByRole("group", { name: "Context window" }).getByRole("button", { name: "8k" })).toHaveAttribute("aria-pressed", "true");
});
