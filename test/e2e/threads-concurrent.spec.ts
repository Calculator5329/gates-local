import { appUrl } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";
import { INSTALLED, SMALL, configure, finished, noWarnings, observe, pick, release, start, state } from "./threads-support.ts";

test.use({ installed: INSTALLED, screenshot: "only-on-failure" });

// Guards the owner's ask for parallel threads: a reply finishes while you are away, and switching back shows its words in order.
// One model with three slots: a second model beside a running reply asks first (the next test).
test("background life: return mid-reply, finish away, and keep exact ordered words across three threads", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await configure({ parallelLimit: 3, prompts: { alpha: { holdAfterTokens: 28, tokenDelayMs: 30 }, beta: { holdAfterTokens: 28 } } });
  const alpha = await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByTestId("sidebar.top.new-thread").click();
  await expect(page.locator(".turn")).toHaveCount(0);
  const beta = await start(page, "beta");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await expect(page.locator(".sb-row", { hasText: "alpha" }).getByLabel("Reply in progress")).toBeVisible();
  await expect(page.locator(".sb-row", { hasText: "beta" }).getByLabel("Reply in progress")).toBeVisible();
  await page.getByTestId("sidebar.top.new-thread").click();
  await start(page, "gamma");
  await finished(page, "gamma");
  await release("alpha");
  await expect.poll(async () => (await state()).turns.find((t) => t.prompt === "alpha")?.tokens).toBeGreaterThanOrEqual(50);
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  // why: with a mouse a hovered row shows its menu where the mark is, and rows reorder under a resting pointer
  await page.locator("#ta").hover();
  expect(page.url()).toBe(alpha);
  await expect.poll(() => page.locator(".turn.a:not(.done) .md p").count()).toBeGreaterThanOrEqual(4);
  await expect(page.locator(".turn.a .md")).not.toContainText("beta");
  await expect(page.locator(".think.run")).toBeVisible();
  await finished(page, "alpha");
  await expect(page.locator(".sb-row", { hasText: "alpha" }).getByLabel("Reply in progress")).toHaveCount(0);
  await expect(page.locator(".sb-row", { hasText: "beta" }).getByLabel("Reply in progress")).toBeVisible();
  await release("beta");
  await expect.poll(async () => (await state()).turns.find((t) => t.prompt === "beta")?.outcome).toBe("done");
  await page.locator(".sb-row", { hasText: "beta" }).click();
  expect(page.url()).toBe(beta);
  await finished(page, "beta");
  await expect(page.locator(".sb-row", { hasText: "beta" }).getByLabel("Reply in progress")).toHaveCount(0);
  const turns = (await state()).turns;
  expect(turns.map((t) => t.prompt)).toEqual(["alpha", "beta", "gamma"]);
  expect(turns.every((t) => t.outcome === "done")).toBe(true);
});

// Guards the owner's rule of 2026-11-13, one thing in memory at a time: a different model never
// starts beside a running reply, even when the card has room for both; Send asks first.
// stop-others.spec.ts carries the same warning when there is no room, and the stopped chat's note.
// Should the owner choose "start beside it" when both fit, this test turns around: no warning,
// both replies run, both models stay resident.
test("both fit: a different model while another chat replies asks to stop it; Cancel leaves both as they were, Stop and send swaps", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28 } } });
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await expect.poll(async () => (await state()).turns[0]?.tokens).toBe(28);
  const held = await state();
  await page.getByTestId("sidebar.top.new-thread").click();
  await pick(page, SMALL[1] ?? "");
  await page.locator("#ta").fill("beta");
  await page.locator("#ta").press("Enter");
  const warning = page.getByTestId("chat.stop-warning.dialog");
  await expect(warning).toContainText(`This stops ${SMALL[0]} in “alpha”.`);
  // Cancel: the message is not sent and keeps its words; the other reply runs on, untouched
  await warning.getByTestId("chat.stop-warning.cancel").click();
  await expect(warning).toBeHidden();
  await expect(page.locator("#ta")).toHaveValue("beta");
  await expect(page.locator(".turn")).toHaveCount(0);
  await expect(page.locator(".sb-row", { hasText: "alpha" }).getByLabel("Reply in progress")).toBeVisible();
  const declined = await state();
  expect(declined.turns).toEqual(held.turns);
  expect(declined.loaded.map((m) => m.name)).toEqual([SMALL[0]]);
  // Stop and send: the other reply stops, this one starts, and only its model stays
  await page.locator("#ta").press("Enter");
  await warning.getByTestId("chat.stop-warning.confirm").click();
  await expect(page.locator(".turn.u .bubble")).toHaveText("beta");
  await expect(page.locator("#ta")).toHaveValue("");
  await finished(page, "beta");
  const after = await state();
  expect(after.turns.map((t) => [t.prompt, t.outcome])).toEqual([["alpha", "cancelled"], ["beta", "done"]]);
  await expect.poll(async () => (await state()).loaded.map((m) => m.name)).toEqual([SMALL[1]]);
});

