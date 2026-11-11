/// <reference lib="dom" />
// The composer's row and its popovers: the model picker opens over the
// conversation from its button, the model button has no caret, the Thinking
// pill keeps its size, a reply's thinking opens without a jump, and files
// arrive through the + menu's chooser or a drop on the window.
import type { Locator, Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
test.use({ video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

type Box = { x: number; y: number; width: number; height: number };
const box = async (l: Locator): Promise<Box> => {
  const b = await l.boundingBox();
  expect(b, "element has a box").not.toBeNull();
  return b!;
};

async function pickerOverConversation(page: Page, width: number, name: string) {
  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
  const p = await box(picker), b = await box(page.locator("#modelBtn")), c = await box(page.locator(".composer"));
  const view = page.viewportSize()!;
  // Inside the window at every width.
  expect(p.x, "left edge inside the window").toBeGreaterThanOrEqual(0);
  expect(p.y, "top edge inside the window").toBeGreaterThanOrEqual(0);
  expect(p.x + p.width, "right edge inside the window").toBeLessThanOrEqual(view.width);
  expect(p.y + p.height, "bottom edge inside the window").toBeLessThanOrEqual(view.height);
  if (width > 640) {
    // It grows to the left from the model button, right edges together.
    expect(Math.abs(p.x + p.width - (b.x + b.width)), "right edge on the model button's right edge").toBeLessThanOrEqual(1);
    // It floats over the composer, above the button, not stacked above the composer.
    expect(p.y + p.height, "bottom edge above the model button").toBeLessThanOrEqual(b.y);
    expect(p.y + p.height, "bottom edge over the composer, not above it").toBeGreaterThan(c.y);
    expect(await picker.evaluate(el => getComputedStyle(el).boxShadow), "the app's popover shadow").not.toBe("none");
  }
  await page.screenshot({ path: test.info().outputPath(`picker-${name}-${width}.png`) });
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
}

for (const width of [1137, 760, 390]) {
  test.describe(`picker at ${width}`, () => {
    test.use({ viewport: { width, height: 749 }, isMobile: width === 390, hasTouch: width === 390 });
    test("opens over the empty new-thread screen from the model button", async ({ page, open }) => {
      await open(); await waitReady(page);
      await pickerOverConversation(page, width, "empty");
    });
  });
}

test.describe("picker in a long chat", () => {
  test.use({ seed: 40, viewport: { width: 1137, height: 749 } });
  test("opens over the conversation from the model button", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    await expect(page.locator(".turn").first()).toBeVisible();
    await pickerOverConversation(page, 1137, "chat");
  });
});

test("the model button has no caret, and the composer row is saved", async ({ page, open }) => {
  await open(); await waitReady(page);
  const button = page.locator("#modelBtn");
  await expect(button.locator(".chev")).toHaveCount(0);
  await expect(button.locator(":scope > .ic")).toHaveCount(0);
  expect(await button.evaluate(el => el.lastElementChild?.className)).toBe("picker-trigger-ctx");
  // The ctx label ends the button with the button's own padding after it, no space kept for a caret.
  const ctx = await box(button.locator(".picker-trigger-ctx")), b = await box(button);
  expect(b.x + b.width - (ctx.x + ctx.width)).toBeLessThanOrEqual(11);
  await page.locator(".composer").screenshot({ path: test.info().outputPath("composer-row.png") });
});

test("the Thinking pill keeps its size on hover and focus, so nothing beside it moves", async ({ page, open }) => {
  await open(); await waitReady(page);
  const pill = page.locator('.cf-l button[aria-label="Thinking"]');
  const at = await box(pill), model = await box(page.locator("#modelBtn")), plus = await box(page.locator("#plusBtn"));
  await pill.hover();
  await page.waitForTimeout(450);
  expect(await box(pill), "hover").toEqual(at);
  await page.locator(".composer").screenshot({ path: test.info().outputPath("thinking-pill-hover.png") });
  await page.mouse.move(5, 5);
  await pill.focus();
  expect(await box(pill), "focus").toEqual(at);
  expect(await box(page.locator("#modelBtn"))).toEqual(model);
  expect(await box(page.locator("#plusBtn"))).toEqual(plus);
  await expect(pill).toHaveAttribute("data-tip", /Thinking (on|off)/);
});

/** The y of the reply's answer in each frame for `ms` after `act`. */
async function framesAfter(page: Page, act: () => Promise<void>, ms = 500): Promise<number[]> {
  await page.evaluate(span => {
    const w = window as unknown as { glFrames: number[]; glFramesDone: boolean };
    w.glFrames = []; w.glFramesDone = false;
    const md = [...document.querySelectorAll(".turn.a .md")].at(-1)!;
    const start = performance.now();
    const tick = () => {
      w.glFrames.push(md.getBoundingClientRect().top);
      if (performance.now() - start < span) requestAnimationFrame(tick); else w.glFramesDone = true;
    };
    requestAnimationFrame(tick);
  }, ms);
  await act();
  await expect.poll(() => page.evaluate(() => (window as unknown as { glFramesDone: boolean }).glFramesDone)).toBe(true);
  return page.evaluate(() => (window as unknown as { glFrames: number[] }).glFrames);
}

test("a reply's thinking opens and closes with one ease, never one jump; instantly with reduced motion", async ({ page, open }) => {
  await open(); await waitReady(page);
  await sendMessage(page, "Tell me about cron");
  const reply = page.locator(".turn.a").last();
  await expect(reply).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  const think = reply.locator("button.think");
  const opening = await framesAfter(page, () => think.click());
  await expect(reply.locator(".think-body")).toBeVisible();
  const travel = opening.at(-1)! - opening[0]!;
  const steps = opening.slice(1).map((y, i) => y - opening[i]!);
  await test.info().attach("think-open-frames", { body: JSON.stringify(opening.map(y => Math.round(y * 10) / 10)), contentType: "application/json" });
  expect(travel, "the answer moves down by the reasoning's height").toBeGreaterThan(20);
  expect(Math.max(...steps), "no single frame carries most of the move").toBeLessThan(travel * 0.5);
  expect(steps.filter(s => s > 0.5).length, "the move spans several frames").toBeGreaterThanOrEqual(4);
  const closing = await framesAfter(page, () => think.click());
  const back = closing[0]! - closing.at(-1)!;
  const up = closing.slice(1).map((y, i) => closing[i]! - y);
  expect(back).toBeGreaterThan(20);
  expect(Math.max(...up)).toBeLessThan(back * 0.5);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const instant = await framesAfter(page, () => think.click(), 300);
  const jumps = instant.slice(1).map((y, i) => y - instant[i]!).filter(s => Math.abs(s) > 0.5);
  expect(instant.at(-1)! - instant[0]!, "reduced motion: it still opens").toBeGreaterThan(20);
  expect(jumps.length, "reduced motion: the whole move lands in one frame").toBe(1);
  // A long unbroken string in the reasoning wraps instead of being cut off at the side.
  const body = reply.locator(".think-body");
  await body.evaluate(el => { el.textContent = `See https://example.com/${"a1b2c3d4".repeat(40)} and sha256:${"0f".repeat(64)}`; });
  const fits = await body.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(fits.scroll, "nothing is cut off sideways").toBeLessThanOrEqual(fits.client);
});

test.describe("first-run model card", () => {
  test.use({ skipFirstRun: false });
  test("closed Details add no height (as before the ease), and an open one wraps a long model tag", async ({ page, open }) => {
    await open();
    await expect(page.getByRole("heading", { name: "Ready to chat" })).toBeVisible();
    const card = page.locator(".fr-card").first();
    const closed = (await box(card)).height;
    // Before the ease a closed body was display:none. Measure the card that way in the same render.
    const asBase = await card.evaluate(el => {
      const b = el.querySelector<HTMLElement>(".think-body")!;
      b.style.display = "none";
      const h = el.getBoundingClientRect().height;
      b.style.display = "";
      return h;
    });
    expect(closed, "a closed card is as tall as it was with the body removed").toBe(asBase);
    await card.locator(".mono").first().evaluate(el => { el.textContent = `hf.co/someone/${"very-long-model-name-".repeat(8)}GGUF:Q4_K_M`; });
    await card.getByRole("button", { name: "Details" }).click();
    const details = card.locator(".think-body");
    await expect(details).toBeVisible();
    await expect.poll(() => details.evaluate(el => getComputedStyle(el).marginTop)).toBe("4px");
    await page.waitForTimeout(300);
    const fits = await details.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(fits.scroll, "the long tag wraps inside the card").toBeLessThanOrEqual(fits.client);
  });
});

async function chooseFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator("#plusBtn").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#plusMenu [data-attach]").click();
  await (await chooser).setFiles(files);
}

test("Attach a file opens the chooser; an image becomes a chip and a document is refused at its chip", async ({ page, open }) => {
  await open(); await waitReady(page);
  await chooseFiles(page, [{ name: "shot.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") }]);
  await expect(page.locator(".att img")).toHaveCount(1);
  await chooseFiles(page, [{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("some notes\n") }]);
  const chip = page.locator(".att .attachment.file");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("notes.txt");
  await expect(chip).toHaveAttribute("data-tip", /Library/);
  await expect(chip.getByRole("button", { name: /Add .* to your Library/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("aria-disabled", "true");
  await page.locator(".composer").screenshot({ path: test.info().outputPath("attach-chips.png") });
  await chip.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(chip).toHaveCount(0);
  // The image is a draft attachment like a pasted one: it survives a reload.
  await page.reload(); await waitReady(page);
  await expect(page.locator(".att img")).toHaveCount(1);
});

/** Dispatch a drag of `files` (or only text) over `selector` and report whether the page claimed it. */
function drag(page: Page, selector: string, type: "dragenter" | "dragover" | "drop" | "dragleave", input: { png?: number; text?: string }) {
  return page.evaluate(({ at, kind, what, png }) => {
    const data = new DataTransfer();
    for (let i = 0; i < (what.png ?? 0); i++) data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], `drop-${i}.png`, { type: "image/png" }));
    if (what.text !== undefined) data.setData("text/plain", what.text);
    const target = document.querySelector(at)!;
    const r = target.getBoundingClientRect();
    const event = new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, relatedTarget: null });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, { at: selector, kind: type, what: input, png: PNG });
}

