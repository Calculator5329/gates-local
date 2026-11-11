/// <reference lib="dom" />
// The phone and tablet details: modal sheets and their focus, the drawer, 44 px
// targets by width, code and table overflow, first run, the empty thread and
// Settings' navigation. mobile.spec.ts has the whole journeys.
import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

/** Thu 2026-11-12 14:00 in Chicago, as in the screenshot rig. */
const NOW = Date.UTC(2026, 10, 12, 20, 0);
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const NARROW = { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true };
const LANDSCAPE = { viewport: { width: 915, height: 412 }, isMobile: true, hasTouch: true };
const MOUSE_600 = { viewport: { width: 600, height: 900 }, isMobile: false, hasTouch: false };
const TABLET = { viewport: { width: 800, height: 1000 }, isMobile: true, hasTouch: true };

test.use({ seed: "design", seedAt: NOW, timezoneId: "America/Chicago", locale: "en-US" });

test.describe("populated model picker", () => {
  test.use({ viewport: { width: 390, height: 749 }, isMobile: true, hasTouch: true, installed: ["qwen3.5:9b", "gemma4:12b", "qwen3.8-abliterated:27b", "qwen3.5:4b", "mistral-small3.2:24b", "mid-chat:32k", "tiny-chat:2k", "no-limit-chat:1b"] });
  test("the picker: initial rows and Show more fit without clipping the control", async ({ page, open }) => {
    await open(); await waitReady(page);
    await page.locator("#modelBtn").tap();
    const picker = page.locator("#picker");
    const more = picker.getByRole("button", { name: "Show more", exact: true });
    await expect(more).toBeEnabled();
    const frame = await picker.boundingBox(), list = await picker.locator(".pk-list-scroll").boundingBox(), button = await more.boundingBox();
    await page.screenshot({ path: test.info().outputPath("picker-phone-populated.png") });
    expect(frame).not.toBeNull(); expect(list).not.toBeNull(); expect(button).not.toBeNull();
    if (!frame || !list || !button) return;
    expect(button.y + button.height, "Show more is fully inside the list viewport").toBeLessThanOrEqual(list.y + list.height);
    await more.tap();
    await expect(picker.getByRole("option")).toHaveCount(8);
    expect(await picker.boundingBox()).toEqual(frame);
  });
});

const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).first().boundingBox();
  expect(b, `${sel} has a box`).not.toBeNull();
  return b ?? { x: 0, y: 0, width: 0, height: 0 };
};
const focusInside = (page: Page, sel: string) => page.evaluate((s) => document.querySelector(s)?.contains(document.activeElement) ?? false, sel);
const focusVisible = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a !== null && a !== document.body && a.getClientRects().length > 0 && a.closest("[inert], .sb") === null;
  });
const css = (page: Page, sel: string, prop: string, pseudo?: string) =>
  page.locator(sel).first().evaluate((el, [p, ps]) => getComputedStyle(el, ps ?? undefined).getPropertyValue(p ?? ""), [prop, pseudo] as const);

async function openThread(page: Page, open: (h?: string) => Promise<void>, id: string | null): Promise<void> {
  await open(`#thread=${id ?? ""}`);
  await waitReady(page);
}

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open threads" }).tap();
  await expect(page.locator(".sb .sb-row").first()).toBeInViewport({ ratio: 1 });
}

/** A thread's menu from its row in the drawer, by the keyboard; a long press opens the same menu. */
async function drawerRowMenu(page: Page): Promise<void> {
  await openDrawer(page);
  await page.locator(".sb .sb-row .sb-thread").first().focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.locator("#threadMenu")).toHaveClass(/\bopen\b/);
}

// ------------------------------------------------------------- sheets (MB-01, ML-11)

for (const [name, use] of [["412 touch", PHONE], ["915 touch", LANDSCAPE], ["600 mouse", MOUSE_600]] as const) {
  test.describe(`Ctrl+M at ${name}`, () => {
    test.use(use);
    test("focuses the picker's search, and typing goes there", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await page.keyboard.press("Control+m");
      await expect(page.locator("#pkSearch")).toBeFocused();
      await page.keyboard.type("xyz");
      await expect(page.locator("#pkSearch")).toHaveValue("xyz");
      await expect(page.locator("#ta")).toHaveValue("");
    });
  });
}

