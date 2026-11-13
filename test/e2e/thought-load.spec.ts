/// <reference lib="dom" />
// A reply's thinking time leaves out the model's load (owner, chat row 21),
// and the load is shown where the wait is (owner's pick D, 2026-11-13, after
// "doing too much" on the model button): the model button never changes, and
// a ring fills around the composer's main button only while a message waits
// for the load, over this machine's last load of that model or, the first
// time, as a turning arc. Shots are taken before the asserts so a failing run
// still shows what was on screen.
import { writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";
import { configure, pick, state } from "./threads-support.ts";

const MODEL = "qwen3.5:9b";

/** A full-page shot and the model button's box, for outlining. */
async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  const reply = page.locator(".turn.a").last();
  writeFileSync(info.outputPath(`${name}.json`), JSON.stringify({ button: await page.locator("#modelBtn").boundingBox(), send: await page.locator("button.send").boundingBox(), reply: (await reply.count()) === 0 ? null : await reply.boundingBox() }));
}

// Guards the owner's rulings (chat rows 21 and 34): thinking time leaves out the load, and the load is a ring on Send while a message waits.
test("a 5 s load and 2 s of thinking say Thought for 2 s, and the load is a ring on Send only while a message waits", async ({ page, open }, info) => {
  test.setTimeout(60_000);
  test.info().annotations.push({ type: "budget", description: "Two fake 5 s cold loads: a first, unmeasured one from the picker, then a measured one under a reply that thinks for 2 s." });
  await open(); await waitReady(page);
  const btn = page.locator("#modelBtn");
  const send = page.locator("button.send");
  const face = () => btn.evaluate((el) => el.innerHTML);
  const idle = await face();
  // a load nobody is waiting on, a model just picked: nothing on screen moves
  await configure({ loadDelayMs: 5000 });
  await pick(page, MODEL);
  await page.waitForTimeout(2000);
  await shot(page, info, "first-load");
  expect.soft((await state()).loaded.map((m) => m.name), "still loading when looked at").not.toContain(MODEL);
  expect.soft(await face(), "the model button's face is as it was before the load").toBe(idle);
  await expect.soft(send.locator(".ldring")).toHaveCount(0);
  await expect.poll(async () => (await state()).loaded.map((m) => m.name), { timeout: 15_000 }).toContain(MODEL);

  // a cold reply: 5 s of load, then 19 thinking tokens 105 ms apart, about 2 s of thinking
  await configure({ loadDelayMs: 5000, tokenDelayMs: 105 });
  await sendMessage(page, "Why is the sky blue");
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator(".working .ph")).toHaveText(/^Loading into/);
  await page.waitForTimeout(2000);
  await shot(page, info, "measured-load");
  // a message is waiting: the ring is on the button being waited on, filling over the first load's time
  await expect.soft(send.locator(".ldring:not(.wait)")).toBeVisible();
  expect.soft(await face(), "the model button's face is as it was").toBe(idle);
  await expect.soft(btn).toHaveAttribute("data-tip", /Loading into (GPU )?memory, ~\d+ s$/);
  await expect(reply).toHaveClass(/\bdone\b/, { timeout: 30_000 });
  await expect(send.locator(".ldring")).toHaveCount(0);
  await shot(page, info, "thought");
  await expect(reply.locator("button.think").getByText(/^Thought for \d+ s$/)).toHaveText("Thought for 2 s");
});
