/// <reference lib="dom" />
// A reply's thinking time leaves out the model's load (owner, chat row 21),
// and the model button shows the load (row 16): a 2 px bar on its bottom edge
// that fills over this machine's last load of that model, or, the first time,
// a moving line and seconds counting. Shots are taken before the asserts so a
// failing run still shows what was on screen.
import { writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";
import { configure, pick, state } from "./threads-support.ts";

const MODEL = "qwen3.5:9b";

/** A full-page shot and the model button's box, for outlining. */
async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  const reply = page.locator(".turn.a").last();
  writeFileSync(info.outputPath(`${name}.json`), JSON.stringify({ button: await page.locator("#modelBtn").boundingBox(), reply: (await reply.count()) === 0 ? null : await reply.boundingBox() }));
}

// Guards the owner's rulings (chat rows 21 and 16): thinking time leaves out the load, and the model button shows it.
test("a 5 s load and 2 s of thinking say Thought for 2 s, and the model button shows the load", async ({ page, open }, info) => {
  test.setTimeout(60_000);
  test.info().annotations.push({ type: "budget", description: "Two fake 5 s cold loads: a first, unmeasured one from the picker, then a measured one under a reply that thinks for 2 s." });
  await open(); await waitReady(page);
  const btn = page.locator("#modelBtn");
  // the first load this browser sees has no time to aim at: the line moves and the seconds count
  await configure({ loadDelayMs: 5000 });
  await pick(page, MODEL);
  await page.waitForTimeout(2000);
  await shot(page, info, "first-load");
  await expect.soft(btn.locator(".ldbar.wait")).toBeVisible();
  await expect.soft(btn.locator(".picker-trigger-ctx")).toHaveText(/^\d+ s$/);
  await expect.poll(async () => (await state()).loaded.map((m) => m.name), { timeout: 15_000 }).toContain(MODEL);
  await expect(btn.locator(".ldbar")).toHaveCount(0);

  // a cold reply: 5 s of load, then 19 thinking tokens 105 ms apart, about 2 s of thinking
  await configure({ loadDelayMs: 5000, tokenDelayMs: 105 });
  await sendMessage(page, "Why is the sky blue");
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator(".working .ph")).toHaveText(/^Loading into/);
  await page.waitForTimeout(2000);
  await shot(page, info, "measured-load");
  // the second load knows the first: it fills toward 90% with the last time beside the name
  await expect.soft(btn.locator(".ldbar:not(.wait)")).toBeVisible();
  await expect.soft(btn.locator(".picker-trigger-ctx")).toHaveText(/^~\d+ s$/);
  await expect(reply).toHaveClass(/\bdone\b/, { timeout: 30_000 });
  await shot(page, info, "thought");
  await expect(reply.locator("button.think").getByText(/^Thought for \d+ s$/)).toHaveText("Thought for 2 s");
});
