// Settings is the first complete ordered domain. Refusal
// stand-ins exercise an older server; ordinary RPCs still use the real server.
import { decodeRequest, decodeResult, decodeServerMessage } from "@gates-local/contracts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

for (const [width, code] of [[1440, "unknown-method"], [390, "not-implemented"]] as const) {
  test(`a ${width}px client chats with an older server's ${code} negotiation refusal`, async ({ page, open }) => {
    await page.setViewportSize({ width, height: 900 });
    let negotiations = 0;
    await page.routeWebSocket(/.*/, ws => {
      const server = ws.connectToServer();
      ws.onMessage(message => {
        const request = decodeRequest(String(message));
        if (request.ok && request.value.method === "sync.negotiate") {
          negotiations++;
          expect(request.value.params.ordered).toEqual(["settings"]);
          ws.send(JSON.stringify({ type: "response", id: request.value.id, ok: false, error: { code, message: "Older server" } }));
        } else server.send(message);
      });
      server.onMessage(message => ws.send(message));
    });
    await open(); await waitReady(page);
    expect(negotiations).toBe(1);
    await sendMessage(page, "Legacy connection");
    await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Legacy connection");
  });
}

test.describe("process negotiation", () => {
  test.use({ allowedErrors: [/WebSocket connection to .* failed/] });
  test("new peers order settings, an old peer receives unchanged envelopes, and restart changes epoch", async ({ page, open }) => {
    const epochs: string[] = [];
    let url = "";
    await page.routeWebSocket(/.*/, ws => {
      url = ws.url();
      const ids = new Set<string>();
      const server = ws.connectToServer();
      ws.onMessage(message => {
        const request = decodeRequest(String(message));
        if (request.ok && request.value.method === "sync.negotiate") ids.add(request.value.id);
        server.send(message);
      });
      server.onMessage(message => {
        const response = decodeServerMessage(String(message));
        if (response.ok && response.value.type === "response" && response.value.ok && ids.delete(response.value.id)) {
          const result = decodeResult("sync.negotiate", response.value.result);
          if (!result.ok) throw result.error;
          expect(result.value.ordered).toEqual(["settings"]);
          epochs.push(result.value.epoch);
        }
        ws.send(message);
      });
    });
    await open(); await waitReady(page);
    // a booting composer takes typing before the negotiation has its answer
    await expect.poll(() => epochs.length).toBe(1);
    // This peer implements the old envelopes only and never negotiates.
    const legacy = await page.evaluate(socketUrl => new Promise<unknown>((resolve, reject) => {
      const socket = new WebSocket(socketUrl);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "request", id: "old-peer", method: "threads.list", params: {} })));
      socket.addEventListener("error", () => { socket.close(); reject(new Error("Old peer could not connect")); });
      socket.addEventListener("message", event => {
        const value: unknown = JSON.parse(String(event.data));
        if (typeof value === "object" && value !== null && "id" in value && value.id === "old-peer") { socket.close(); resolve(value); }
      });
    }), url);
    expect(legacy).toEqual({ type: "response", id: "old-peer", ok: true, result: [] });
    expect(epochs).toHaveLength(1);
    await stack.restart(1000);
    await expect.poll(() => epochs.length).toBe(2);
    await waitReady(page);
    expect(epochs[1]).not.toBe(epochs[0]);
    await sendMessage(page, "New process");
    await expect(page.locator(".turn.a .md").last()).toContainText("You asked: New process");
  });
});
