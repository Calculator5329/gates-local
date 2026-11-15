/// <reference lib="dom" />
// The chat list and each chat are numbered on the socket: a row pushed after a rename applies by
// its number, so no window reads the whole list again for it, and a reconnect reads the list once
// and a chat only when its number moved while the window was away.
import type { Page } from "@playwright/test";
import { appUrl } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ seed: "design" });

/** Three of the design's sidebar chats, each holding one message that repeats its title. */
const THREE = ["Fix the backup cron", "Forge icon, take 3", "Whisper latency check"];
const rowNamed = (page: Page, title: string) => page.locator(".sb-row", { hasText: title });

/** The page's socket, counting the reads it sends, with a way to drop the connection so the app makes a new one. */
async function wire(page: Page) {
  const ctl = { gets: [] as string[], lists: 0, cut: () => {} };
  await page.routeWebSocket(/\/\?token=/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      if (typeof raw === "string") {
        const m = JSON.parse(raw) as { method?: string; params?: { threadId?: string } };
        if (m.method === "threads.get") ctl.gets.push(m.params?.threadId ?? "");
        if (m.method === "threads.list") ctl.lists += 1;
      }
      server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
    ctl.cut = () => { void ws.close(); void server.close(); };
  });
  return ctl;
}

async function visit(page: Page, title: string): Promise<void> {
  await rowNamed(page, title).click();
  await expect(page.locator(".hdr h2")).toHaveText(title);
  await expect(page.locator(".turn.u")).toHaveCount(1);
  await expect(page.locator(".turn.u")).toContainText(title);
}

// Guards the reconnect read: chats that did not change while the socket was down are not read again.
test("three chats loaded, the socket dropped and back: opening each makes no threads.get for a chat that did not change", async ({ page, open, seededThread }) => {
  const ws = await wire(page);
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  for (const title of THREE) await visit(page, title);
  expect(ws.gets.length, "each chat was read once to load it").toBeGreaterThanOrEqual(THREE.length);

  const lists = ws.lists;
  const gets = ws.gets.length;
  ws.cut();
  await expect.poll(() => ws.lists, "the new connection reads the list").toBe(lists + 1);
  await waitReady(page);
  for (const title of THREE.toReversed()) await visit(page, title);
  expect(ws.gets.slice(gets), "threads.get calls after the reconnect").toEqual([]);
  expect(ws.lists - lists, "threads.list calls after the reconnect").toBe(1);
});

// Guards the list push: a rename elsewhere arrives as its row, not as a cue to read the list.
test("a rename in a second window shows in the first, which makes no threads.list call", async ({ page, open, seededThread, context }) => {
  const ws = await wire(page);
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await expect(rowNamed(page, "Fix the backup cron")).toBeVisible();
  const lists = ws.lists;

  const other = await context.newPage();
  await other.goto(appUrl(`#thread=${seededThread ?? ""}`));
  await waitReady(other);
  await rowNamed(other, "Fix the backup cron").click({ button: "right" });
  await other.getByTestId("sidebar.thread-menu.rename").click();
  const input = other.getByTestId("chat.header.title");
  await expect(input).toHaveValue("Fix the backup cron");
  await input.fill("Fix the nightly backup");
  await input.press("Enter");
  await expect(rowNamed(other, "Fix the nightly backup")).toBeVisible();

  await expect(rowNamed(page, "Fix the nightly backup"), "the first window shows the second window's rename").toBeVisible();
  await expect(rowNamed(page, "Fix the backup cron")).toHaveCount(0);
  expect(ws.lists - lists, "threads.list calls from the first window after the rename").toBe(0);
  await other.close();
});
