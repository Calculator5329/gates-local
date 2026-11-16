// The queue is the server's: every window shows the same queued messages, a
// change in one shows in the others, and a reload keeps what was waiting
// without putting it on hold.
import { createClient } from "@gates-local/contracts";
import { type Page } from "@playwright/test";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { tap } from "./socket-tap.ts";

const rows = (page: Page) => page.locator(".qt-r");
const stop = (page: Page) => page.getByRole("button", { name: "Stop" });
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

// Guards the owner's ask: a second window sees the queue and can change it.
test("a message queued in one window shows in a second window, and removing it there removes it everywhere", async ({ page, open, context }) => {
  await open();
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
  await sendMessage(page, "Queued in the first window");
  await expect(rows(page)).toHaveCount(1);

  const other = await context.newPage();
  await other.goto(page.url());
  await waitReady(other);
  await expect(rows(other), "the second window shows the server's queue").toHaveCount(1);
  await expect(rows(other).first()).toHaveText("Queued in the first window");
  await expect(rows(other).first(), "waiting, not on hold").not.toContainText("On hold");
  await shot(other, "second-window-sees-queue");

  await rows(other).first().locator("[data-unqueue]").click();
  await expect(rows(other)).toHaveCount(0);
  await expect(rows(page), "removed in the second window, gone in the first").toHaveCount(0);
  await shot(page, "first-window-after-remove");

  // the removed message never goes: the reply ends on its own (a Stop would hold the queue by itself) and nothing follows it
  await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
  await expect(stop(page)).toHaveCount(0, { timeout: 15_000 });
  // long enough for a queued message to have gone out after the reply
  await page.waitForTimeout(1500);
  await expect(page.locator(".turn.u")).toHaveCount(1);
  await expect(other.locator(".turn.u")).toHaveCount(1);
  await other.close();
});

// Guards Stop as one step: the stop call is the last thing the server hears from the window, and nothing queued sends itself after.
test("Stop from a window that closes the moment it is pressed holds every queued message", async ({ page, open, context }) => {
  test.setTimeout(60_000);
  await open();
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
  await sendMessage(page, "First in the queue");
  await sendMessage(page, "Second in the queue");
  await expect(rows(page)).toHaveCount(2);

  const pressing = await context.newPage();
  const t = await tap(pressing);
  await pressing.goto(page.url());
  await waitReady(pressing);
  await expect(rows(pressing)).toHaveCount(2);
  await expect(stop(pressing)).toBeVisible();

  // every frame after the stop call is lost, and the window is gone
  t.lastWords(["chat.cancel", "reply.stop"]);
  await stop(pressing).click();
  await expect.poll(() => t.cut()).toBe(true);
  await pressing.close();

  await expect(stop(page), "the reply stopped").toHaveCount(0, { timeout: 15_000 });
  for (const n of [0, 1]) await expect(rows(page).nth(n), "held by the stop itself").toContainText("On hold");
  await shot(page, "held-after-the-window-closed");

  // the server's own account: both still wait on hold, nothing runs, and only the question was ever sent
  const address = new URL(page.url()).searchParams.get("server");
  if (!address) throw new Error("No test server");
  const rpc = createClient(new WebSocket(address));
  try {
    const listed = await rpc.call("reply.list", {});
    expect(listed.map(({ reply: r }) => ["text" in r ? r.text : r.id, r.stage]), "both on hold, and nothing runs").toEqual([["First in the queue", "held"], ["Second in the queue", "held"]]);
    const threadId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread") ?? "";
    const { messages } = await rpc.call("threads.get", { threadId });
    expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["How do I check disk space before a download?"]);
  } finally {
    rpc.close();
  }
  await expect(page.locator(".turn.u")).toHaveCount(1);
});

// Guards the queue's edit flag: a window closed in the middle of an edit leaves nothing stuck.
test("a message open for editing in another window says so, and sends once that window closes", async ({ page, open, context }) => {
  await open();
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
  await sendMessage(page, "Queued, then edited elsewhere");
  await expect(rows(page)).toHaveCount(1);

  const other = await context.newPage();
  await other.goto(page.url());
  await waitReady(other);
  await rows(other).first().locator("[data-edit-queued]").click();
  await expect(rows(page).first(), "the first window sees the edit").toContainText("Being edited in another window");
  await shot(page, "edited-in-another-window");

  // the editing window closes mid-edit: the row is free again within the short grace a reload gets, and goes when the reply ends
  await other.close();
  await expect(rows(page).first()).not.toContainText("Being edited in another window", { timeout: 15_000 });
  await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
  await expect(rows(page)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".turn.u").last()).toContainText("Queued, then edited elsewhere");
  await shot(page, "sent-after-editor-closed");
});

