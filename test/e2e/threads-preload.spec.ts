/// <reference lib="dom" />
import { test, expect, sendMessage, waitReady } from "./fixtures.ts";

test.use({ seed: "design", video: "on" });

test("hover intent fetches history once before selection; sweeping and the active row do not", async ({ page, open, seededThread }, testInfo) => {
  const requests: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    const request = JSON.parse(String(frame.payload)) as { method?: string; params?: { threadId?: string } };
    if (request.method === "threads.get" && request.params?.threadId) requests.push(request.params.threadId);
  }));
  await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
  await expect(page.locator(".tl .turn")).not.toHaveCount(0);
  const id = await page.locator(".sb-row:not(.on)").first().getAttribute("data-thread");
  expect(id).toBeTruthy();
  const target = page.locator(`.sb-row[data-thread="${id}"] .sb-thread`);
  const before = requests.length;
  await target.hover();
  await expect.poll(() => requests.slice(before)).toEqual([id]);
  await expect(page.locator(".hdr h2")).toHaveText("Library: Effect Schema books");
  await target.click();
  await expect(page.locator(".sb-row.on")).toHaveAttribute("data-thread", id!);
  await expect(page.locator(".tl")).toHaveAttribute("aria-busy", "false");
  await page.mouse.move(1000, 200);
  await target.hover();
  // Observe beyond the intent delay: revisiting the active row sends nothing.
  await page.waitForTimeout(350);
  expect(requests.slice(before)).toEqual([id]);
  await page.screenshot({ path: testInfo.outputPath("preloaded-thread.png") });
});

test("another window's new message replaces prefetched history before selection", async ({ page, context, open, seededThread }) => {
  const fetched: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    const request = JSON.parse(String(frame.payload)) as { method?: string; params?: { threadId?: string } };
    if (request.method === "threads.get" && request.params?.threadId) fetched.push(request.params.threadId);
  }));
  await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
  const id = await page.locator(".sb-row:not(.on)").first().getAttribute("data-thread");
  expect(id).toBeTruthy();
  const target = page.locator(`.sb-row[data-thread="${id}"] .sb-thread`);
  await target.hover(); await expect.poll(() => fetched.filter(value => value === id).length).toBe(1);
  const other = await context.newPage();
  try {
    const url = new URL(page.url()); url.hash = `thread=${id}`;
    await other.goto(url.href); await waitReady(other);
    await sendMessage(other, "A new question from the other window");
    await expect(other.locator(".turn.a.done")).toHaveCount(1);
    await target.click();
    await expect(page.locator(".turn.u .bubble").last()).toHaveText("A new question from the other window");
    await expect(page.locator(".turn.a.done")).toHaveCount(1);
  } finally { await other.close(); }
});

test.describe("touch sidebar", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("does not speculate on a touch-only listener", async ({ page, open, seededThread }) => {
    let gets = 0;
    page.on("websocket", socket => socket.on("framesent", frame => {
      const request = JSON.parse(String(frame.payload)) as { method?: string };
      if (request.method === "threads.get") gets++;
    }));
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    await expect(page.locator(".tl .turn")).not.toHaveCount(0);
    await page.locator("#menuBtn").click();
    const before = gets;
    await page.locator(".sb-row:not(.on) .sb-thread").first().hover();
    await page.waitForTimeout(350);
    expect(gets).toBe(before);
  });
});

