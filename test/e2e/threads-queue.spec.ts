import { expect, sendMessage, test, waitReady } from "./fixtures.ts";
import { INSTALLED, configure, finished, release, shot, start, state } from "./threads-support.ts";

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
  await page.waitForTimeout(500);
  expect((await state()).turns.map((t) => [t.prompt, t.outcome])).toEqual([["alpha", "error"], ["alpha", "error"]]);
  await shot(page, "queue-retry-failed");
  await page.locator("[data-send-now]").click();
  await finished(page, "beta");
  expect((await state()).turns.map((t) => t.prompt)).toEqual(["alpha", "alpha", "beta"]);
});