test("dragging files over the window shows one marker and a drop attaches them without leaving the app", async ({ page, open }) => {
  await open(); await waitReady(page);
  const url = page.url();
  const marker = page.getByRole("status").filter({ hasText: "Drop files to attach" });
  // A text drag is not a file drag: nothing new happens.
  expect(await drag(page, "#ta", "dragover", { text: "words" }), "text drag stays native").toBe(false);
  await expect(marker).toHaveCount(0);
  expect(await drag(page, "body", "dragenter", { png: 1 })).toBe(true);
  expect(await drag(page, "body", "dragover", { png: 1 }), "a file drag is claimed, so the window never opens the file").toBe(true);
  await expect(marker).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("drop-marker.png") });
  expect(await drag(page, "body", "dragleave", { png: 1 })).toBe(true);
  await expect(marker).toHaveCount(0);
  expect(await drag(page, "#ta", "dragover", { png: 2 })).toBe(true);
  await expect(marker).toBeVisible();
  expect(await drag(page, "#ta", "drop", { png: 2 }), "a drop on the message box is claimed too").toBe(true);
  await expect(marker).toHaveCount(0);
  await expect(page.locator(".att img")).toHaveCount(2);
  // A drop anywhere else in the window attaches as well.
  expect(await drag(page, ".sb", "drop", { png: 1 })).toBe(true);
  await expect(page.locator(".att img")).toHaveCount(3);
  expect(page.url()).toBe(url);
});