test.describe("sheets on a phone", () => {
  test.use(PHONE);

  test("the model picker follows the remaining viewport when a touch keyboard reduces its height", async ({ page, open }) => {
    await open(); await waitReady(page);
    await page.locator("#modelBtn").tap();
    const picker = page.locator("#picker");
    await expect(picker.locator(".pk-v").filter({ hasText: "Checking…" })).toHaveCount(0);
    await expect(picker.locator(".pk-cost.pending")).toHaveCount(0);
    await page.setViewportSize({ width: 412, height: 500 });
    const frame = await picker.boundingBox();
    await page.screenshot({ path: test.info().outputPath("picker-phone-short-viewport.png") });
    expect(frame).not.toBeNull();
    if (!frame) return;
    expect(Math.round(frame.y + frame.height), "picker stays above the reduced viewport's bottom inset").toBe(492);
  });

  for (const [label, opener, sheet] of [
    ["the model picker", "#modelBtn", "#picker"],
    ["chat options", "#optBtn", "#optsMenu"],
    ["the add menu", "#plusBtn", "#plusMenu"],
    ["the thread menu", ".sb-row .sb-menu", "#threadMenu"],
  ] as const) {
    test(`${label} is modal: focus moves in, stays in, and goes back`, async ({ page, open, seededThread }) => {
      await openThread(page, open, seededThread);
      if (sheet === "#threadMenu") await openDrawer(page);
      await page.locator(opener).first().tap();
      await expect(page.locator(sheet === "#picker" ? "#picker .pk-close" : `${sheet} .sh-h button`)).toBeFocused();
      await expect(page.locator("#app")).toHaveAttribute("inert", "");
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        expect(await focusInside(page, sheet), `Tab ${i + 1} stays in ${sheet}`).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(page.locator(sheet)).toBeHidden();
      await expect(page.locator("#app")).not.toHaveAttribute("inert", "");
      await expect(page.locator(opener).first()).toBeFocused();
      await test.step("close target and swipe dismissal remain reachable", async () => {
      await page.locator(opener).first().tap();
      if (sheet === "#picker") {
        const frame = await box(page, sheet), close = await box(page, "#picker .pk-close");
        expect(frame.width).toBe(360);
        expect(Math.min(close.width, close.height), "close size").toBeGreaterThanOrEqual(44);
        await page.locator("#picker .pk-close").tap();
        await expect(page.locator(sheet)).toBeHidden();
        return;
      }
      expect(await css(page, `${sheet} .sh-h`, "width", "::before")).toBe("36px");
      const close = await box(page, `${sheet} .sh-h button`);
      expect(Math.min(close.width, close.height), "close size").toBeGreaterThanOrEqual(44);
      await page.locator(`${sheet} .sh-h`).evaluate((el) => {
        const touch = (y: number) => new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
        el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(500)], changedTouches: [touch(500)] }));
        el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [touch(600)] }));
      });
      await expect(page.locator(sheet)).toBeHidden();
      });
    });
  }
});

// ------------------------------------------------------------- the drawer (ML-08, MB-02, MB-03)

for (const [name, use] of [["412", PHONE], ["800", TABLET]] as const) {
  test.describe(`Ctrl+K at ${name}`, () => {
    test.use(use);
    test("opens the drawer and focuses search", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await page.keyboard.press("Control+k");
      await expect(page.locator("#searchIn")).toBeVisible();
      await expect(page.locator("#searchIn")).toBeInViewport({ ratio: 1 });
      await expect(page.locator("#searchIn")).toBeFocused();
    });
  });
}

test.describe("the drawer", () => {
  test.use(PHONE);

  test("is a sheet-grey panel with a close button, 44 px rows and one time column", async ({ page, open, seededThread }) => {
    await openThread(page, open, seededThread);
    await openDrawer(page);
    const d = await box(page, ".sb");
    // Layout widths are fractional on some hosts (340.0000072 seen); the cap is whole pixels.
    expect(d.width, "drawer width").toBeLessThanOrEqual(340.5);
    expect(d.width / 412, "drawer share of the screen").toBeGreaterThanOrEqual(0.82);
    expect(await css(page, ".sb", "background-color")).toBe(await css(page, "#plusMenu", "background-color"));
    expect(await css(page, ".scrim", "background-color")).toBe("rgba(0, 0, 0, 0.6)");
    const close = page.locator(".sb").getByRole("button", { name: "Close threads" });
    const cb = await close.boundingBox();
    expect(Math.min(cb?.width ?? 0, cb?.height ?? 0), "close size").toBeGreaterThanOrEqual(44);
    const rows = await page.locator(".sb-row").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const ago = el.querySelector(".ago");
        const a = ago?.getBoundingClientRect();
        const t = el.querySelector(".t")?.getBoundingClientRect();
        return { h: r.height, text: ago?.textContent ?? "", w: a?.width ?? 0, right: a?.right ?? 0, titleEnd: t?.right ?? 0, ago: a?.left ?? 0 };
      }),
    );
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) {
      expect(r.h, "row height").toBeGreaterThanOrEqual(44);
      expect(r.text, "one time format").toMatch(/^(now|\d+(m|h|d|w|mo|y))$/);
      expect(r.titleEnd, "the title ends before the time").toBeLessThanOrEqual(r.ago);
    }
    expect(new Set(rows.map((r) => Math.round(r.w))).size, "one time column width").toBe(1);
    expect(new Set(rows.map((r) => Math.round(r.right))).size, "one right edge").toBe(1);
    await close.tap();
    await expect(page.locator(".sb .sb-row").first()).not.toBeInViewport();
    await expect(page.getByRole("button", { name: "Open threads" })).toBeFocused();
  });

  test("after a pick, focus lands on something visible", async ({ page, open, seededThread }) => {
    await openThread(page, open, seededThread);
    await openDrawer(page);
    await page.locator(".sb .sb-row").filter({ hasText: "Fix the backup cron" }).tap();
    await expect(page.locator(".hdr h2")).toContainText("Fix the backup cron");
    await expect.poll(() => focusVisible(page), { message: "focus after a thread pick" }).toBe(true);
    await openDrawer(page);
    await page.locator(".sb").getByRole("button", { name: "Settings" }).tap();
    await expect(page.locator(".set-list")).toBeVisible();
    await expect.poll(() => focusVisible(page), { message: "focus after opening Settings" }).toBe(true);
  });
});

