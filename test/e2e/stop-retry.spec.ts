// Journey: Stop a reply mid-stream, then Retry it to a full answer.
import { expect, sendMessage, test, waitReady, stack } from "./fixtures.ts";

test("Stop ends the reply where it is and Retry writes it again", async ({ page, open }) => {
  await open();
  await waitReady(page);
  // slow tokens so there is time to press Stop mid-reply
  await stack.scenario("models", { tokenDelayMs: 120 });
  await sendMessage(page, "Tell me about cron");

  const live = page.locator(".turn.a").last();
  await expect(live.locator(".writing")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(live).toContainText(/Stopped after \d+ s/);
  await expect(page.locator(".writing")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();

  await stack.scenario("models");
  await live.getByRole("button", { name: "Retry" }).click();
  const again = page.locator(".turn.a").last();
  // the fake's full reply is 60 words and ends here
  await expect(again.locator(".md")).toContainText("so streaming takes a", { timeout: 10_000 });
  await expect(page.locator(".writing")).toHaveCount(0);
  await expect(page.getByText(/Stopped after/)).toHaveCount(0);
});

test("Retry pressed the moment Stop lands still ends as a normal reply (W-02)", async ({ page, open }) => {
  // The race: the stopped turn's "cancelled" event reaches the page before
  // the retried chat.send answers. Holding that one response back 400 ms
  // makes the order certain; every other frame passes straight through.
  let sends = 0;
  const held = new Set<string>();
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (typeof m === "string") {
        const f = JSON.parse(m) as { type?: string; method?: string; id?: string };
        if (f.type === "request" && f.method === "chat.send" && ++sends === 2 && f.id !== undefined) held.add(f.id);
      }
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m === "string" && held.has((JSON.parse(m) as { id?: string }).id ?? "")) {
        setTimeout(() => ws.send(m), 400);
        return;
      }
      ws.send(m);
    });
  });
  await open();
  await waitReady(page);
  await stack.scenario("models", { tokenDelayMs: 40 });
  await sendMessage(page, "Tell me about cron");
  const live = page.locator(".turn.a").last();
  // tokens are arriving ("Writing" shows from the first; the one-paragraph reply shows only at its end)
  await expect(live.locator(".writing")).toBeVisible();
  // Stop, then Retry in the same task, before the server's cancelled event can arrive
  const early = await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>("button.send.stop")?.click();
    await new Promise<void>((r) => queueMicrotask(r));
    const retry = Array.from(document.querySelectorAll<HTMLButtonElement>(".turn.a .stopped button")).at(-1);
    if (retry === undefined) return "no Retry yet";
    const disabled = retry.disabled;
    retry.click();
    return disabled ? "Retry disabled" : "Retry clicked";
  });
  console.log(`[stop-retry] immediate Retry: ${early}`);
  // an early click that did nothing: Retry again once it is enabled
  if (early !== "Retry clicked") await live.getByRole("button", { name: "Retry" }).click();
  const again = page.locator(".turn.a").last();
  // the new reply streams as itself: the old turn's end never stops it (its done alone would hide that)
  await expect(again.locator(".writing")).toBeVisible();
  await expect(page.getByText(/Stopped after/)).toHaveCount(0);
  await expect(again.locator(".md")).toContainText("so streaming takes a", { timeout: 10_000 });
  await expect(page.locator(".writing")).toHaveCount(0);
  await expect(page.getByText(/Stopped after/)).toHaveCount(0);
  await expect(page.locator(".err-line")).toHaveCount(0);
  await expect(page.locator(".turn.u")).toHaveCount(2);
});
