/// <reference lib="dom" />
// A message queued behind the first model download says so once, and the model button keeps
// its name and its width (owner, chat row 29: "ewww" at a 1600 px window on 0.2.1). The
// placeholder said "Type now; it sends when the download finishes", the queue row "After
// download", and the button "Qwen 3.5 9B · downloadin…". Every frame from the send to the
// message going out is sampled for the button's width and whether its words fit.
import { writeFileSync } from "node:fs";
import { CONTROL_URL } from "./env.ts";
import { expect, sendMessage, stack, test } from "./fixtures.ts";

test.use({ scenario: "no-models", skipFirstRun: false, viewport: { width: 1600, height: 900 } });

interface Frame { readonly w: number; readonly cut: boolean; readonly text: string }

test("a message queued behind the first download says it once, and the model button keeps its name and width", async ({ page, open }, info) => {
  test.setTimeout(75_000);
  test.info().annotations.push({ type: "budget", description: "One first-model download slowed to about 18 s so every check runs while the message waits, then the reply." });
  await open();
  // a slower download than the default, so the button is watched through many percents
  const slowed = await fetch(`${CONTROL_URL}/scenario`, { method: "POST", body: JSON.stringify({ scenario: "no-models", pullTickMs: 700 }) });
  expect(slowed.ok, "the fake took the slower download").toBe(true);
  await page.getByRole("button", { name: "Download and start" }).click();
  await page.getByRole("button", { name: "Start chatting" }).click();
  const btn = page.locator("#modelBtn");
  await page.evaluate(() => {
    const frames: Frame[] = [];
    (window as unknown as { mbFrames: Frame[] }).mbFrames = frames;
    const tick = () => {
      const b = document.querySelector<HTMLElement>("#modelBtn");
      if (b !== null && document.querySelector(".qt-r") !== null) {
        const cut = [...b.querySelectorAll<HTMLElement>("span,small")].some((s) => s.scrollWidth > s.clientWidth + 0.5);
        frames.push({ w: Math.round(b.getBoundingClientRect().width * 2) / 2, cut, text: b.textContent ?? "" });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await sendMessage(page, "Hello!");
  const row = page.locator(".qt-r");
  await expect(row).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath("queued-download.png") });
  writeFileSync(info.outputPath("queued-download.json"), JSON.stringify({ button: await btn.boundingBox(), row: await row.boundingBox(), field: await page.locator("#ta").boundingBox() }));
  // said once: the queue row's clock, whose tip says when it sends; not the field, not the button
  await expect.soft(page.locator("#ta"), "the field's placeholder").toHaveAttribute("placeholder", "Ask anything…");
  await expect.soft(row.locator(".qt-s"), "the queue row's state").toHaveAttribute("data-tip", "Sends when the download finishes");
  await expect.soft(row.locator(".qt-s svg"), "the queue row's clock").toBeVisible();
  await expect.soft(btn, "the model button's words").not.toContainText(/download/i);
  await expect.soft(btn.locator(".ldbar"), "the download's bar").toBeVisible();
  await expect.soft(btn, "the download's percent, in the tip").toHaveAttribute("data-tip", /\d+%/);
  // the message goes out once the model is in, and the reply comes
  await expect(row).toHaveCount(0, { timeout: 40_000 });
  await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Hello!", { timeout: 20_000 });
  const frames = await page.evaluate(() => (window as unknown as { mbFrames: Frame[] }).mbFrames);
  expect(frames.length, "frames with the message queued").toBeGreaterThan(30);
  expect(frames.filter((f) => f.cut).map((f) => f.text).slice(0, 3), "frames whose button words were cut").toEqual([]);
  expect([...new Set(frames.map((f) => f.w))], "widths the model button took while the message waited").toHaveLength(1);
});

interface SlotFrame { readonly slot: string; readonly words: string; readonly text: string }

test.describe("at a small window", () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  // Guards the owner's ask (2026-11-14, fresh installs: "make sure the whole process [is] seamless"): a
  // stranger's first question waited with only a clock while the download's progress sat in a sidebar
  // ring whose words were hover-only. The waiting row says the percent and the time left itself, in a
  // slot whose width holds while the number grows from one digit to two.
  test("a question waiting for the first download shows its percent and time left on its own row, and nothing moves as they change", async ({ page, open }, info) => {
    test.setTimeout(90_000);
    test.info().annotations.push({ type: "budget", description: "One first-model download slowed to about 40 s so one-digit and two-digit percents are both seen, then the reply." });
    await open();
    // about one percent a tick, so the one-digit percents last a few seconds
    await stack.scenario("no-models", { pullTickMs: 400, pullChunkBytes: 64 * 1024 ** 2 });
    await page.getByRole("button", { name: "Download and start" }).click();
    await page.getByRole("button", { name: "Start chatting" }).click();
    await page.evaluate(() => {
      const frames: SlotFrame[] = [];
      (window as unknown as { slotFrames: SlotFrame[] }).slotFrames = frames;
      const tick = () => {
        const row = document.querySelector(".qt-r");
        if (row !== null) {
          const [slot = "", words = ""] = [".qt-s", ".qt-t"].map((at) => {
            const r = row.querySelector(at)?.getBoundingClientRect();
            return r === undefined ? "" : `${Math.round(r.x * 2) / 2}+${Math.round(r.width * 2) / 2}`;
          });
          frames.push({ slot, words, text: row.querySelector(".qt-s")?.textContent ?? "" });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // short, since the fake model echoes only a question's first eight words
    await sendMessage(page, "Name a grey cat?");
    const row = page.locator(".qt-r");
    await expect(row).toBeVisible();
    await page.mouse.move(5, 5);
    const numbers = row.locator(".qt-n");
    await expect(numbers, "a one-digit percent on the waiting row").toHaveText(/^[1-9]%/);
    await page.screenshot({ path: info.outputPath("row2-one-digit.png") });
    await expect(numbers, "a two-digit percent and the time left on the waiting row").toHaveText(/^[1-9]\d% · \d+ (s|min)$/, { timeout: 20_000 });
    await page.screenshot({ path: info.outputPath("row2-two-digits.png") });
    // the clock's words are still its tip and what a screen reader says
    await expect.soft(row.locator(".qt-s"), "the queue row's state").toHaveAttribute("data-tip", "Sends when the download finishes");
    await expect(row).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Name a grey cat?", { timeout: 20_000 });
    const frames = await page.evaluate(() => (window as unknown as { slotFrames: SlotFrame[] }).slotFrames);
    const counted = frames.filter((f) => /\d%/.test(f.text));
    expect(new Set(counted.map((f) => f.text.match(/\d+%/)?.[0].length)), "percents of one digit and of two were drawn").toEqual(new Set([2, 3]));
    expect([...new Set(counted.map((f) => f.slot))], "places the state slot took while the numbers changed").toHaveLength(1);
    expect([...new Set(counted.map((f) => f.words))], "places the question's words took while the numbers changed").toHaveLength(1);
  });
});