// ------------------------------------------------------------- targets by width (MB-04, ML-02)

test.describe("a touch landscape below 1024", () => {
  test.use(LANDSCAPE);
  test("the header's menu and new thread are 44 px", async ({ page, open, seededThread }) => {
    await openThread(page, open, seededThread);
    for (const name of ["Open threads", "New thread"]) {
      const b = await page.locator(".hdr").getByRole("button", { name }).boundingBox();
      expect(Math.min(b?.width ?? 0, b?.height ?? 0), `${name} size`).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("a 600 px window with a mouse", () => {
  test.use(MOUSE_600);
  test("Send and the composer's controls are 44 px by width alone", async ({ page, open }) => {
    await open();
    await waitReady(page);
    for (const sel of ["#plusBtn", "#modelBtn", "#optBtn", ".send"]) {
      const b = await box(page, sel);
      expect(b.height, `${sel} height`).toBeGreaterThanOrEqual(44);
      if (sel !== "#modelBtn") expect(b.width, `${sel} width`).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("the composer at 360", () => {
  test.use(NARROW);
  test("is one row of four controls and rests low", async ({ page, open }) => {
    await open();
    await waitReady(page);
    const centre = async (sel: string) => {
      const b = await box(page, sel);
      return b.y + b.height / 2;
    };
    const y = await centre("#plusBtn");
    for (const sel of ["#modelBtn", "#optBtn", ".send"]) expect(Math.abs((await centre(sel)) - y), `${sel} is on the row`).toBeLessThanOrEqual(1);
    const form = await box(page, ".composer");
    expect(form.height, "resting composer height").toBeLessThanOrEqual(88);
    const send = await box(page, ".send");
    expect(send.x + send.width, "send stays inside the composer").toBeLessThanOrEqual(form.x + form.width);
  });
});

// ------------------------------------------------------------- code, tables, links (ML-01, ML-06, ML-07, MB-06)

for (const [name, use] of [["360", NARROW], ["412", PHONE]] as const) {
  test.describe(`long content at ${name}`, () => {
    test.use({ ...use, seed: "design-code" });

    test("read code, tables and long links without overflowing the timeline", async ({ page, open, seededThread }) => {
      await openThread(page, open, seededThread);
      await test.step("code scrolls inside its block, never the timeline, with a copy target and a fade", async () => {
      const pre = page.locator(".md .cb pre").last();
      await pre.scrollIntoViewIfNeeded();
      const m = await pre.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, pad: getComputedStyle(el).paddingRight }));
      expect(m.sw, "the block has hidden width").toBeGreaterThan(m.cw);
      expect(m.pad).toBe("16px");
      await expect(pre).toHaveAttribute("data-more", "end");
      expect(await pre.evaluate((el) => getComputedStyle(el).maskImage)).toContain("linear-gradient");
      const moved = await pre.evaluate((el) => {
        el.scrollLeft = 120;
        return el.scrollLeft;
      });
      expect(moved, "the block scrolls sideways").toBeGreaterThan(0);
      await expect(pre).toHaveAttribute("data-more", "start end");
      await pre.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await expect(pre).toHaveAttribute("data-more", "start");
      const tl = await page.locator(".tl").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      expect(tl.sw, "the timeline does not overflow").toBeLessThanOrEqual(tl.cw);
      const copy = await page.locator(".md .cb-copy").last().boundingBox();
      expect(Math.min(copy?.width ?? 0, copy?.height ?? 0), "copy target").toBeGreaterThanOrEqual(44);
      await expect(page.locator(".md .cb-copy").last()).toHaveCSS("opacity", "1");
      });
      await test.step("a table scrolls by itself, its first column readable and numbers to content", async () => {
      const table = page.locator(".md table").last();
      await table.scrollIntoViewIfNeeded();
      const m = await table.evaluate((el) => {
        const heads = [...el.querySelectorAll("th")].map((h) => h.getBoundingClientRect().width);
        return { sw: el.scrollWidth, cw: el.clientWidth, heads };
      });
      expect(m.sw, "the table has hidden width").toBeGreaterThan(m.cw);
      expect(m.heads[0] ?? 0, "first column").toBeGreaterThanOrEqual(160);
      expect(m.heads[3] ?? 999, "number column").toBeLessThan(90);
      await expect(table).toHaveAttribute("data-more", "end");
      });
      await test.step("a long URL is a link, underlined, and wraps only after / or -", async () => {
      const link = page.locator('.md a[href^="https://effect.website"]');
      await expect(link).toBeVisible();
      await expect(link).toHaveCSS("text-decoration-line", "underline");
      const ends = await link.evaluate((el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const chars: { c: string; top: number }[] = [];
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          const text = n.textContent ?? "";
          for (let i = 0; i < text.length; i++) {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            chars.push({ c: text[i] ?? "", top: Math.round(r.getBoundingClientRect().top) });
          }
        }
        return chars.filter((c, i) => i + 1 < chars.length && (chars[i + 1]?.top ?? 0) !== c.top).map((c) => c.c);
      });
      expect(ends.length, "the URL wraps").toBeGreaterThan(0);
      for (const c of ends) expect("/-", `a line ends in "${c}"`).toContain(c);
      });
    });
  });
}

// ------------------------------------------------------------- the thread (ML-05, ML-09, ML-10)

test.describe("a finished thread on touch", () => {
  test.use(PHONE);

  test("every finished reply has its actions, 44 px, with the model and speed behind Details", async ({ page, open, seededThread }) => {
    await openThread(page, open, seededThread);
    const rows = page.locator(".turn.a .a-act");
    await expect(rows.nth(1)).toBeAttached();
    for (let i = 0; i < (await rows.count()); i++) {
      const copy = rows.nth(i).locator("[data-copy]");
      await expect(copy).toBeVisible();
      const b = await copy.boundingBox();
      expect(Math.min(b?.width ?? 0, b?.height ?? 0), "copy target").toBeGreaterThanOrEqual(44);
    }
    const first = rows.first();
    await expect(first.locator(".meta")).toBeHidden();
    await first.getByRole("button", { name: "Reply details" }).tap();
    await expect(first.locator(".meta")).toBeVisible();
    await expect(first.locator(".meta")).toContainText("Qwen 3.5 9B");
  });


  test("a tool row's collapsed line drops the tool's name; its details keep it", async ({ page, open, seededThread }) => {
    await openThread(page, open, seededThread);
    const row = page.locator(".wr").first();
    await expect(row.locator(".wr-m")).toBeVisible();
    const visible = await row.locator(".wr-m").evaluate((el) => (el as HTMLElement).innerText);
    expect(visible).not.toContain("Shell");
    expect(visible).not.toContain("read-only");
    expect(await css(page, ".wr-m", "font-variant-numeric")).toBe("normal");
    await row.tap();
    await expect(row.locator(".wr-body")).toContainText("Shell · read-only");
  });
});

// ------------------------------------------------------------- first run (ML-03)

for (const [name, use] of [["360", NARROW], ["412", PHONE]] as const) {
  test.describe(`first run at ${name}`, () => {
    test.use({ ...use, seed: 0, skipFirstRun: false });
    test("the primary is full width above the bottom edge, the secondary 44 px below it", async ({ page, open }) => {
      await open();
      const primary = page.getByRole("button", { name: "Start chatting" });
      await expect(primary).toBeVisible();
      const b = await primary.boundingBox();
      const w = use.viewport.width;
      const h = use.viewport.height;
      expect(b?.x ?? 0, "left inset").toBe(16);
      expect(b?.width ?? 0, "full width").toBe(w - 32);
      expect((b?.y ?? 0) + (b?.height ?? 0), "pinned low").toBeGreaterThan(h - 140);
      const link = await page.getByRole("button", { name: "Change defaults in Settings" }).boundingBox();
      expect(link?.height ?? 0, "secondary height").toBeGreaterThanOrEqual(44);
      expect(link?.y ?? 0, "secondary under the primary").toBeGreaterThanOrEqual((b?.y ?? 0) + (b?.height ?? 0));
      expect((link?.y ?? 0) + (link?.height ?? 0), "secondary on screen").toBeLessThanOrEqual(h);
      expect(await css(page, ".fr-card .tipd", "text-decoration-line")).toBe("none");
      const lefts = await page.locator(".fr-m > *").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
      expect(new Set(lefts).size, "the card is one left-aligned column").toBe(1);
      await expect(page.locator(".fr-m .rec"), "no separator left leading its own line").toHaveText("Recommended", { useInnerText: true });
      // said once, under the new-chat heading, not on first run
      await expect(page.locator(".fr-foot")).toHaveCount(0);
      await expect(page.locator(".fr")).not.toContainText("Nothing leaves your own network");
    });
  });
}

// ------------------------------------------------------------- the empty thread (ML-04, ML-19)

test.describe("a new thread at 360", () => {
  test.use(NARROW);
  test("the headline and suggestions sit on the composer, one setup row, a quiet new-thread icon", async ({ page, open }) => {
    await open();
    await waitReady(page);
    // Library hydration replaces the initial image-only link with this combined setup row.
    await expect(page.locator(".card-links").getByRole("button", { name: "Set up library and images…", exact: true })).toBeVisible();
    const cards = await box(page, ".cards");
    const composer = await box(page, ".composer");
    const setup = await box(page, ".card-links");
    expect(setup.y - (cards.y + cards.height), "the setup row follows the suggestions").toBeLessThanOrEqual(16);
    expect(composer.y - (setup.y + setup.height), "the suggestions end just above the composer").toBeLessThanOrEqual(24);
    expect(await css(page, ".hero", "text-wrap")).toContain("balance");
    await expect(page.locator(".hero-sub")).toHaveText("Runs on your computer. Nothing leaves your own network.");
    const links = page.locator(".card-links button:visible");
    await expect(links).toHaveCount(1);
    await expect.poll(async () => (await links.first().boundingBox())?.height ?? 0, { message: "setup row height" }).toBeGreaterThanOrEqual(44);
    const nb = page.locator(".hdr").getByRole("button", { name: "New thread" });
    await expect(nb).toBeDisabled();
    await page.locator("#ta").fill("x");
    await expect(nb).toBeEnabled();
  });
});

// ------------------------------------------------------------- sheets' content (ML-12, ML-13, ML-18)

test.describe("sheet content on a phone", () => {
  test.use(PHONE);

  test("chat options: Thinking is a switch, Image says why it is off, context is information", async ({ page, open, seededThread }) => {
    await openThread(page, open, seededThread);
    await page.locator("#optBtn").tap();
    const sheet = page.locator("#optsMenu");
    const think = sheet.getByRole("menuitemcheckbox", { name: /Thinking/ });
    await expect(think.locator(".switch")).toBeVisible();
    const before = await think.getAttribute("aria-checked");
    await think.tap();
    await expect(think).not.toHaveAttribute("aria-checked", before ?? "");
    const image = sheet.locator('[data-image-off]');
    await expect(image).toHaveAttribute("aria-disabled", "true");
    await expect(image).toContainText("Set it up in Settings");
    await expect(sheet.locator(".mi.st use")).toHaveAttribute("href", "#i-gauge");
  });


  test("the picker: search fills the model column and each row shows estimated memory", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").tap();
    const frame = await box(page, "#picker"), search = await box(page, "#picker .pk-search");
    expect(search.x - frame.x, "rail plus search inset").toBe(57);
    expect(search.width, "search uses the model column").toBe(frame.width - 44 - 26);
    await expect(page.locator('#picker .pk-r[data-m="gemma4:12b"] .pk-v')).toHaveText(/^\d+\.\d\sGB$/);
    const row = await page.locator('#picker .pk-r[data-m="gemma4:12b"]').boundingBox();
    expect((row?.x ?? 0) + (row?.width ?? 0), "rows stay in their column").toBeLessThanOrEqual(frame.x + frame.width - 12);
  });

  test("a large model opens context choices; refused sizes stay disabled and a smaller size can be chosen", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").tap();
    await page.locator('#picker .pk-r[data-m="qwen3.8-abliterated:27b"] .pk-select').tap();
    await expect(page.locator("#picker .pk-context")).toBeVisible();
    await expect(page.locator('#picker [data-ctx="65536"]')).toBeDisabled();
    await page.locator("#picker").getByRole("button", { name: "Memory details", exact: true }).tap();
    await expect(page.locator(".set-bar").getByRole("heading", { name: "Advanced", exact: true })).toBeVisible();
    await expect(page.locator("#gpuMemory .srow:has(.fp-v) .sl b")).toHaveText("qwen3.8-abliterated:27b");
    await page.getByRole("button", { name: "Back to Settings", exact: true }).tap();
    await page.getByRole("button", { name: "Done", exact: true }).tap();
    await page.locator("#modelBtn").tap();
    await page.locator('#picker .pk-r[data-m="qwen3.8-abliterated:27b"] .pk-select').tap();
    await page.locator("#picker .pk-back").tap();
    await page.locator('#picker .pk-r[data-m="gemma4:12b"] .pk-select').tap();
    await expect(page.locator('#picker [data-ctx="65536"]')).toBeDisabled();
    await expect(page.locator('#picker [data-ctx="32768"]')).toBeEnabled();
    await page.locator('#picker [data-ctx="32768"]').tap();
    await expect(page.locator("#picker")).toBeHidden();
    await expect(page.locator("#modelBtn")).toContainText("32k");
    await expect(page.locator("#modelBtn")).toBeFocused();
    await expect(page.locator("#ta")).not.toBeFocused();
  });
});

// ------------------------------------------------------------- Sol's phone review (MZ-01, 03, 04, 06)

test.describe("the thread menu from a drawer row", () => {
  test.use(PHONE);

  test("Rename closes the drawer, so its title field can be typed in", async ({ page, open, seededThread }) => {
    await openThread(page, open, seededThread);
    await drawerRowMenu(page);
    await page.locator("#threadMenu").getByRole("menuitem", { name: "Rename" }).click();
    await expect(page.locator(".app.drawer")).toHaveCount(0);
    await expect(page.locator("main.main")).not.toHaveAttribute("inert", /.*/);
    await expect(page.getByRole("textbox", { name: "Thread title" })).toBeFocused();
  });
});

test.describe("chat options on a 2,048 model", () => {
  test.use({ ...PHONE, installed: ["tiny-chat:2k"] });

  test("context is measured against what the model runs at, not what was asked for", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await page.locator("#ta").fill("Say hello");
    await page.getByRole("button", { name: "Send message" }).tap();
    await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Say hello");
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 10_000 });
    await page.locator("#optBtn").tap();
    const context = page.locator("#optsMenu .mi.st");
    await expect(context.locator("small")).toHaveText(/ of 2k tokens$/);
    const kilos = Number.parseFloat((await context.locator("small").textContent()) ?? "");
    const shown = Number.parseInt(/(\d+)%/.exec((await context.locator("b").textContent()) ?? "")?.[1] ?? "", 10);
    expect(Math.abs(shown - (kilos * 1000 * 100) / 2048), `${String(shown)}% for ${String(kilos)}k of 2,048`).toBeLessThanOrEqual(3);
  });
});

test.describe("chat options on a model that does not think", () => {
  test.use({ ...PHONE, installed: ["gemma4:12b"] });

  test("Thinking is off and says why, as the desktop pill does", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await page.locator("#optBtn").tap();
    const think = page.locator("#optsMenu").getByRole("menuitemcheckbox", { name: /Thinking/ });
    await expect(think).toHaveAttribute("aria-disabled", "true");
    await expect(think).toHaveAttribute("aria-checked", "false");
    await expect(think).toContainText("Gemma 4 12B does not reason before answering");
    // Playwright will not tap an aria-disabled control; a finger still can, and nothing may change
    await think.tap({ force: true });
    await expect(think).toHaveAttribute("aria-checked", "false");
  });
});