/** Claim, marker and attach for one file drag while the composer cannot be used. */
async function dropIgnored(page: Page, why: string) {
  const marker = page.getByRole("status").filter({ hasText: "Drop files to attach" });
  expect(await drag(page, "body", "dragenter", { png: 1 }), `${why}: still claimed`).toBe(true);
  expect(await drag(page, "body", "dragover", { png: 1 }), `${why}: still claimed`).toBe(true);
  await page.waitForTimeout(100);
  await expect(marker, `${why}: no marker`).toHaveCount(0);
  expect(await drag(page, "body", "drop", { png: 1 }), `${why}: the window never opens the file`).toBe(true);
}

test.describe("a drop while the composer cannot be used", () => {
  test.use({ skipFirstRun: false });
  test("under the first-run cover, with the picker open: claimed, no marker, nothing attached", async ({ page, open }) => {
    await open();
    await expect(page.getByRole("heading", { name: "Ready to chat" })).toBeVisible();
    await dropIgnored(page, "first run");
    await page.getByRole("button", { name: "Start chatting" }).click();
    await waitReady(page);
    await expect(page.locator(".att img"), "nothing reached the draft under the cover").toHaveCount(0);
    // T3 Code neither closes a popover on drop nor checks for one; here an open popover owns the window.
    await page.locator("#modelBtn").click();
    await expect(page.locator("#picker")).toHaveClass(/\bopen\b/);
    await dropIgnored(page, "picker open");
    await expect(page.locator("#picker"), "the picker stays open").toHaveClass(/\bopen\b/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".att img")).toHaveCount(0);
  });
});

