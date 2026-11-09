import { expect, test, waitReady } from "./fixtures.ts";
import { threadReply } from "../fake-ollama/fake-ollama.ts";
import { INSTALLED, configure, release, shot, start, state } from "./threads-support.ts";

test.use({ installed: INSTALLED, video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off", screenshot: "only-on-failure", allowedErrors: [/WebSocket connection to .* failed/] });

test("TE-03: the same page resumes a mid-reply connection loss with exact words, Stop and its running mark", async ({ page, open }) => {
  let cut: (() => Promise<void>) | undefined;
  let resume: (() => void) | undefined;
  let connections = 0;
  let held = true;
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    if (++connections === 1) {
      cut = () => ws.close({ code: 1001, reason: "test connection loss" });
    } else {
      const frames: (string | Buffer)[] = [];
      ws.onMessage((frame) => { if (held) frames.push(frame); else server.send(frame); });
      resume = () => { held = false; for (const frame of frames.splice(0)) server.send(frame); };
    }
  });
  await open(); await waitReady(page);
  await configure({ holdAfterTokens: 28, tokenDelayMs: 50 });
  await start(page, "alpha");
  await expect.poll(async () => (await state()).turns[0]?.tokens).toBe(28);
  const live = page.locator(".turn.a:not(.done)");
  const caughtUp = () => expect.poll(async () => {
    const received = await live.getAttribute("data-received");
    return received !== null && received === await live.getAttribute("data-revealed");
  }).toBe(true);
  await caughtUp();
  const before = await live.locator(".md").innerText();
  const received = await live.getAttribute("data-received");
  const documentStarted = await page.evaluate(() => performance.timeOrigin);
  if (cut === undefined) throw new Error("No application socket to interrupt");
  await cut();
  await expect.poll(() => resume !== undefined).toBe(true);
  await expect(page.locator(".err-line")).toContainText("The connection dropped before this reply finished.");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  expect((await state()).turns[0]?.endedAt).toBeUndefined();
  resume?.();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.locator(".sb-row", { hasText: "alpha" }).getByLabel("Reply in progress")).toBeVisible();
  await expect(page.locator(".err-line")).toHaveCount(0);
  await caughtUp();
  await expect(live).toHaveAttribute("data-received", received ?? "");
  await expect.poll(() => live.locator(".md").innerText()).toBe(before);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStarted);
  await shot(page, "reconnect-resumed");
  await release("alpha");
  await expect.poll(async () => (await live.locator(".md").innerText()).length).toBeGreaterThan(before.length);
  const shown = (await live.locator(".md").innerText()).replace(/\s+/g, " ").trim();
  expect(threadReply("alpha").replace(/\s+/g, " ").trim().startsWith(shown)).toBe(true);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await state()).turns[0]?.outcome).toBe("cancelled");
  await expect(page.locator(".sb-row", { hasText: "alpha" }).getByLabel("Reply in progress")).toHaveCount(0);
  await expect(page.locator(".stop-note")).toContainText("Stopped after");
  expect((await state()).turns).toHaveLength(1);
  await shot(page, "reconnect-stopped");
});