test.describe("a resize out of phone width with a sheet open", () => {
  test.use(MOUSE_600);

  test("gives focus back instead of losing it with the sheet", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await page.keyboard.press("Control+m");
    await expect(page.locator("#pkSearch")).toBeFocused();
    await page.setViewportSize({ width: 1200, height: 900 });
    await expect(page.locator("#picker")).toBeHidden();
    await expect.poll(() => focusVisible(page)).toBe(true);
  });
});

test.describe("sheet content at 360", () => {
  test.use(NARROW);

  test("a short model name is never cut to make room for its labels", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").tap();
    // the wider "Checking…" holds a row only until its fit arrives
    await expect(page.locator("#picker .pk-v", { hasText: "Checking" })).toHaveCount(0);
    // the text's own width against its box: scrollWidth rounds up and reports a name that is not cut
    const cut = await page.locator("#picker .pk-nm").evaluateAll((els) =>
      els
        .filter((e) => {
          const text = document.createRange();
          text.selectNodeContents(e);
          return text.getBoundingClientRect().width > e.getBoundingClientRect().width + 0.5;
        })
        .map((e) => e.textContent ?? ""),
    );
    // Community variants may truncate; the short everyday names remain complete.
    expect(cut.filter((name) => name === "Qwen 3.5 9B" || name === "Gemma 4 12B")).toEqual([]);
  });

  test("a switch that is on paints its track, not its enlarged touch area", async ({ page, open, seededThread }, info) => {
    await openThread(page, open, seededThread);
    const controls = page.locator(".cf-r");
    for (const control of await controls.locator(":scope > button").all()) {
      const bounds = await control.boundingBox();
      expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    const covered = await controls.locator(":scope > button").evaluateAll(buttons => buttons.filter(button => {
      const r = button.getBoundingClientRect();
      return !button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }).map(button => button.id));
    expect(covered, "each phone control receives its own centre tap").toEqual([]);
    await page.screenshot({ path: info.outputPath("phone-composer-controls.png") });
    await page.locator("#optBtn").tap();
    const on = page.locator('#optsMenu .mi[aria-checked="true"] .switch');
    await expect(on).toBeVisible();
    expect(await on.evaluate((e) => getComputedStyle(e).backgroundClip)).toBe("padding-box");
  });
});

