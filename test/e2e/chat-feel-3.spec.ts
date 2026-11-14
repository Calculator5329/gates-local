/// <reference lib="dom" />
// Export as Markdown from the thread menu makes no file for a thread deleted
// while its history loads, even when a hover already fetched that history.
import type { Download, Page, WebSocketRoute } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

/**
 * Sits between the page and the server on the app's WebSocket: counts requests
 * by method and can hold chosen methods' answers until released.
 */
interface Tap {
  readonly calls: Map<string, number>;
  readonly hold: Set<string>;
  queued(method: string): number;
  release(method: string): number;
  readonly pending: Set<unknown>;
}

async function tap(page: Page): Promise<Tap> {
  const calls = new Map<string, number>();
  const hold = new Set<string>();
  const held = new Map<string, (() => void)[]>();
  const pending = new Set<unknown>();
  const methodOf = new Map<unknown, string>();
  await page.routeWebSocket(/.*/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const req = parse(m);
      if (req?.type === "request" && typeof req.method === "string") {
        calls.set(req.method, (calls.get(req.method) ?? 0) + 1);
        methodOf.set(req.id, req.method);
        pending.add(req.id);
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const res = parse(m);
      const method = res?.type === "response" ? (methodOf.get(res.id) ?? "") : res?.type === "push" ? channelOf(res) : "";
      const deliver = () => { pending.delete(res?.id); ws.send(m); };
      if (hold.has(method)) {
        const waiting = held.get(method) ?? [];
        waiting.push(deliver); held.set(method, waiting);
      } else deliver();
    });
  });
  return {
    calls,
    hold,
    pending,
    queued: method => held.get(method)?.length ?? 0,
    release: method => {
      hold.delete(method);
      const waiting = held.get(method) ?? [];
      held.delete(method);
      waiting.forEach(deliver => deliver());
      return waiting.length;
    },
  };
}

function channelOf(frame: object): string {
  return "channel" in frame && typeof frame.channel === "string" ? frame.channel : "";
}

function parse(m: string | Buffer): { type?: unknown; id?: unknown; method?: unknown } | undefined {
  if (typeof m !== "string") return undefined;
  try {
    return JSON.parse(m) as { type?: unknown; id?: unknown; method?: unknown };
  } catch {
    return undefined;
  }
}

const row = (page: Page, title: string) => page.locator(".sb-row", { hasText: title });

/** Every download the page starts, from now on. */
function downloads(page: Page): Download[] {
  const got: Download[] = [];
  page.on("download", (d) => got.push(d));
  return got;
}

async function exportRow(page: Page, title: string): Promise<void> {
  await row(page, title).click({ button: "right" });
  await page.getByTestId("sidebar.thread-menu.export").click();
}

test.describe("Export as Markdown from the thread menu", () => {
  test.use({ seed: "design" });
  const OTHER = "Fix the backup cron";

  for (const preload of ["in flight", "cached"] as const) {
    // Guards a shipped bug: a pending hover load let an export finish after its thread was deleted.
    test(`deleting during export ignores hover history ${preload}`, async ({ page, open, seededThread }) => {
      const t = await tap(page);
      await open(`#thread=${seededThread ?? ""}`);
      await waitReady(page);
      await expect(page.locator(".tl .turn").first()).toBeVisible();
      const files = downloads(page);
      if (preload === "in flight") t.hold.add("threads.get");
      const before = t.calls.get("threads.get") ?? 0;
      await row(page, OTHER).hover();
      await expect.poll(() => t.calls.get("threads.get") ?? 0).toBe(before + 1);
      if (preload === "in flight") await expect.poll(() => t.queued("threads.get")).toBe(1);
      else await expect.poll(() => t.pending.size).toBe(0);

      // Hold the export independently: a completed hover is never its source.
      t.hold.add("threads.get");
      await exportRow(page, OTHER);
      const held = preload === "in flight" ? 2 : 1;
      await expect.poll(() => t.queued("threads.get")).toBe(held);
      // Model a delete requested before history arrives but confirmed after it.
      t.hold.add("threads.delete");
      t.hold.add("threads.changed");
      await row(page, OTHER).click({ button: "right" });
      await page.getByTestId("sidebar.thread-menu.delete").click();
      await expect.poll(() => t.queued("threads.delete")).toBe(1);
      expect(t.release("threads.get")).toBe(held);
      await expect.poll(() => t.pending.size).toBe(1);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(files).toHaveLength(0);
      expect(t.release("threads.delete")).toBe(1);
      expect(t.release("threads.changed")).toBe(1);
      await expect(row(page, OTHER)).toHaveCount(0);
      await expect(page.locator('.c-note[role="status"]')).toContainText("it was deleted");
      expect(files).toHaveLength(0);
    });
  }
});