// Guards the owner's ask: a queued message survives a reload and still sends itself.
/** This browser's saved composer record, as a build from before the server kept the queue wrote it. */
function savedRecord(page: Page, write?: unknown) {
  return page.evaluate((value) => new Promise<unknown>((resolve, reject) => {
    const opening = indexedDB.open("gates-local.composer", 1);
    opening.addEventListener("success", () => {
      const db = opening.result;
      const key = new URL(new URL(location.href).searchParams.get("server")!).host;
      const store = db.transaction("drafts", value === undefined ? "readonly" : "readwrite").objectStore("drafts");
      const request = value === undefined ? store.get(key) : store.put(value, key);
      request.addEventListener("success", () => { db.close(); resolve(value === undefined ? request.result : undefined); }, { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    }, { once: true });
    opening.addEventListener("error", () => reject(opening.error), { once: true });
  }), write);
}

// Guards the update: a person who updates with three messages waiting still has them.
test("an update with three messages saved in this browser hands them to the server once, on hold", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page, "the new chat has its id").toHaveURL(/#thread=/);
  await expect(page.locator(".turn.a")).toHaveCount(1, { timeout: 15_000 });
  await expect(stop(page)).toHaveCount(0, { timeout: 15_000 });
  const threadId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread");
  expect(threadId).toBeTruthy();
  const waiting = [1, 2, 3].map((n) => ({ id: `old-${n}`, threadId, text: `Waiting from before the update ${n}`, at: n, images: [] }));
  await savedRecord(page, { draft: "", images: [], queued: waiting, editing: null });
  await page.evaluate(() => localStorage.removeItem("gates-local.queue-on-server"));

  await page.reload();
  await waitReady(page);
  await expect(rows(page), "all three are back").toHaveCount(3);
  for (const n of [0, 1, 2]) await expect(rows(page).nth(n)).toContainText("On hold");
  await shot(page, "old-queue-handed-over");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("gates-local.queue-on-server"))).toBe("1");
  await expect.poll(async () => (await savedRecord(page) as { queued?: unknown[] } | undefined)?.queued?.length, "forgotten here once the server has them").toBe(0);

  await page.reload();
  await waitReady(page);
  await expect(rows(page), "the server's three, never doubled").toHaveCount(3);
  await expect(page.locator(".turn.u"), "nothing sent by itself").toHaveCount(1);
});

test.describe("a restart", () => {
  // the browser logs each refused WebSocket attempt while the server is down
  test.use({ allowedErrors: [/WebSocket connection to .* failed/] });

  // Guards one record per message: a message that left the queue and was asked is not also left waiting by a restart.
  test("a restart while a queued message's reply is being written shows the question once, its words stopped, and no waiting row", async ({ page, open }) => {
    test.setTimeout(60_000);
    await open();
    await waitReady(page);
    await stack.scenario("slow-drip", { holdAfterTokens: 46 });
    await sendMessage(page, "How do I check disk space before a download?");
    await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
    await sendMessage(page, "Asked from the queue, then the app restarts");
    await expect(rows(page)).toHaveCount(1);

    // the first reply ends, the queued message goes, and its own reply is part written
    await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
    await expect(rows(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".turn.u")).toHaveCount(2);
    await expect(page.locator(".turn.a").last().locator(".md ul li")).toHaveCount(3, { timeout: 15_000 });
    await shot(page, "before-the-restart");

    await stack.restart();
    await waitReady(page);

    const asked = page.locator(".turn.u").filter({ hasText: "Asked from the queue, then the app restarts" });
    await expect(asked, "the question once").toHaveCount(1);
    await expect(page.locator(".turn.u")).toHaveCount(2);
    const cut = page.locator(".turn.a.interrupted");
    await expect(cut, "the words that had arrived, marked as cut short").toHaveCount(1);
    await expect(cut.locator(".md ul li")).toHaveCount(3);
    await expect(stop(page), "nothing is running").toHaveCount(0);
    await expect(rows(page), "no waiting row for a message already asked").toHaveCount(0);
    await shot(page, "after-the-restart");

    // the server's own account: nothing waits and nothing runs, so nothing more is asked without a press
    const address = new URL(page.url()).searchParams.get("server");
    if (!address) throw new Error("No test server");
    const rpc = createClient(new WebSocket(address));
    try {
      expect(await rpc.call("reply.list", {}), "nothing waits and nothing runs").toEqual([]);
      const threadId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread") ?? "";
      const { messages } = await rpc.call("threads.get", { threadId });
      expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["How do I check disk space before a download?", "Asked from the queue, then the app restarts"]);
      expect(messages.filter((m) => m.role === "assistant").map((m) => m.interrupted === true)).toEqual([false, true]);
    } finally {
      rpc.close();
    }
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator(".turn.u")).toHaveCount(2);
  });
});

test("a reload while a message is queued keeps it waiting, and it sends itself when the reply ends", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await stack.scenario("slow-drip", { tokenDelayMs: 150, firstTokenDelayMs: 0 });
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(stop(page)).toBeVisible();
  await sendMessage(page, "Queued before the reload");
  await expect(rows(page)).toHaveCount(1);

  await page.reload();
  await waitReady(page);
  await expect(rows(page), "the reload keeps it").toHaveCount(1);
  await expect(rows(page).first()).toHaveText("Queued before the reload");
  await expect(rows(page).first(), "still waiting for the reply, not on hold").not.toContainText("On hold");
  await shot(page, "after-reload-still-queued");

  await expect(rows(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(".turn.u")).toHaveCount(2);
  await expect(page.locator(".turn.u").last()).toContainText("Queued before the reload");
  await shot(page, "after-reload-sent");
});