// ------------------------------------------------------------- Settings (ML-15, ML-16, ML-17, ML-20)

const SETTINGS_SECTIONS = ["General", "Models", "Instructions", "Library", "Tools", "Image generation", "Runtime", "Advanced", "Shortcuts"];

/** The page and Settings' scrollers that are wider than the screen. */
const sideways = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>("html, .set, .set-in, .mp")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className || e.tagName));

const phoneSettings = async (page: Page, section?: string) => {
  await openDrawer(page);
  await page.locator(".sb").getByRole("button", { name: "Settings" }).tap();
  await expect(page.locator(".set-list")).toBeVisible();
  if (section !== undefined) await page.locator(".set-list").getByRole("button", { name: section }).tap();
};

test.describe("Settings on a phone", () => {
  test.use(PHONE);

  test("the bar names the page, Back says where it goes, and Done leaves from the list", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await phoneSettings(page);
    await expect(page.locator(".set-bar h2")).toHaveText("Settings");
    const list = page.locator(".set-list");
    await expect(list.getByRole("button", { name: /Models/ })).toContainText("Qwen 3.5 9B");
    await expect(list.getByRole("button", { name: /Runtime/ })).toContainText("Running");
    await expect(list.getByRole("button", { name: /Image generation/ })).toContainText("Off");
    await list.getByRole("button", { name: /Models/ }).tap();
    await expect(page.locator(".set-bar h2")).toHaveText("Models");
    await expect(page.locator(".mp-head h1")).toBeHidden();
    const back = page.getByRole("button", { name: "Back to Settings" });
    await expect(back).toHaveText("Settings");
    const b = await back.boundingBox();
    expect(b?.height ?? 0, "back height").toBeGreaterThanOrEqual(44);
    await back.tap();
    await page.getByRole("button", { name: "Done" }).tap();
    await expect(page.locator(".hero")).toBeVisible();
  });

  test("Runtime says the port once and its status card has no dead space", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await phoneSettings(page, "Runtime");
    const text = (await page.locator(".set-in").innerText()).toLowerCase();
    expect(text.split("port ").length - 1, "port mentions in prose").toBe(0);
    const row = page.locator(".srow", { has: page.locator(".stat") });
    // the status row carries the switch now, so its value column is never an empty one
    await expect(row.locator(".sv").getByRole("button")).toHaveText(/^Use .*Ollama$/);
  });

  test("secondary text is 14 px or more apart from approved compact picker figures", async ({ page, open, seededThread }) => {
    await openThread(page, open, seededThread);
    const sweep = () =>
      page.evaluate(() => {
        const muted = getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim();
        const probe = document.createElement("i");
        probe.style.color = muted;
        document.body.append(probe);
        const grey = getComputedStyle(probe).color;
        probe.remove();
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("body *")) {
          if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "")) continue;
          if (el.getClientRects().length === 0 || el.closest("[inert]") !== null || el.closest(".cb, code, .mmark") !== null) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.opacity === "0" || cs.color !== grey) continue;
          // The approved compact picker uses smaller secondary cost figures and footer text.
          if (parseFloat(cs.fontSize) < 14 && el.closest(".picker-trigger-ctx,#picker .pk-v,#picker .pk-cost,#picker .pk-bottom,#picker .pk-context-head small") === null) out.push(`${el.tagName.toLowerCase()}.${el.className} ${cs.fontSize}`);
        }
        return out;
      });
    expect(await sweep(), "thread").toEqual([]);
    await page.locator("#modelBtn").tap();
    expect(await sweep(), "picker").toEqual([]);
    await page.keyboard.press("Escape");
    await openDrawer(page);
    expect(await sweep(), "drawer").toEqual([]);
    await page.locator(".sb").getByRole("button", { name: "Settings" }).tap();
    await expect(page.locator(".set-list")).toBeVisible();
    expect(await sweep(), "settings list").toEqual([]);
    for (const section of SETTINGS_SECTIONS) {
      await page.locator(".set-list").getByRole("button", { name: section }).tap();
      await expect(page.locator(".set-bar h2")).toHaveText(section);
      if (section === "Models") await expect(page.locator(".mp-row").first()).toBeVisible();
      if (section === "Advanced") await expect(page.locator("#gpuMemory .fp-v:visible")).toBeVisible();
      expect(await sweep(), section).toEqual([]);
      await page.getByRole("button", { name: "Back to Settings" }).tap();
    }
  });
});

