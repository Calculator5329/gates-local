import { expect, sendMessage, test, waitReady } from "./fixtures.ts";
import { INSTALLED, SMALL, configure, contextSize, finished, noWarnings, observe, pick, release, shot, start, state } from "./threads-support.ts";

test.use({ installed: INSTALLED, screenshot: "only-on-failure" });
const warning = (page: import("@playwright/test").Page) => page.getByRole("alertdialog", { name: "Stop the other reply?" });

test("same-thread queue: several messages send FIFO; editing and deleting preserve the order", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28 } } });
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await sendMessage(page, "beta"); await sendMessage(page, "remove me"); await sendMessage(page, "gamma");
  await expect(page.locator(".qt-r")).toHaveCount(3);
  await page.locator(".qt-r").first().locator("[data-edit-queued]").click();
  await sendMessage(page, "edited beta");
  await page.locator(".qt-r").nth(1).locator("[data-unqueue]").click();
  await expect(page.locator(".qt-r")).toHaveCount(2);
  expect((await state()).turns.map((t) => t.prompt)).toEqual(["alpha"]);
  await release("alpha");
  await finished(page, "gamma", 3);
  await expect(page.locator(".turn.u")).toHaveCount(3);
  const turns = (await state()).turns;
  expect(turns.map((t) => t.prompt)).toEqual(["alpha", "edited beta", "gamma"]);
  for (let i = 1; i < turns.length; i++) expect(turns[i]?.receivedAt).toBeGreaterThanOrEqual(turns[i - 1]?.endedAt ?? Infinity);
});

for (const ending of ["stop", "error"] as const) {
  test(`same-thread queue: ${ending} holds queued words until Send now`, async ({ page, open }) => {
    await open(); await waitReady(page);
    await configure({ prompts: { alpha: { holdAfterTokens: 28, ...(ending === "error" ? { errorAfterTokens: 40 } : {}) } } });
    await start(page, "alpha");
    await expect(page.locator(".turn.a .md p")).toHaveCount(3);
    await sendMessage(page, "beta");
    if (ending === "stop") await page.getByRole("button", { name: "Stop", exact: true }).click();
    else await release("alpha");
    await expect(page.locator(".qt-r")).toContainText("On hold");
    expect((await state()).turns.map((t) => t.prompt)).toEqual(["alpha"]);
    await shot(page, `queue-${ending}-held`);
    await page.locator("[data-send-now]").click();
    await finished(page, "beta", 2);
    expect((await state()).turns.map((t) => t.prompt)).toEqual(["alpha", "beta"]);
  });
}

test("Send now stops only this thread, keeping its partial words while another thread finishes", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28 }, beta: { holdAfterTokens: 28 } } });
  await start(page, "alpha"); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await sendMessage(page, "send now");
  await page.getByRole("button", { name: "New thread" }).click();
  await start(page, "beta", SMALL[1]); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  await page.locator("[data-send-now]").click();
  await expect(page.locator(".turn.u")).toHaveCount(2);
  await expect(page.locator(".stop-note")).toContainText("Stopped after");
  await expect(page.locator(".turn.a.done .md").first()).toContainText("Reply 1 for alpha.");
  expect((await state()).turns.find((t) => t.prompt === "beta")?.endedAt).toBeUndefined();
  await expect.poll(async () => (await state()).turns.find((t) => t.prompt === "send now")?.outcome).toBe("done");
  await release("beta");
  await page.locator(".sb-row", { hasText: "beta" }).click();
  await finished(page, "beta");
});

test("won't fit together: exact warning, Cancel preserves draft and running reply, confirm preserves partial words", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28 } } });
  await start(page, "alpha", "gemma4:12b"); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await pick(page, "qwen3.5:9b"); await sendMessage(page, "beta");
  await expect(warning(page)).toContainText("This stops Gemma 4 12B in “alpha”. Its reply so far is kept.");
  await warning(page).getByLabel("Don't show this again").check();
  await warning(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#ta")).toHaveValue("beta");
  expect(await page.evaluate(() => localStorage.getItem("gates-local.stop-others-ok"))).toBeNull();
  expect((await state()).turns).toHaveLength(1);
  expect((await state()).turns[0]?.endedAt).toBeUndefined();
  await page.locator("#ta").press("Enter");
  await warning(page).getByRole("button", { name: "Stop and send" }).click();
  await finished(page, "beta");
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  await expect(page.locator(".stop-note")).toHaveText("Stopped so Qwen 3.5 9B could load.");
  await expect(page.locator(".turn.a.done .md")).toContainText("Reply 1 for alpha.");
  await shot(page, "preempted");
  const [a, b] = (await state()).turns;
  expect(a?.outcome).toBe("cancelled");
  expect(b?.startedAt).toBeGreaterThanOrEqual(a?.endedAt ?? Infinity);
});

test("never fits: plain reason and intact draft, no warning, no request, other reply untouched", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ holdAfterTokens: 28 });
  await start(page, "alpha"); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await pick(page, "gemma4:12b");
  await contextSize(page, 65536);
  await sendMessage(page, "beta");
  await expect(page.locator("#ta")).toHaveValue("beta");
  await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "Send message" }).hover();
  await expect(page.locator(".c-note:visible, .tip:visible").first()).toContainText(/doesn't fit in memory|not enough memory/i);
  await expect(warning(page)).toHaveCount(0);
  expect((await state()).turns).toHaveLength(1);
  expect((await state()).turns[0]?.endedAt).toBeUndefined();
  await shot(page, "never-fits");
  // A screenshot advances rendering: an in-flight send must not clear the
  // draft after the refusal assertions above have already passed.
  await expect(page.locator("#ta")).toHaveValue("beta");
  await expect(page.locator(".working, .writing")).toHaveCount(0);
  expect((await state()).turns).toHaveLength(1);
  await shot(page, "never-fits-settled");
});

test("automatic queue waits for another thread without warning or preemption", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28 }, beta: { holdAfterTokens: 28 } } });
  await start(page, "alpha", "gemma4:12b"); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await pick(page, "qwen3.5:9b"); await sendMessage(page, "queued model");
  await expect(page.locator(".qt-r")).toHaveCount(1);
  await page.getByRole("button", { name: "New thread" }).click();
  await start(page, "beta", "gemma4:12b");
  await observe(page);
  await release("alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  // beta still runs; the auto-send must wait, never stop it or ask for consent.
  expect((await state()).turns.find((t) => t.prompt === "queued model")).toBeUndefined();
  await noWarnings(page);
  await release("beta");
  await expect.poll(async () => (await state()).turns.find((t) => t.prompt === "queued model")?.outcome, { timeout: 15_000 }).toBe("done");
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  await finished(page, "queued model", 2);
  const turns = (await state()).turns;
  expect(turns.map((t) => t.prompt)).toEqual(["alpha", "beta", "queued model"]);
  expect(turns[2]?.receivedAt).toBeGreaterThanOrEqual(turns[1]?.endedAt ?? Infinity);
});

test("an auto-send that still cannot fit stays on hold with its words", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28 } } });
  await start(page, "alpha"); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await pick(page, "gemma4:12b");
  await sendMessage(page, "queued giant");
  await expect(page.locator(".qt-r")).toHaveCount(1);
  await contextSize(page, 65536);
  await release("alpha");
  await expect(page.locator(".qt-r")).toContainText("On hold");
  await expect(page.locator(".qt-r")).toContainText("queued giant");
  await expect(warning(page)).toHaveCount(0);
  expect((await state()).turns).toHaveLength(1);
});