test.describe("a drop with the thread drawer open", () => {
  test.use({ viewport: { width: 900, height: 749 } });
  test("is claimed, shows nothing and attaches nothing", async ({ page, open }) => {
    await open(); await waitReady(page);
    await page.getByRole("button", { name: "Open threads" }).click();
    await expect(page.locator("main.main")).toHaveAttribute("inert", "");
    await dropIgnored(page, "drawer open");
    await page.keyboard.press("Escape");
    await expect(page.locator("main.main")).not.toHaveAttribute("inert", "");
    await expect(page.locator(".att img")).toHaveCount(0);
  });
});

test("dragging an image that is already in the page attaches nothing; a file drag after it still does", async ({ page, open }) => {
  await open(); await waitReady(page);
  await chooseFiles(page, [{ name: "shot.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") }]);
  await expect(page.locator(".att img")).toHaveCount(1);
  const marker = page.getByRole("status").filter({ hasText: "Drop files to attach" });
  // Chromium lists "Files" for a drag of an image in the page; it starts with a dragstart in the window.
  const inPage = await page.locator(".att img").evaluate((img, png) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
    img.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data, bubbles: true, cancelable: true }));
    const ta = document.querySelector("#ta")!;
    const over = new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true });
    ta.dispatchEvent(over);
    const drop = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
    ta.dispatchEvent(drop);
    img.dispatchEvent(new DragEvent("dragend", { dataTransfer: data, bubbles: true }));
    return { over: over.defaultPrevented, drop: drop.defaultPrevented };
  }, PNG);
  expect(inPage, "an in-page drag is left to the browser").toEqual({ over: false, drop: false });
  await expect(marker).toHaveCount(0);
  await page.waitForTimeout(200);
  await expect(page.locator(".att img"), "no duplicate").toHaveCount(1);
  expect(await drag(page, "#ta", "dragover", { png: 1 })).toBe(true);
  await expect(marker).toBeVisible();
  expect(await drag(page, "#ta", "drop", { png: 1 })).toBe(true);
  await expect(page.locator(".att img")).toHaveCount(2);
});

test("an empty image is refused at its chip, and the chip's reason reaches the keyboard and screen readers", async ({ page, open }) => {
  await open(); await waitReady(page);
  await chooseFiles(page, [{ name: "blank.png", mimeType: "image/png", buffer: Buffer.alloc(0) }]);
  const chip = page.locator(".att .attachment.file");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("blank.png");
  await expect(chip.getByRole("button", { name: /to your Library/ }), "the Library cannot fix an empty file").toHaveCount(0);
  const remove = chip.getByRole("button", { name: "Remove blank.png" });
  await expect(remove).toHaveAccessibleDescription(/blank\.png is empty/);
  await expect(page.locator(".att img")).toHaveCount(0);
  expect(await chip.evaluate(el => [...el.querySelectorAll("*")].filter(n => n.children.length === 0 && (n.textContent ?? "").trim() !== "" && n.getClientRects().length > 0 && getComputedStyle(n).clipPath === "none").map(n => n.textContent).join("|")), "no new visible words").toBe("blank.png|0 B · not sent|×");
  await remove.click();
  await chooseFiles(page, [{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("some notes\n") }]);
  await expect(chip.getByRole("button", { name: "Remove notes.txt" })).toHaveAccessibleDescription(/cannot be sent/);
  await expect(chip.getByRole("button", { name: "Add notes.txt to your Library" })).toHaveAccessibleDescription(/cannot be sent/);
});

