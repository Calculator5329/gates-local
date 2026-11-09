import { afterEach, expect, test, vi } from "vitest";
import { NativeCdp } from "./native-cdp.ts";

class Socket extends EventTarget {
  static latest: Socket;
  sent: { id: number; method: string }[] = [];
  constructor() { super(); Socket.latest = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(text: string) { this.sent.push(JSON.parse(text) as { id: number; method: string }); }
  answer(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  close() { this.dispatchEvent(new Event("close")); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
test("native page commands match replies by id and return renderer values", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const cdp = await NativeCdp.connect("unused");
  const a = cdp.evaluate("one"), b = cdp.evaluate("two");
  Socket.latest.answer({ id: 2, result: { result: { value: "second" } } });
  Socket.latest.answer({ id: 1, result: { result: { value: "first" } } });
  expect(await a).toBe("first"); expect(await b).toBe("second"); cdp.close();
});
test("protocol errors, renderer exceptions and closed sockets reject measurements", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const cdp = await NativeCdp.connect("unused");
  const rejected = cdp.call("Bad.command");
  Socket.latest.answer({ id: 1, error: { message: "refused" } });
  await expect(rejected).rejects.toThrow("refused");
  const exception = cdp.evaluate("throws");
  Socket.latest.answer({ id: 2, result: { exceptionDetails: {} } });
  await expect(exception).rejects.toThrow("evaluation failed");
  const closed = cdp.call("Pending.command"); cdp.close();
  await expect(closed).rejects.toThrow("closed");
});
