/// <reference lib="dom" />
// Fixes from the first review of the chat-feel lane: a failed fit check ends
// the held verdict, Export as Markdown makes a file only from a loaded thread,
// and a download row's fit follows the picker's context.
import type { Page, WebSocketRoute } from "@playwright/test";
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
  push(channel: string, payload: unknown): void;
}

async function tap(page: Page): Promise<Tap> {
  const calls = new Map<string, number>();
  const fail = new Set<string>();
  let app: WebSocketRoute | undefined;
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const req = parse(m);
      if (req?.type === "request" && typeof req.method === "string") {
        // the app's socket, not the dev server's reload socket
        app = ws;
        calls.set(req.method, (calls.get(req.method) ?? 0) + 1);
        if (fail.has(req.method)) {
          ws.send(JSON.stringify({ type: "response", id: req.id, ok: false, error: { code: "internal", message: "test: refused by the tap" } }));
          return;
        }
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return {
    calls,
    fail,
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
