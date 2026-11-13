/// <reference lib="dom" />
// Chat row 32: the server says how and when a reply ended, and stamps its
// times on the row, so every window and every reload shows the same seconds;
// Send answers at once, so a reply that fails before it starts is heard by
// every window, and the sidebar's working dot goes out there too. Shots are
// taken before the asserts so a failing run still shows what was on screen.
import { writeFileSync } from "node:fs";
import { createClient } from "@gates-local/contracts";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { appUrl } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { pick } from "./threads-support.ts";

const MODEL = "qwen3.5:9b";

function client(page: Page) {
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server");
  return createClient(new WebSocket(server));
}

const threadOf = (page: Page) => {
  const id = decodeURIComponent(/#thread=(.+)$/.exec(page.url())?.[1] ?? "");
  if (!id) throw new Error("No thread in the address");
  return id;
};

/** A full-page shot and the boxes of what it is about, for outlining. */
async function shot(page: Page, info: TestInfo, name: string, parts: Record<string, Locator>): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  const boxes: Record<string, unknown> = {};
  for (const [key, part] of Object.entries(parts)) boxes[key] = (await part.count()) === 0 ? null : await part.first().boundingBox();
  writeFileSync(info.outputPath(`${name}.json`), JSON.stringify(boxes));
}

const thought = (page: Page) => page.locator(".turn.a").first().locator("button.think").getByText(/^Thought for \d+ s$/);
const stopSecs = (page: Page) => page.locator(".turn.a").last().locator(".stop-mark .s");

// Guards chat row 32 (the server's times): Thought for and Stop's seconds are one number in every window and after a reload.
test("Thought for and a stopped reply's seconds are the same in a second window and after a reload", async ({ page, open, context }, info) => {
  test.setTimeout(90_000);
  await open(); await waitReady(page);
  await pick(page, MODEL);
  // about 2 s of thinking: 19 thinking tokens 105 ms apart
  await stack.scenario("models", { tokenDelayMs: 105 });
  await sendMessage(page, "Why is the sky blue");
  await expect(page.locator(".turn.a").first()).toHaveClass(/\bdone\b/, { timeout: 30_000 });
  const here = (await thought(page).innerText()).trim();
  const threadId = threadOf(page);

  const other = await context.newPage();
  await other.goto(appUrl(`#thread=${encodeURIComponent(threadId)}`));
  await waitReady(other);
  await shot(other, info, "thought-second-window", { thought: thought(other) });
  await expect(thought(other)).toHaveText(here);

  // slow words so there is time to press Stop mid-reply; the second window watches it live
  await stack.scenario("models", { tokenDelayMs: 150 });
  await sendMessage(page, "Tell me about cron");
  // until the second reply is drawn, .last() is the first one, and the waits below would pass on it
  await expect(page.locator(".turn.a")).toHaveCount(2);
  const live = page.locator(".turn.a").last();
  // Stop's own seconds show only once the thought has ended (a stop mid-thought is timed by the pill)
  await expect(live.locator("button.think").getByText(/^Thought for \d+ s$/)).toBeVisible({ timeout: 20_000 });
  await expect(live.locator(".md")).not.toBeEmpty();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(stopSecs(page)).toHaveText(/^\d+ s$/);
  await expect(page.locator(".writing")).toHaveCount(0);
  await expect(other.locator(".writing")).toHaveCount(0, { timeout: 10_000 });
  // once the saved row takes over, both windows show the server's seconds
  await expect.poll(async () => [await stopSecs(page).innerText(), await stopSecs(other).innerText()].map((s) => s.trim()), { timeout: 10_000 })
    .toEqual([expect.stringMatching(/^\d+ s$/), expect.stringMatching(/^\d+ s$/)]);
  await expect.poll(async () => (await stopSecs(other).innerText()).trim()).toBe((await stopSecs(page).innerText()).trim());
  const stopped = (await stopSecs(page).innerText()).trim();
  // Stop's seconds show while the reply is hovered (styles.css .a-act.stop .s)
  await other.locator(".turn.a").last().hover();
  await shot(other, info, "stopped-second-window", { stop: stopSecs(other) });

  await page.reload(); await waitReady(page);
  await page.locator(".turn.a").last().hover();
  await shot(page, info, "after-reload", { thought: thought(page), stop: stopSecs(page) });
  await expect(thought(page)).toHaveText(here);
  await expect(stopSecs(page)).toHaveText(stopped);
  await other.close();
});

// Guards chat row 32 (Send answers at once): a reply that fails before it starts puts out every window's working dot.
test("a reply that fails before it starts puts out the sidebar's working dot in a window that only listed it", async ({ page, open }, info) => {
  test.setTimeout(60_000);
  // a cold load holds the load gate for 6 s; a second send waits behind it and then fails
  await stack.scenario("models", { loadDelayMs: 6000 });
  await open(); await waitReady(page);
  const rpc = client(page);
  try {
    const first = await rpc.call("threads.create", { title: "Loads the model" });
    const second = await rpc.call("threads.create", { title: "Asks a missing model" });
    await rpc.call("chat.send", { threadId: first.id, content: "hello", model: MODEL, numCtx: 4096 });
    const ends: string[] = [];
    rpc.subscribe("chat.event", (p) => { if (p.threadId === second.id && p.event.type === "error") ends.push(p.event.code); });
    // answered at once, while it waits for the load gate
    await rpc.call("chat.send", { threadId: second.id, content: "hello", model: "not-installed:1b", numCtx: 4096 });
    // this window hears of both only from turns.active, at its reload
    await page.reload(); await waitReady(page);
    const dot = page.locator(".sb-row").filter({ hasText: "Asks a missing model" }).getByLabel("Reply in progress", { exact: true });
    await shot(page, info, "dot-listed", { dot });
    await expect(dot).toBeVisible();
    await expect.poll(() => ends, { timeout: 20_000 }).toHaveLength(1);
    await shot(page, info, "dot-out", { row: page.locator(".sb-row").filter({ hasText: "Asks a missing model" }) });
    await expect(dot).toHaveCount(0);
    expect((await rpc.call("threads.get", { threadId: second.id })).messages, "nothing was saved").toEqual([]);
  } finally { rpc.close(); }
});

// The coordinator's check for chat row 3: with tools off, the attached file's wrench opens Settings on Tools.
test("with tools off, an attached file's wrench opens Settings on Tools", async ({ page, open }, info) => {
  await open(); await waitReady(page);
  const rpc = client(page);
  try { await rpc.call("settings.update", { tools: false }); } finally { rpc.close(); }
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" }));
    for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  const chip = page.locator(".composer [data-testid='chat.attachment.file']");
  await expect(chip).toContainText("tools off");
  const wrench = chip.getByRole("button", { name: "Turn on tools" });
  await shot(page, info, "wrench", { wrench });
  await wrench.click();
  await expect(page.locator(".set h1").first()).toHaveText("Tools");
  await shot(page, info, "settings-tools", { title: page.locator(".set h1").first() });
});