test.describe("same-model screen proof", () => {
  for (const parallelLimit of [1, 2]) {
    // Guards the owner's ask for parallel threads on one model: each reply keeps its own words, none stops another.
    test(`same model: ${parallelLimit} slot(s), own words, no stopping or cross-talk`, async ({ page, open }) => {
      await open(); await waitReady(page);
      await configure({ parallelLimit, prompts: { alpha: { holdAfterTokens: 28 }, beta: { holdAfterTokens: 28 } } });
      await start(page, "alpha");
      await expect(page.locator(".turn.a .md p")).toHaveCount(3);
      await page.getByTestId("sidebar.top.new-thread").click();
      await observe(page);
      await start(page, "beta");
      await expect.poll(async () => (await state()).turns.length).toBe(2);
      if (parallelLimit === 1) {
        expect((await state()).turns[1]?.startedAt).toBeUndefined();
        await expect(page.locator(".think.run .lv-w > span").first()).toHaveText("Waiting");
        await release("alpha");
      }
      await expect(page.locator(".turn.a .md p")).toHaveCount(3);
      await expect(page.locator(".turn.a .md")).toContainText("Reply 1 for beta.");
      await expect(page.locator(".turn.a .md")).not.toContainText("alpha");
      if (parallelLimit === 2) expect((await state()).turns[0]?.endedAt).toBeUndefined();
      await noWarnings(page);
      await release("beta"); await finished(page, "beta");
      await page.locator(".sb-row", { hasText: "alpha" }).click();
      if (parallelLimit === 2) await release("alpha");
      await finished(page, "alpha");
      const [a, b] = (await state()).turns;
      expect(a?.outcome).toBe("done"); expect(b?.outcome).toBe("done");
      if (parallelLimit === 1) expect(b?.startedAt).toBeGreaterThanOrEqual(a?.endedAt ?? Infinity);
      else expect(b?.firstTokenAt).toBeLessThan(a?.endedAt ?? 0);
    });
  }
});

/** How many of alpha's tries broke, as the fake runtime counts them. */
const broken = async () => (await state()).turns.filter((t) => t.prompt === "alpha" && t.outcome === "error").length;

// Guards a shipped bug fix: a reply that failed in the background lost its words.
test("a background error stays visible with its partial words when returning", async ({ page, open }) => {
  await open(); await waitReady(page);
  // two slots on one model: beta replies beside alpha's tries
  await configure({ parallelLimit: 2, prompts: { alpha: { holdAfterTokens: 28, errorAfterTokens: 40 } } });
  const observer = await page.context().newPage();
  await observer.goto(appUrl()); await waitReady(observer);
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByTestId("sidebar.top.new-thread").click();
  await start(page, "beta");
  await release("alpha");
  // the server tries a broken reply once more by itself (decision 7); the second try breaks too
  await expect.poll(broken).toBe(1);
  await expect.poll(async () => (await state()).turns.filter((t) => t.prompt === "alpha").length).toBe(2);
  await release("alpha");
  await expect.poll(broken).toBe(2);
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  await expect(page.getByTestId("chat.reply.failed")).toContainText("The reply didn't finish.");
  await expect(page.locator(".turn.a .md")).toContainText("Reply 1 for alpha.");
  await expect(page.locator(".turn.a .md")).not.toContainText("beta");
  // This client never loaded alpha's history before it failed off screen.
  await observer.locator(".sb-row", { hasText: "alpha" }).click();
  await expect(observer.locator(".turn.u .bubble")).toHaveText("alpha");
  await expect(observer.locator(".turn.a .md")).toContainText("Reply 1 for alpha.");
  await expect(observer.getByTestId("chat.reply.failed")).toContainText("The reply didn't finish.");
  await observer.close();
});