// ------------------------------------------------------------- main's Settings pages at both phone widths (ML-15)

for (const [width, use] of [["412", PHONE], ["360", NARROW]] as const) {
  test.describe(`Settings at ${width}`, () => {
    test.use(use);

    test("the list opens every section with one bar and nothing wider than the screen", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await phoneSettings(page);
      await expect(page.locator(".snav")).toBeHidden();
      const list = page.locator(".set-list");
      await expect(list.getByRole("button")).toHaveCount(SETTINGS_SECTIONS.length);
      expect(await sideways(page), "list").toEqual([]);
      for (const section of SETTINGS_SECTIONS) {
        await list.getByRole("button", { name: section }).tap();
        await expect(page.locator(".set-bar h2")).toHaveText(section);
        await expect(page.getByRole("button", { name: /^Back to/ })).toHaveCount(1);
        expect(await sideways(page), section).toEqual([]);
        await page.getByRole("button", { name: "Back to Settings" }).tap();
        await expect(list).toBeVisible();
      }
    });

    test("Advanced has GPU memory with its context control and its Details in reach", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await phoneSettings(page, "Advanced");
      const gpu = page.locator("#gpuMemory");
      await expect(gpu.locator(".fp-v:visible")).toBeVisible();
      const sizes = gpu.locator(".mini-seg button");
      expect(await sizes.count()).toBeGreaterThan(1);
      // touch targets here are 44 wide by 40 tall (styles.css, the hover:none block)
      for (const b of await sizes.all()) expect((await b.boundingBox())?.height ?? 0, "context size height").toBeGreaterThanOrEqual(40);
      const details = gpu.getByText("Details", { exact: true });
      expect((await details.boundingBox())?.height ?? 0, "Details height").toBeGreaterThanOrEqual(44);
      await details.tap();
      await expect(gpu.getByText("Where the memory goes")).toBeVisible();
      expect(await sideways(page), "Advanced with Details open").toEqual([]);
    });

    test("Remove stays in a row's ⋯ menu, 44 px to reach and on the screen", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await phoneSettings(page, "Models");
      const row = page.locator('.mp-row[data-dm="gemma4:12b"]');
      await expect(row).toBeVisible();
      await expect(page.locator(".mp")).not.toContainText("Remove");
      const more = row.getByRole("button", { name: /^More for / });
      const b = await more.boundingBox();
      expect(Math.min(b?.width ?? 0, b?.height ?? 0), "⋯ size").toBeGreaterThanOrEqual(44);
      await more.tap();
      const remove = row.getByRole("menuitem", { name: /^Remove…/ });
      await expect(remove).toBeInViewport({ ratio: 1 });
      expect((await remove.boundingBox())?.height ?? 0, "Remove height").toBeGreaterThanOrEqual(44);
      await remove.tap();
      await page.getByRole("dialog").locator(".mp-danger").tap();
      await expect(row).toHaveCount(0);
    });

    test("Back from the Download tab returns to the list, and Models opens on Installed again", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await phoneSettings(page, "Models");
      await page.getByRole("tab", { name: /^Download/ }).tap();
      await expect(page.locator(".set-bar h2")).toHaveText("Models");
      await page.getByRole("button", { name: "Back to Settings" }).tap();
      await expect(page.locator(".set-list")).toBeVisible();
      await page.locator(".set-list").getByRole("button", { name: "Models" }).tap();
      await expect(page.getByRole("tab", { name: /^Installed/ })).toHaveAttribute("aria-selected", "true");
    });
  });
}

// ------------------------------------------------------------- the desktop's Remove (ML-16)

test.describe("the desktop's model rows", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("Remove is in the row's ⋯ menu and nowhere under the row", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
    const row = page.locator('.mp-row[data-dm="gemma4:12b"]');
    await expect(row).toBeVisible();
    await expect(page.locator(".mp")).not.toContainText("Remove");
    await row.getByRole("button", { name: /^More for / }).click();
    await expect(row.getByRole("menuitem", { name: /^Remove…/ })).toBeVisible();
  });
});
