import { appUrl } from "./env.ts";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CHECKOUT_CACHE } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { INSTALLED, SMALL, configure, contextSize, finished, noWarnings, observe, pick, release, shot, start, state } from "./threads-support.ts";

test.use({ installed: INSTALLED, screenshot: "only-on-failure", video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

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
  await shot(page, "sidebar-two-replies");
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
        await shot(page, "same-model-waiting");
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

test("same model: stop the waiting request, then stop the running request to free a third", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ holdAfterTokens: 28 });
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await start(page, "beta");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await state()).turns.find((t) => t.prompt === "beta")?.outcome).toBe("cancelled");
  expect((await state()).turns.find((t) => t.prompt === "alpha")?.endedAt).toBeUndefined();
  await shot(page, "stopped-waiting");
  await page.getByRole("button", { name: "New thread" }).click();
  await start(page, "gamma");
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.locator(".sb-row", { hasText: "gamma" }).click();
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await release("gamma"); await finished(page, "gamma");
  const turns = (await state()).turns;
  expect(turns[1]?.firstTokenAt).toBeUndefined();
  expect(turns[2]?.startedAt).toBeGreaterThanOrEqual(turns[0]?.endedAt ?? Infinity);
});

test("reload while another thread runs: return mid-reply and see its live words and stop control", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ holdAfterTokens: 28 });
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await page.reload(); await waitReady(page);
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await release("alpha"); await finished(page, "alpha");
  expect((await state()).turns).toHaveLength(1);
});

test("two clients: a client opening during a reply receives the in-flight snapshot and completion", async ({ page, context, open }) => {
  await open(); await waitReady(page);
  await configure({ holdAfterTokens: 28 });
  const url = await start(page, "alpha", "qwen3.5:9b");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  const other = await context.newPage();
  await other.goto(url); await waitReady(other);
  await expect(other.locator(".turn.a .md p")).toHaveCount(3);
  await expect(other.locator(".think")).toBeVisible();
  await release("alpha");
  for (const p of [page, other]) await finished(p, "alpha");
  expect((await state()).turns).toHaveLength(1);
  await other.close();
});

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
  await shot(page, "background-error");
  // This client never loaded alpha's history before it failed off screen.
  await observer.locator(".sb-row", { hasText: "alpha" }).click();
  await expect(observer.locator(".turn.u .bubble")).toHaveText("alpha");
  await expect(observer.locator(".turn.a .md")).toContainText("Reply 1 for alpha.");
  await expect(observer.locator(".stop-note")).toContainText("The reply didn't finish.");
  await shot(observer, "background-error-observer");
  await observer.close();
});

test("thinking and a tool row survive leaving mid-reply and returning during the next tool round", async ({ page, open }) => {
  const source = path.join(CHECKOUT_CACHE, "threads-tool-library");
  mkdirSync(source, { recursive: true });
  await open(); await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Add folder…" }).click();
  await page.getByRole("textbox", { name: "Add a folder path" }).fill(source);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".srow.src")).toHaveCount(1);
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.getByRole("button", { name: "New thread" }).click();
  await configure({ prompts: { "use a tool alpha": { holdAfterTokens: 28 } } });
  await start(page, "use a tool alpha", "qwen3.5:9b");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await start(page, "beta");
  await release("use a tool alpha");
  await expect.poll(async () => (await state()).turns.filter((t) => t.prompt === "use a tool alpha").length).toBe(2);
  await expect.poll(async () => (await state()).turns.findLast((t) => t.prompt === "use a tool alpha")?.tokens).toBe(28);
  await page.locator(".sb-row", { hasText: "use a tool alpha" }).click();
  await expect(page.locator("[data-tool-row]")).toHaveCount(1);
  await expect(page.locator(".think")).toHaveCount(1);
  await expect(page.locator(".writing")).toBeVisible();
  await release("use a tool alpha");
  await expect(page.locator(".turn.a:not(.done)")).toHaveCount(0);
  await expect(page.locator("[data-tool-row]")).toHaveCount(1);
  await expect(page.locator(".think")).toHaveCount(1);
  await page.locator(".think").click();
  await expect(page.locator(".think-body")).toContainText("The question is short");
});

