import { appUrl } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";
import { INSTALLED, SMALL, configure, finished, noWarnings, observe, release, start, state } from "./threads-support.ts";

test.use({ installed: INSTALLED, screenshot: "only-on-failure" });

// Guards the owner's ask for parallel threads: a reply finishes while you are away, and switching back shows its words in order.
test("background life: return mid-reply, finish away, and keep exact ordered words across three threads", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28, tokenDelayMs: 30 }, beta: { holdAfterTokens: 28 } } });
  const alpha = await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await expect(page.locator(".turn")).toHaveCount(0);
  const beta = await start(page, "beta", SMALL[1]);
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await expect(page.locator(".sb-row", { hasText: "alpha" }).getByLabel("Reply in progress")).toBeVisible();
  await expect(page.locator(".sb-row", { hasText: "beta" }).getByLabel("Reply in progress")).toBeVisible();
  await page.getByRole("button", { name: "New thread" }).click();
  await start(page, "gamma", SMALL[2]);
  await finished(page, "gamma");
  await release("alpha");
  await expect.poll(async () => (await state()).turns.find((t) => t.prompt === "alpha")?.tokens).toBeGreaterThanOrEqual(50);
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  expect(page.url()).toBe(alpha);
  await expect.poll(() => page.locator(".turn.a:not(.done) .md p").count()).toBeGreaterThanOrEqual(4);
  await expect(page.locator(".turn.a .md")).not.toContainText("beta");
  await expect(page.locator(".writing")).toBeVisible();
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

// Guards the owner's ask for a second reply alongside the first: two models run at once, with no warning.
test("both fit: different models make independent progress with no warning and stay resident", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28 }, beta: { holdAfterTokens: 28 } } });
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await observe(page);
  await start(page, "beta", SMALL[1]);
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await expect(page.locator(".turn.a .md")).toContainText("Reply 1 for beta.");
  await expect(page.locator(".turn.a .md")).not.toContainText("alpha");
  const before = await state();
  expect(before.turns.every((t) => t.firstTokenAt !== undefined && t.endedAt === undefined)).toBe(true);
  expect(before.loaded.map((m) => m.name)).toEqual(expect.arrayContaining(SMALL.slice(0, 2)));
  await noWarnings(page);
  await release("beta"); await finished(page, "beta");
  expect((await state()).turns.find((t) => t.prompt === "alpha")?.endedAt).toBeUndefined();
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  await release("alpha"); await finished(page, "alpha");
});

test.describe("same-model screen proof", () => {
  for (const parallelLimit of [1, 2]) {
    // Guards the owner's ask for parallel threads on one model: each reply keeps its own words, none stops another.
    test(`same model: ${parallelLimit} slot(s), own words, no stopping or cross-talk`, async ({ page, open }) => {
      await open(); await waitReady(page);
      await configure({ parallelLimit, prompts: { alpha: { holdAfterTokens: 28 }, beta: { holdAfterTokens: 28 } } });
      await start(page, "alpha");
      await expect(page.locator(".turn.a .md p")).toHaveCount(3);
      await page.getByRole("button", { name: "New thread" }).click();
      await observe(page);
      await start(page, "beta");
      await expect.poll(async () => (await state()).turns.length).toBe(2);
      if (parallelLimit === 1) {
        expect((await state()).turns[1]?.startedAt).toBeUndefined();
        await expect(page.locator(".working")).toContainText("Waiting for Ollama");
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

// Guards a shipped bug fix: a reply that failed in the background lost its words.
test("a background error stays visible with its partial words when returning", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28, errorAfterTokens: 40 } } });
  const observer = await page.context().newPage();
  await observer.goto(appUrl()); await waitReady(observer);
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await start(page, "beta", SMALL[1]);
  await release("alpha");
  await expect.poll(async () => (await state()).turns.find((t) => t.prompt === "alpha")?.outcome).toBe("error");
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  await expect(page.locator(".stop-note, .err-line")).toContainText("The reply didn't finish.");
  await expect(page.locator(".turn.a .md")).toContainText("Reply 1 for alpha.");
  await expect(page.locator(".turn.a .md")).not.toContainText("beta");
  // This client never loaded alpha's history before it failed off screen.
  await observer.locator(".sb-row", { hasText: "alpha" }).click();
  await expect(observer.locator(".turn.u .bubble")).toHaveText("alpha");
  await expect(observer.locator(".turn.a .md")).toContainText("Reply 1 for alpha.");
  await expect(observer.locator(".stop-note")).toContainText("The reply didn't finish.");
  await observer.close();
});
