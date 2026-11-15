// Two faults a person could see in the window, each reached here by what the server sends: a typed
// draft lost when a thread list the window read left its chat out (the list read on a reconnect came
// back without it, then its row came again), and a finished download that moved an older file aside saying nothing of
// where it went. Each spec takes its picture after a soft check, so a run on code without the fix
// still leaves the picture of what a person saw, and fails.
import type { Page, WebSocketRoute } from "@playwright/test";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { numberedRoute } from "./numbered-route.ts";

type Frame = { type?: string; id?: string; method?: string; result?: unknown };

/** The boxes of `around` with 16 px to spare, `marked` outlined in amber: the part the fix touched. */
async function shot(page: Page, around: string, marked: string, path: string) {
  await page.mouse.move(5, 5);
  const outline = (show: boolean) => page.locator(marked).evaluateAll((els, lit) => {
    for (const el of els) { (el as HTMLElement).style.outline = lit ? "2px solid #f59e0b" : ""; (el as HTMLElement).style.outlineOffset = lit ? "2px" : ""; }
  }, show);
  await outline(true);
  const boxes = await page.locator(around).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom }; }));
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 16), y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 16);
  await page.screenshot({ path, clip: { x, y, width: Math.max(...boxes.map((b) => b.r)) + 16 - x, height: Math.max(...boxes.map((b) => b.b)) + 16 - y }, animations: "disabled" });
  await outline(false);
}

const replied = async (page: Page) => {
  await expect(page.locator(".turn.a")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
};

test("a typed draft stays when a thread list the window reads leaves its chat out for a moment", async ({ page, open }, info) => {
  // the title the next threads.list answer leaves out, or null to pass the server's answer on whole
  let omit: string | null = null;
  const lists = new Set<string>();
  // each chat's row as the server last listed it, by title
  const rows = new Map<string, { id: string; title: string }>();
  let route: WebSocketRoute | undefined;
  let cut: (() => void) | undefined;
  let listed = 0;
  await page.routeWebSocket(/\/\?token=/, (routed) => {
    const { page: socket } = numberedRoute(routed);
    route = socket;
    const server = socket.connectToServer();
    cut = () => { void routed.close(); void server.close(); };
    socket.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as Frame;
      if (m.method === "threads.list" && m.id !== undefined) lists.add(m.id);
      server.send(raw);
    });
    server.onMessage((raw) => {
      const f = JSON.parse(String(raw)) as Frame;
      const left = omit;
      if (f.type === "response" && f.id !== undefined && lists.delete(f.id) && Array.isArray(f.result)) {
        listed += 1;
        for (const t of f.result as { id: string; title: string }[]) rows.set(t.title, t);
        if (left !== null) {
          socket.send(JSON.stringify({ ...f, result: (f.result as { title?: string }[]).filter((t) => t.title !== left) }));
          return;
        }
      }
      socket.send(raw);
    });
  });
  await open(); await waitReady(page);
  await sendMessage(page, "First chat");
  await replied(page);
  await page.getByTestId("sidebar.top.new-thread").click();
  await sendMessage(page, "Second chat");
  await replied(page);
  const second = page.locator(".sb-row", { hasText: "Second chat" });
  await page.locator("#ta").fill("Second chat, words not sent yet");
  await page.locator(".sb-row", { hasText: "First chat" }).click();
  await expect(page.locator("#ta")).toHaveValue("");
  // the connection drops, and the list read on the next one leaves the second chat out
  omit = "Second chat";
  const before = listed;
  cut!();
  await expect.poll(() => listed, "the new connection read the list").toBe(before + 1);
  await waitReady(page);
  await expect(second).toHaveCount(0);
  // then its row arrives as the newest word on it
  omit = null;
  const row = rows.get("Second chat");
  expect(row, "the second chat was listed before").toBeDefined();
  route!.send(JSON.stringify({ type: "push", channel: "threads.changed", payload: { threadId: row!.id, thread: row } }));
  await expect(second).toHaveCount(1);
  await second.click();
  await expect(page.locator(".turn.a")).toHaveCount(1);
  await expect.soft(page.locator("#ta"), "the second chat's words are still in its box").toHaveValue("Second chat, words not sent yet");
  await shot(page, ".composer", ".composer textarea", info.outputPath("item1-draft.png"));
  await expect(page.locator("#ta")).toHaveValue("Second chat, words not sent yet");
});

test.describe("a setup's download", () => {
  let comfy: Awaited<ReturnType<typeof fakeComfy>>;
  test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); comfy.withFolders(); });
  test.afterEach(async () => { await comfy.close(); });

  test("a finished download that moved an older file aside says where it was kept, where its bar was", async ({ page, open }, info) => {
    let route: WebSocketRoute | undefined;
    await page.routeWebSocket(/\/\?token=/, (routed) => { route = numberedRoute(routed).page; });
    await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
    await open(); await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await page.getByTestId("settings.nav.open-images").click();
    await page.getByTestId("settings.images.enable").click();
    await expect(page.getByTestId("settings.images.enable")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await waitReady(page);
    await page.getByTestId("chat.composer.image").click();
    await page.locator("#modelBtn").click();
    const disk = page.getByTestId("image.picker.disk");
    await expect(disk.getByTestId("image.picker.disk-free")).toBeVisible();
    // the server's last word on a download whose file was already there (image/download.ts)
    const message = "A file named flux-2-klein-4b.safetensors was already there. It was kept as flux-2-klein-4b.safetensors.old-1.";
    route!.send(JSON.stringify({ type: "push", channel: "image.download", payload: { name: "flux-2-klein-4b.safetensors", state: "done", completedBytes: 4096, totalBytes: 4096, message, preset: "flux2-klein-4b", file: 1, files: 1, ended: true } }));
    await expect.soft(disk.getByRole("status"), "the note where the bar was").toHaveText(message);
    await shot(page, "#imagePicker", "[data-testid='image.picker.disk']", info.outputPath("item2-kept-as.png"));
    await expect(disk.getByRole("status")).toHaveText(message);
    await expect(page.getByText(message)).toHaveCount(1);
  });
});