test.describe("another client stops an off-screen reply", () => {
  test.use({ seed: 2 });
  test("keeps the partial words and a stopped note when the owner returns", async ({ page, context, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const other = await context.newPage(); await other.goto(page.url()); await waitReady(other);
    await configure({ holdAfterTokens: 28 });
    await start(page, "alpha");
    await expect(page.locator(".turn.a:not(.done) .md p")).toHaveCount(3);
    await expect(other.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New thread" }).click();
    await start(page, "beta", SMALL[1]);
    await other.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(async () => (await state()).turns[0]?.outcome).toBe("cancelled");
    await page.locator(".sb-row", { hasText: "A long thread" }).click();
    await expect(page.locator(".turn.a .md").last()).toContainText("Reply 1 for alpha.");
    await expect(page.getByRole("img", { name: "Stopped. The model won't see this reply.", exact: true }).first()).toBeVisible();
    // stopped while not on screen: the mark still has Stop's seconds
    await expect(page.locator(".turn.a .a-act.stop .s").last()).toHaveText(/^\d+ s$/);
    expect((await state()).turns.find((t) => t.prompt === "beta")?.endedAt).toBeUndefined();
    await other.close();
  });
});

test("different context: waits for the running request, reloads once, and explains the wait", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ loadDelayMs: 150, prompts: { alpha: { holdAfterTokens: 28 } } });
  await start(page, "alpha", SMALL[2]);
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await pick(page, SMALL[2] ?? "mid-chat:32k");
  await contextSize(page, 8192);
  await sendMessage(page, "beta");
  await expect(page.locator(".working")).toContainText("Waiting for Ollama");
  await shot(page, "context-waiting");
  await release("alpha");
  await finished(page, "beta");
  const [a, b] = (await state()).turns;
  expect(a?.numCtx).not.toBe(b?.numCtx);
  expect(b?.startedAt).toBeGreaterThanOrEqual(a?.endedAt ?? Infinity);
});

test("cold starts: simultaneous clients load in order and both finish", async ({ page, context, open }) => {
  await open(); await waitReady(page);
  const other = await context.newPage(); await other.goto(appUrl()); await waitReady(other);
  await pick(page, SMALL[0] ?? "tiny-chat:2k"); await pick(other, SMALL[1] ?? "no-limit-chat:1b");
  await expect.poll(async () => (await state()).loaded.map((m) => m.name)).toEqual(expect.arrayContaining(SMALL.slice(0, 2)));
  await configure({ loadDelayMs: 500 });
  await Promise.all([sendMessage(page, "alpha"), sendMessage(other, "beta")]);
  await Promise.all([finished(page, "alpha"), finished(other, "beta")]);
  const loads = (await state()).loads;
  expect(loads).toHaveLength(2);
  expect(loads[1]?.startedAt).toBeGreaterThanOrEqual(loads[0]?.endedAt ?? Infinity);
  await other.close();
});

test("cold starts: Stop while waiting never writes a reply after the first load frees the gate", async ({ page, context, open }) => {
  await open(); await waitReady(page);
  const other = await context.newPage(); await other.goto(appUrl()); await waitReady(other);
  await pick(page, SMALL[0] ?? "tiny-chat:2k"); await pick(other, SMALL[1] ?? "no-limit-chat:1b");
  await expect.poll(async () => (await state()).loaded.map((m) => m.name)).toEqual(expect.arrayContaining(SMALL.slice(0, 2)));
  await configure({ loadDelayMs: 400, firstTokenDelayMs: 1200 });
  await sendMessage(page, "alpha");
  await expect.poll(async () => (await state()).loads.length).toBe(1);
  await sendMessage(other, "beta");
  await expect(other.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(other.locator(".turn.a .a-act.stop .s")).toHaveText(/^\d+ s$/);
  await finished(page, "alpha");
  // the stopped turn draws the row its saved reply would: Regenerate, on once the server has ended the turn
  await expect(other.getByRole("button", { name: "Regenerate", exact: true })).toBeEnabled();
  await expect(other.locator(".turn.a .md")).toHaveCount(0);
  const beta = (await state()).turns.find((t) => t.prompt === "beta");
  expect(beta?.firstTokenAt).toBeUndefined();
  if (beta) expect(beta.outcome).toBe("cancelled");
  await shot(other, "cold-stopped-waiting");
  await other.close();
});

test.describe("connection drops with two replies", () => {
  test.use({ allowedErrors: [/WebSocket connection to .* failed/] });
  test("reports the disconnect, keeps threads, and reconnects without duplicate requests", async ({ page, open }) => {
    await open(); await waitReady(page);
    await configure({ holdAfterTokens: 28 });
    await start(page, "alpha");
    await expect(page.locator(".turn.a .md p")).toHaveCount(3);
    await page.getByRole("button", { name: "New thread" }).click();
    await start(page, "beta", SMALL[1]);
    await expect(page.locator(".turn.a .md p")).toHaveCount(3);
    const restart = stack.restart(1500);
    await expect(page.getByText("Reconnecting to Gates Local")).toBeVisible();
    await restart; await waitReady(page);
    await expect(page.locator(".turn.u")).toHaveCount(1);
    await page.locator(".sb-row", { hasText: "alpha" }).click();
    await expect(page.locator(".turn.u")).toHaveCount(1);
    expect((await state()).turns).toHaveLength(2);
    expect((await state()).turns.every((t) => t.outcome === "cancelled")).toBe(true);
  });
});
