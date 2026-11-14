/// <reference lib="dom" />
// The live line ("Writing" with the breathing dot, decisions 1 and 33) sits above a streaming
// reply and holds still (owner, chat row 30: "the blinking Writing text should be above instead
// of below. I think that is how t3 code does it").
// Every frame of one streamed reply is sampled: the line's top and the text's top. The line
// stays above the text at one place while the text grows under it, and the text does not move
// when the label leaves. The run is recorded for the before and after.
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";
import { INSTALLED, configure, pick } from "./threads-support.ts";

test.use({ installed: INSTALLED, video: { mode: "on", size: { width: 1440, height: 900 } } });

interface Frame { readonly label: number | null; readonly labelBottom: number | null; readonly text: number | null; readonly chars: number }

test("Writing sits above the streaming reply and holds still, and the text stays put when it leaves", async ({ page, open }) => {
  test.info().annotations.push({ type: "budget", description: "One reply of 80 words at 60 ms a word, sampled every frame, so the recording shows the whole stream." });
  await open(); await waitReady(page);
  await configure({ tokenDelayMs: 60 });
  await pick(page, "tiny-chat:2k");
  // every frame from the send to well after the reply is saved
  await page.evaluate(() => {
    const frames: Frame[] = [];
    (window as unknown as { wrFrames: Frame[] }).wrFrames = frames;
    const tick = () => {
      // measured from the top of the timeline's column, so following the reply down does not count as a move
      const top = document.querySelector(".col")?.getBoundingClientRect().top ?? 0;
      const reply = [...document.querySelectorAll(".turn.a")].at(-1);
      const label = reply?.querySelector(".think.run")?.getBoundingClientRect();
      const text = reply?.querySelector(".md")?.getBoundingClientRect();
      frames.push({ label: label === undefined ? null : label.top - top, labelBottom: label === undefined ? null : label.bottom - top, text: text === undefined ? null : text.top - top, chars: reply?.querySelector(".md")?.textContent?.length ?? 0 });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await sendMessage(page, "Write a paragraph on climate change");
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator(".think.run")).toBeVisible();
  await expect(reply).toHaveClass(/\bdone\b/, { timeout: 30_000 });
  await page.waitForTimeout(600);
  const frames = await page.evaluate(() => (window as unknown as { wrFrames: Frame[] }).wrFrames);
  const writing = frames.filter((f) => f.label !== null && f.text !== null);
  expect(writing.length, "frames with Writing and text both on screen").toBeGreaterThan(20);
  // above: the label ends before the reply's first line starts, on every frame
  expect(writing.filter((f) => (f.labelBottom ?? 0) > (f.text ?? 0) + 0.5).length, "frames where Writing is not above the text").toBe(0);
  // still: one place for the label while the text grows from a few words to the whole reply
  expect(new Set(writing.map((f) => Math.round(f.label ?? 0))).size, "places the label took").toBe(1);
  expect((writing.at(-1)?.chars ?? 0) - (writing[0]?.chars ?? 0), "the text grew under the label").toBeGreaterThan(200);
  // the text's first line never moves, before or after the label leaves
  const textTops = new Set(frames.filter((f) => f.text !== null).map((f) => Math.round(f.text ?? 0)));
  expect([...textTops], "places the text's first line took").toHaveLength(1);
  expect(frames.at(-1)?.label, "Writing has left").toBeNull();
});