test.describe("a refused file and the send paths", () => {
  test("blocks Enter, the send button and the queue while a reply runs; the Send tooltip says why", async ({ page, open }) => {
    await open(); await waitReady(page);
    await chooseFiles(page, [{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("some notes\n") }]);
    await expect(page.locator(".att .attachment.file")).toHaveCount(1);
    const ta = page.locator("#ta");
    await ta.fill("Read my notes");
    const send = page.getByRole("button", { name: "Send message" });
    await expect(send).toHaveAttribute("aria-disabled", "true");
    await expect(send).toHaveAttribute("data-tip", /Remove the file marked not sent first/);
    await ta.press("Enter");
    await send.click({ force: true });
    await page.waitForTimeout(300);
    await expect(ta, "Enter and the button sent nothing").toHaveValue("Read my notes");
    await expect(page.locator(".turn.u")).toHaveCount(0);
    // While a reply runs, Enter would queue: the refused file holds that too.
    await page.locator(".att .attachment.file").getByRole("button", { name: "Remove notes.txt" }).click();
    await stack.scenario("slow-drip", { tokenDelayMs: 60, firstTokenDelayMs: 0 });
    await ta.fill("Start a long reply");
    await ta.press("Enter");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await chooseFiles(page, [{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("some notes\n") }]);
    await ta.fill("Then read my notes");
    await ta.press("Enter");
    await page.waitForTimeout(300);
    await expect(page.locator(".qt-r"), "nothing queued").toHaveCount(0);
    await expect(ta).toHaveValue("Then read my notes");
    await expect(page.getByRole("button", { name: "Stop" }), "the reply keeps running").toBeVisible();
  });

  test("refused chips stay with their own thread across a thread switch", async ({ page, open }) => {
    await open(); await waitReady(page);
    await sendMessage(page, "First chat");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 15_000 });
    await page.getByRole("button", { name: "New thread" }).click();
    await sendMessage(page, "Second chat");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 15_000 });
    await chooseFiles(page, [{ name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("b\n") }]);
    const chips = page.locator(".att .attachment.file");
    await expect(chips).toHaveText(/second\.txt/);
    await page.locator(".sb-row", { hasText: "First chat" }).click();
    await expect(chips).toHaveCount(0);
    await chooseFiles(page, [{ name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("a\n") }]);
    await expect(chips).toHaveCount(1);
    await expect(chips).toHaveText(/first\.txt/);
    await page.locator(".sb-row", { hasText: "Second chat" }).click();
    await expect(chips).toHaveCount(1);
    await expect(chips).toHaveText(/second\.txt/);
  });
});

// ---------------------------------------------------------------- the Gemma mark, three candidates

const MARKS: Record<string, string[]> = {
  "before (Lobe Icons gemma)": [
    "M12.34 5.953a8.233 8.233 0 01-.247-1.125V3.72a8.25 8.25 0 015.562 2.232H12.34zm-.69 0c.113-.373.199-.755.257-1.145V3.72a8.25 8.25 0 00-5.562 2.232h5.304zm-5.433.187h5.373a7.98 7.98 0 01-.267.696 8.41 8.41 0 01-1.76 2.65L6.216 6.14zm-.264-.187H2.977v.187h2.915a8.436 8.436 0 00-2.357 5.767H0v.186h3.535a8.436 8.436 0 002.357 5.767H2.977v.186h2.976v2.977h.187v-2.915a8.436 8.436 0 005.767 2.357V24h.186v-3.535a8.436 8.436 0 005.767-2.357v2.915h.186v-2.977h2.977v-.186h-2.915a8.436 8.436 0 002.357-5.767H24v-.186h-3.535a8.436 8.436 0 00-2.357-5.767h2.915v-.187h-2.977V2.977h-.186v2.915a8.436 8.436 0 00-5.767-2.357V0h-.186v3.535A8.436 8.436 0 006.14 5.892V2.977h-.187v2.976zm6.14 14.326a8.25 8.25 0 005.562-2.233H12.34c-.108.367-.19.743-.247 1.126v1.107zm-.186-1.087a8.015 8.015 0 00-.258-1.146H6.345a8.25 8.25 0 005.562 2.233v-1.087zm-8.186-7.285h1.107a8.23 8.23 0 001.125-.247V6.345a8.25 8.25 0 00-2.232 5.562zm1.087.186H3.72a8.25 8.25 0 002.232 5.562v-5.304a8.012 8.012 0 00-1.145-.258zm15.47-.186a8.25 8.25 0 00-2.232-5.562v5.315c.367.108.743.19 1.126.247h1.107zm-1.086.186c-.39.058-.772.144-1.146.258v5.304a8.25 8.25 0 002.233-5.562h-1.087zm-1.332 5.69V12.41a7.97 7.97 0 00-.696.267 8.409 8.409 0 00-2.65 1.76l3.346 3.346zm0-6.18v-5.45l-.012-.013h-5.451c.076.235.162.468.26.696a8.698 8.698 0 001.819 2.688 8.698 8.698 0 002.688 1.82c.228.097.46.183.696.259zM6.14 17.848V12.41c.235.078.468.167.696.267a8.403 8.403 0 012.688 1.799 8.404 8.404 0 011.799 2.688c.1.228.19.46.267.696H6.152l-.012-.012zm0-6.245V6.326l3.29 3.29a8.716 8.716 0 01-2.594 1.728 8.14 8.14 0 01-.696.259zm6.257 6.257h5.277l-3.29-3.29a8.716 8.716 0 00-1.728 2.594 8.135 8.135 0 00-.259.696zm-2.347-7.81a9.435 9.435 0 01-2.88 1.96 9.14 9.14 0 012.88 1.94 9.14 9.14 0 011.94 2.88 9.435 9.435 0 011.96-2.88 9.14 9.14 0 012.88-1.94 9.435 9.435 0 01-2.88-1.96 9.434 9.434 0 01-1.96-2.88 9.14 9.14 0 01-1.94 2.88z",
  ],
  // A: the same mark with its fine lines dropped: one ring and the centre spark, scaled up.
  "A: Gemma simplified": [
    "M12 1.25a10.75 10.75 0 1 0 0 21.5a10.75 10.75 0 1 0 0-21.5zm0 2.1a8.65 8.65 0 1 1 0 17.3a8.65 8.65 0 1 1 0-17.3z",
    "M12 5.6c.5 3.3 3.1 5.9 6.4 6.4c-3.3.5-5.9 3.1-6.4 6.4c-.5-3.3-3.1-5.9-6.4-6.4c3.3-.5 5.9-3.1 6.4-6.4z",
  ],
  // B: Lobe Icons gemini.svg at the same pinned commit, unchanged.
  "B: Google spark, Lobe Icons gemini (shipped)": [
    "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z",
  ],
  // C: drawn here, a faceted four-point spark with straight edges.
  "C: drawn faceted spark": [
    "M12 1.5l2.6 7.9 7.9 2.6-7.9 2.6-2.6 7.9-2.6-7.9-7.9-2.6 7.9-2.6z",
  ],
};

