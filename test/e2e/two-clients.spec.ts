// The same thread open in two clients, as on the desktop and the phone
// (PH-02): a reply sent from one streams in the other too, before it is
// saved, and both end on the same finished turns. The real server pushes the
// turn's start (model and user message) to every client.
import { appUrl } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ seed: 2 });

test("a reply sent from one client streams in a second client with the same thread open", async ({ page, open, seededThread, context }) => {
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  const other = await context.newPage();
  const errors: string[] = [];
  other.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  other.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await other.goto(appUrl(`#thread=${seededThread ?? ""}`));
  await waitReady(other);
  for (const p of [page, other]) await expect(p.locator(".tl .turn")).toHaveCount(2);

  // slow tokens: the reply is still being written while both are read. The
  // drip reply has several blocks, so its first paragraph shows while the
  // rest is still streaming (a live turn shows whole blocks only).
  await stack.scenario("slow-drip", { tokenDelayMs: 60, firstTokenDelayMs: 0 });
  await sendMessage(page, "Stream to both windows");
  for (const p of [page, other]) {
    const live = p.locator(".turn.a:not(.done)");
    await expect(live.locator(".writing")).toBeVisible();
    await expect(live.locator(".md")).toContainText("Here is how to check the free disk space");
    await expect(live.locator(".md")).not.toContainText("Keep some room for the context cache.");
    await expect(p.locator(".turn.u").last()).toContainText("Stream to both windows");
  }
  // partial in both, not yet saved: the live turn is still there in each
  for (const p of [page, other]) await expect(p.locator(".turn.a:not(.done) .writing")).toBeVisible();

  for (const p of [page, other]) {
    await expect(p.locator(".writing")).toHaveCount(0, { timeout: 20_000 });
    await expect(p.locator(".turn.a.done")).toHaveCount(2);
    await expect(p.locator(".turn.u")).toHaveCount(2);
    await expect(p.locator(".turn.a.done").last().locator(".md")).toContainText("Keep some room for the context cache.");
  }
  expect(errors, "console errors in the second client").toEqual([]);
  await other.close();
});
