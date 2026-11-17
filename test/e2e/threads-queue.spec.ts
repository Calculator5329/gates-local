import type { Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { INSTALLED, configure, finished, pick, release, shot, start, state } from "./threads-support.ts";
import { holds } from "./waits.ts";

test.use({ installed: INSTALLED, screenshot: "only-on-failure" });

// Guards the owner's ruling (chat row 23) at its edge: a stopped reply is never retried; its queued words wait for Send now.
test("same-thread queue: stop holds queued words until Send now, and the stopped reply is not retried", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28 } } });
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await sendMessage(page, "beta");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".qt-r .qt-s")).toHaveText("On hold");
  expect((await state()).turns.map((t) => t.prompt)).toEqual(["alpha"]);
  await shot(page, "queue-stop-held");
  await page.locator("[data-send-now]").click();
  await finished(page, "beta");
  await expect(page.locator(".turn.a.interrupted")).toHaveCount(1);
  expect((await state()).turns.map((t) => t.prompt)).toEqual(["alpha", "beta"]);
});

// Guards the owner's ruling (chat row 23): "I think we try to resume previous message once instead of
// sending the queued." A failed reply with a message queued behind it is retried once, on its own.
test("same-thread queue: a failed reply is retried once, then the queued message sends", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28, errorAfterTokens: 40, errorReplies: 1 } } });
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await sendMessage(page, "beta");
  await release("alpha");
  // the retry is held at the same place; the queued message waits and says why
  await expect.poll(async () => (await state()).turns.map((t) => t.prompt)).toEqual(["alpha", "alpha"]);
  await expect(page.locator(".qt-r .qt-s")).toHaveText("Retrying the reply before it");
  await shot(page, "queue-retrying");
  await release("alpha");
  await finished(page, "beta", 2);
  await expect(page.locator(".turn.a.interrupted")).toHaveCount(0);
  await expect(page.locator(".turn.u")).toHaveCount(2);
  expect((await state()).turns.map((t) => [t.prompt, t.outcome])).toEqual([["alpha", "error"], ["alpha", "done"], ["beta", "done"]]);
});

// Guards the owner's ruling (chat row 23) and his report that the sidebar still said working after the error.
test("same-thread queue: a reply that fails again is not retried twice; the queue holds with the reason and no working dot", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28, errorAfterTokens: 40 } } });
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await sendMessage(page, "beta");
  await release("alpha");
  await expect.poll(async () => (await state()).turns.map((t) => t.prompt)).toEqual(["alpha", "alpha"]);
  await release("alpha");
  await expect(page.locator(".qt-r .qt-s")).toHaveText("On hold: the reply before it didn't finish");
  await expect(page.locator(".turn.a.interrupted")).toHaveCount(1);
  // owner: "after it errored out the left sidebar still said working"
  await expect(page.locator(".sb-row .live")).toHaveCount(0);
  await holds(page, 500, async () => (await state()).turns.map((t) => [t.prompt, t.outcome]), [["alpha", "error"], ["alpha", "error"]], { message: "nothing is asked a third time" });
  await shot(page, "queue-retry-failed");
  await page.locator("[data-send-now]").click();
  await finished(page, "beta");
  expect((await state()).turns.map((t) => t.prompt)).toEqual(["alpha", "alpha", "beta"]);
});

const BIG = "qwen3.5:9b";
const WORDS = "Summarise this chat";
const loaded = async () => (await state()).loaded.map((m) => m.name);
/** Each waiting row of the open chat: its words and what it says of itself. */
const waiting = (page: Page) => page.locator(".qt-r").evaluateAll((trays) => trays.map((r) => [r.querySelector(".qt-t")?.textContent ?? "", r.querySelector(".qt-s")?.textContent ?? ""]));
const REFUSED = [[WORDS, "On hold: not enough memory"]];

// Guards the one send call: a send the server refuses before it starts is the server's record, on
// hold with its reason, so every window shows it and any window can send it.
test("a send refused for memory is one on-hold row with its reason in both windows, and goes once a smaller context is chosen in the second", async ({ page, open, context }) => {
  // window 1 keeps the memory table it read: the computer changes after it, as when another
  // program takes memory between a look at the table and a press of Send
  let stale = false;
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { type?: string; channel?: string };
      if (!(stale && frame.type === "push" && frame.channel === "fit.changed")) ws.send(message);
    });
  });
  await open(); await waitReady(page);
  await configure();
  await start(page, "alpha");
  await finished(page, "alpha");
  // the pick and the first key typed each load the model; the fake GPU is emptied once both have
  // landed, so the send has a load to plan (the order queued-thread.spec.ts explains)
  const scenario = { prompts: { [WORDS]: { holdAfterTokens: 5 } } };
  await pick(page, BIG);
  await expect.poll(loaded).toContain(BIG);
  await configure(scenario);
  await page.locator("#ta").fill(WORDS);
  await expect.poll(loaded, "the first key typed loads the model").toContain(BIG);
  // a 10 GB card and 5.9 GB of system memory (refusal-offer.spec.ts): this model no longer runs at 16k, and does at 8k
  stale = true;
  await configure(scenario);
  await stack.computer(5.9);
  await stack.gpu(0, 10171);
  expect(await loaded(), "the send finds the fake GPU empty").not.toContain(BIG);
  await page.locator("#ta").press("Enter");

  // one row, on hold, saying why; its words are not back in the box and the chat has no question for them
  await expect.poll(() => waiting(page)).toEqual(REFUSED);
  await expect(page.locator("#ta")).toHaveValue("");
  await expect(page.locator(".turn.u")).toHaveCount(1);
  const other = await context.newPage();
  await other.goto(page.url());
  await waitReady(other);
  await expect.poll(() => waiting(other), "the second window").toEqual(REFUSED);
  await expect(other.locator(".turn.u")).toHaveCount(1);
  expect((await state()).turns.map((t) => t.prompt), "nothing was asked of the model since the scenario was set").toEqual([]);
  await shot(other, "refused-send-held");

  // the smaller context the refusal offers, taken on the row in the second window, then Send now
  const smaller = other.getByTestId("chat.queue.offer-context-1");
  await expect(smaller).toHaveText("8k");
  await smaller.click();
  await expect(smaller).toHaveAttribute("aria-pressed", "true");
  await other.getByTestId("chat.queue.send-now-1").click();
  // both windows show it starting: the row is the chat's question, and its reply is being written
  for (const w of [page, other]) {
    await expect(w.locator(".qt-r")).toHaveCount(0);
    await expect(w.locator(".turn.u")).toHaveCount(2);
    await expect(w.locator(".turn.a:not(.done)")).toHaveCount(1);
  }
  await expect.poll(async () => (await state()).turns.at(-1)).toMatchObject({ prompt: WORDS, model: BIG, numCtx: 8192 });
  await release(WORDS);
  // one question and one reply, in each
  for (const w of [page, other]) {
    await finished(w, WORDS, 2);
    await expect(w.locator(".turn.u")).toHaveCount(2);
  }
  expect((await state()).turns.map((t) => t.prompt), "asked once").toEqual([WORDS]);
  await other.close();
});
