/// <reference lib="dom" />
// Fixes from the first review of the chat-feel lane: a failed fit check ends
// the held verdict, Export as Markdown makes a file only from a loaded thread,
// and a download row's fit follows the picker's context.
import { readFile } from "node:fs/promises";
import type { Download, Page, WebSocketRoute } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

/**
 * Sits between the page and the server on the app's WebSocket: counts requests
 * by method, can answer chosen methods with an error, and can push a frame to
 * the page as if the server sent it.
 */
interface Tap {
  readonly calls: Map<string, number>;
  /** Methods answered with an error instead of reaching the server. */
  readonly fail: Set<string>;
  /** Methods whose answer reaches the page this many ms late (the server has already acted). */
  readonly late: Map<string, number>;
  push(channel: string, payload: unknown): void;
}

async function tap(page: Page): Promise<Tap> {
  const calls = new Map<string, number>();
  const fail = new Set<string>();
  const late = new Map<string, number>();
  const methodOf = new Map<unknown, string>();
  let app: WebSocketRoute | undefined;
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const req = parse(m);
      if (req?.type === "request" && typeof req.method === "string") {
        // the app's socket, not the dev server's reload socket
        app = ws;
        calls.set(req.method, (calls.get(req.method) ?? 0) + 1);
        methodOf.set(req.id, req.method);
        if (fail.has(req.method)) {
          ws.send(JSON.stringify({ type: "response", id: req.id, ok: false, error: { code: "internal", message: "test: refused by the tap" } }));
          return;
        }
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const res = parse(m);
      const ms = res?.type === "response" ? late.get(methodOf.get(res.id) ?? "") : undefined;
      if (ms === undefined) ws.send(m);
      else setTimeout(() => ws.send(m), ms);
    });
  });
  return {
    calls,
    fail,
    late,
    push: (channel, payload) => app?.send(JSON.stringify({ type: "push", channel, payload })),
  };
}

function parse(m: string | Buffer): { type?: unknown; id?: unknown; method?: unknown } | undefined {
  if (typeof m !== "string") return undefined;
  try {
    return JSON.parse(m) as { type?: unknown; id?: unknown; method?: unknown };
  } catch {
    return undefined;
  }
}

/** Gemma 4 12B at 64k: the fake GPU refuses it, and Send says so. */
async function refusedGemma(page: Page): Promise<void> {
  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill("gemma");
  await page.locator('#picker .pk-r[data-m="gemma4:12b"]').click();
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).click();
  await page.locator(".set").getByRole("button", { name: "64k" }).first().click();
  await expect(page.locator(".set")).toContainText("Needs ");
  await page.keyboard.press("Escape");
  await page.locator("#ta").fill("Too big?");
  await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("data-tip", /not enough memory at 64k/);
}

test.describe("a failed fit check", () => {
  test("memory frees and the refresh fails: Send is not left refused by the old verdict, and the check is asked again", async ({ page, open }) => {
    const t = await tap(page);
    await open();
    await waitReady(page);
    await refusedGemma(page);
    const send = page.getByRole("button", { name: "Send message" });
    await expect(send).toHaveAttribute("aria-disabled", "true");
    // let the checks in flight answer: a push during one is overwritten by its answer
    await page.waitForTimeout(500);

    // another model leaves the GPU; the fresh check fails
    t.fail.add("fit.check");
    const before = t.calls.get("fit.check") ?? 0;
    t.push("models.load", { model: "qwen3.5:9b", numCtx: 16384, state: "unloaded" });
    await expect.poll(() => t.calls.get("fit.check") ?? 0).toBeGreaterThan(before);
    await expect(send).not.toHaveAttribute("data-tip", /not enough memory/);
    await expect(send).not.toHaveAttribute("aria-disabled", /./);

    // a failure is not a verdict to keep: the check is asked again with no other change
    t.fail.delete("fit.check");
    await expect(send).toHaveAttribute("data-tip", /not enough memory at 64k/, { timeout: 15_000 });
  });

  test("a load error invalidates the fit checks", async ({ page, open }) => {
    const t = await tap(page);
    await open();
    await waitReady(page);
    await refusedGemma(page);
    await page.waitForTimeout(500);
    const before = t.calls.get("fit.check") ?? 0;
    t.push("models.load", { model: "gemma4:12b", numCtx: 65536, state: "error", message: "test: the load failed" });
    await expect.poll(() => t.calls.get("fit.check") ?? 0).toBeGreaterThan(before);
    await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("data-tip", /not enough memory at 64k/);
  });
});

const row = (page: Page, title: string) => page.locator(".sb-row", { hasText: title });

/** Every download the page starts, from now on. */
function downloads(page: Page): Download[] {
  const got: Download[] = [];
  page.on("download", (d) => got.push(d));
  return got;
}

async function exportRow(page: Page, title: string): Promise<void> {
  await row(page, title).click({ button: "right" });
  await page.locator("#moreMenu").getByRole("menuitem", { name: "Export as Markdown" }).click();
}

test.describe("Export as Markdown from the thread menu", () => {
  test.use({ seed: "design" });
  const OTHER = "Fix the backup cron";

  test("a thread not loaded yet exports from its own load, and the open thread stays open", async ({ page, open, seededThread }) => {
    const t = await tap(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    t.late.set("threads.get", 1000);
    const got = page.waitForEvent("download");
    await exportRow(page, OTHER);
    const file = await got;
    expect(file.suggestedFilename()).toBe(`${OTHER}.md`);
    const md = await readFile(await file.path(), "utf8");
    expect(md.startsWith(`# ${OTHER}\n`)).toBe(true);
    expect(md).toContain("## You");
    await expect(page.locator(".hdr h2")).toHaveText("Library: Effect Schema books");
  });

  test("a load that fails says so and makes no file", async ({ page, open, seededThread }) => {
    const t = await tap(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const files = downloads(page);
    t.fail.add("threads.get");
    await exportRow(page, OTHER);
    await expect(page.getByRole("status")).toContainText(`Couldn't export “${OTHER}”`);
    await page.waitForTimeout(1000);
    expect(files).toHaveLength(0);
  });

  test("a load slower than the limit says so and makes no file", async ({ page, open, seededThread }) => {
    const t = await tap(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const files = downloads(page);
    t.late.set("threads.get", 12_000);
    await exportRow(page, OTHER);
    await expect(page.getByRole("status")).toContainText("took too long", { timeout: 12_000 });
    await page.waitForTimeout(1000);
    expect(files).toHaveLength(0);
  });

  test("a thread deleted while it loads says so and makes no file", async ({ page, open, seededThread }) => {
    const t = await tap(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const files = downloads(page);
    t.late.set("threads.get", 1500);
    await exportRow(page, OTHER);
    await row(page, OTHER).click({ button: "right" });
    await page.locator("#moreMenu").getByRole("menuitem", { name: "Delete thread" }).click();
    await expect(row(page, OTHER)).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("it was deleted");
    await page.waitForTimeout(1000);
    expect(files).toHaveLength(0);
  });
});