const cell = (d: string[], px: number) => `<span class="m" style="width:${px}px;height:${px}px"><svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="currentColor" fill-rule="evenodd">${d.map(p => `<path d="${p}"/>`).join("")}</svg></span>`;

test("the Gemma mark candidates side by side at 14, 16 and 18 px and at 4x", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 400 });
  const sizes = [14, 16, 18];
  await page.setContent(`<style>body{margin:0;background:#171717;color:#ededed;font:14px system-ui}.r{display:flex;gap:24px;align-items:center;padding:6px 12px}.m{display:inline-flex}</style>
    ${Object.entries(MARKS).map(([name, d], i) => `<div class="r" data-row="${i}">${sizes.map(px => `<span data-px="${px}">${cell(d, px)}</span>`).join("")}<span class="chip" style="display:inline-flex;gap:6px;align-items:center;padding:4px 10px;border-radius:6px;background:#262626">${cell(d, 16)}Gemma 4 12B</span><span>${name}</span></div>`).join("")}`);
  const shots: { name: string; real: string[]; chip: string }[] = [];
  for (const [i, name] of Object.keys(MARKS).entries()) {
    const row = page.locator(`[data-row="${i}"]`);
    const real: string[] = [];
    for (const px of sizes) real.push((await row.locator(`[data-px="${px}"] .m`).screenshot()).toString("base64"));
    shots.push({ name, real, chip: (await row.locator(".chip").screenshot()).toString("base64") });
  }
  await page.setViewportSize({ width: 1100, height: 120 * shots.length + 40 });
  await page.setContent(`<style>body{margin:0;padding:12px;background:#171717;color:#ededed;font:13px system-ui}.r{display:flex;gap:20px;align-items:center;height:116px;border-bottom:1px solid #333}.z{image-rendering:pixelated}.n{width:220px}</style>
    ${shots.map(s => `<div class="r"><span class="n">${s.name}</span>${s.real.map(b => `<img src="data:image/png;base64,${b}">`).join("")}<img src="data:image/png;base64,${s.chip}">${s.real.map((b, k) => `<img class="z" style="width:${sizes[k]! * 4}px" src="data:image/png;base64,${b}">`).join("")}</div>`).join("")}`);
  await page.screenshot({ path: test.info().outputPath("gemma-marks.png"), fullPage: true });
});
