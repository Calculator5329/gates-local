/// <reference lib="dom" />
// A message queued behind the first model download says so once, and the model button keeps
// its name and its width (owner, chat row 29: "ewww" at a 1600 px window on 0.2.1). The
// placeholder said "Type now; it sends when the download finishes", the queue row "After
// download", and the button "Qwen 3.5 9B · downloadin…". Every frame from the send to the
// message going out is sampled for the button's width and whether its words fit.
import { writeFileSync } from "node:fs";
import { CONTROL_URL } from "./env.ts";
import { expect, sendMessage, test } from "./fixtures.ts";

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
