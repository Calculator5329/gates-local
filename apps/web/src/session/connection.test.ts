import { afterEach, expect, test, vi } from "vitest";
import { createConnection } from "./connection.ts";

class Socket extends EventTarget {
  static all: Socket[] = [];
  readyState = 0;
  constructor() { super(); Socket.all.push(this); }
  send() {}
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
let stop = () => {};
afterEach(async () => {
  stop(); for (const socket of Socket.all) socket.close();
  await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals();
});
async function boot(hydrate = async () => {}) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  Socket.all = []; vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("indexedDB", undefined);
  const connection = createConnection({
    applyServerEvent: () => {}, serverUrl: async () => "ws://fixture", webServerUrl: () => "ws://fixture", desktopBridge: () => undefined,
    hydrate, beforeDisconnect: () => {}, afterDisconnect: () => {},
  });
  stop = connection.connect(); await vi.advanceTimersByTimeAsync(0);
  const first = Socket.all[0]; if (!first) throw new Error("Missing initial socket");
  first.open(); await vi.advanceTimersByTimeAsync(0);
  return first;
}

test("a hydrated connection retries after one frame instead of waiting 250 ms", async () => {
  const first = await boot(); first.close(); await vi.advanceTimersByTimeAsync(15);
  expect(Socket.all).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(Socket.all).toHaveLength(2);
});

test("failed opens retain exponential backoff", async () => {
  const first = await boot(); first.close(); await vi.advanceTimersByTimeAsync(16);
  expect(Socket.all).toHaveLength(2);
  Socket.all[1]!.close();
  await vi.advanceTimersByTimeAsync(499); expect(Socket.all).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); expect(Socket.all).toHaveLength(3);
  Socket.all[2]!.close();
  await vi.advanceTimersByTimeAsync(999); expect(Socket.all).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1); expect(Socket.all).toHaveLength(4);
});

test("repeated hydrated drops cannot take the fast retry more than once per second", async () => {
  const first = await boot(); first.close(); await vi.advanceTimersByTimeAsync(16);
  expect(Socket.all).toHaveLength(2);
  Socket.all[1]!.open(); await vi.advanceTimersByTimeAsync(0); Socket.all[1]!.close();
  await vi.advanceTimersByTimeAsync(249); expect(Socket.all).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); expect(Socket.all).toHaveLength(3);
  Socket.all[2]!.open(); await vi.advanceTimersByTimeAsync(734); Socket.all[2]!.close();
  await vi.advanceTimersByTimeAsync(16); expect(Socket.all).toHaveLength(4);
});

test("failed hydration never grants an immediate retry", async () => {
  const first = await boot(async () => { throw new Error("negotiation failed"); });
  first.close(); await vi.advanceTimersByTimeAsync(249); expect(Socket.all).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(Socket.all).toHaveLength(2);
});
