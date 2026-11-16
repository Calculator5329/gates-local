import { afterEach, expect, test, vi } from "vitest";
import { booting, unread } from "../../runtime/words.tsx";
import { type State, getState } from "../store/store.ts";
import { createConnection } from "./connection.ts";

vi.mock("./index.ts", () => ({ recheckRuntime: () => undefined }));
const pinFrames = vi.hoisted(() => vi.fn());
vi.mock("../../pages/frame-policy.ts", () => ({ pinFramePolicy: pinFrames }));

type Bridge = NonNullable<Window["gatesLocal"]>;
type BridgeState = Parameters<Parameters<Bridge["onState"]>[0]>[0];

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
let booted: ReturnType<typeof createConnection>;
async function boot(hydrate = async () => {}) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  Socket.all = []; vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("indexedDB", undefined);
  booted = createConnection({
    applyServerEvent: () => {}, serverUrl: async () => "ws://fixture", webServerUrl: () => "ws://fixture", desktopBridge: () => undefined,
    hydrate, afterDisconnect: () => {},
  });
  stop = booted.connect(); await vi.advanceTimersByTimeAsync(0);
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

test("F3: with no first read after two seconds the app stops booting and the connection words show", async () => {
  let state: State = { ...getState() };
  vi.useFakeTimers(); vi.setSystemTime(0);
  Socket.all = []; vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("indexedDB", undefined);
  const connection = createConnection({
    applyServerEvent: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    serverUrl: async () => "ws://fixture", webServerUrl: () => "ws://fixture", desktopBridge: () => undefined,
    // the first read never lands
    hydrate: () => new Promise(() => {}), afterDisconnect: () => {},
  });
  stop = connection.connect(); await vi.advanceTimersByTimeAsync(0);
  Socket.all[0]!.open(); await vi.advanceTimersByTimeAsync(0);
  expect(booting(state)).toBe(true);
  await vi.advanceTimersByTimeAsync(1999);
  expect(booting(state)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(booting(state)).toBe(false);
  // nothing is read yet: the words say Connecting, nothing about Ollama
  expect(unread(state)).toBe(true);
});

test("a connection stopped before the boot bound does not end booting two seconds later", async () => {
  let state: State = { ...getState() };
  vi.useFakeTimers(); vi.setSystemTime(0);
  Socket.all = []; vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("indexedDB", undefined);
  const connection = createConnection({
    applyServerEvent: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    serverUrl: async () => "ws://fixture", webServerUrl: () => "ws://fixture", desktopBridge: () => undefined,
    hydrate: () => new Promise(() => {}), afterDisconnect: () => {},
  });
  const end = connection.connect(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(500);
  end();
  await vi.advanceTimersByTimeAsync(2000);
  expect(state.bootWaited).toBe(false);
});

function desktopBridge(): { bridge: Bridge; say: (state: BridgeState) => void } {
  const listeners = new Set<(state: BridgeState) => void>();
  const bridge: Bridge = {
    getServerUrl: async () => "ws://127.0.0.1:5286/ws",
    onState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { bridge, say: (state) => { for (const listener of listeners) listener(state); } };
}

async function reachServer(bridge: Bridge | undefined): Promise<void> {
  const connection = createConnection({
    applyServerEvent: () => {}, serverUrl: async () => "ws://127.0.0.1:5286/ws", webServerUrl: () => "ws://127.0.0.1:5286/ws", desktopBridge: () => bridge,
    hydrate: async () => {}, afterDisconnect: () => {},
  });
  stop = connection.connect(); await vi.advanceTimersByTimeAsync(0);
  stop();
}

test("while the desktop app has no server yet, the next try comes as soon as it says its server is ready, not a minute later", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  Socket.all = []; vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("indexedDB", undefined);
  const { bridge, say } = desktopBridge();
  let asked = 0;
  const connection = createConnection({
    applyServerEvent: () => {}, serverUrl: async () => { asked++; return null; }, webServerUrl: () => null, desktopBridge: () => bridge,
    hydrate: async () => {}, afterDisconnect: () => {},
  });
  stop = connection.connect(); await vi.advanceTimersByTimeAsync(0);
  expect(asked).toBe(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(asked).toBe(1);
  say({ status: "starting" }); await vi.advanceTimersByTimeAsync(0);
  expect(asked).toBe(1);
  say({ status: "ready", serverUrl: "ws://127.0.0.1:5286/ws" }); await vi.advanceTimersByTimeAsync(0);
  expect(asked).toBe(2);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(asked).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(asked).toBe(3);
});

test("a browser tab pins its frames to the server it talks to; the desktop app leaves its frames to its own main process", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  Socket.all = []; vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("indexedDB", undefined); vi.stubGlobal("document", {});
  pinFrames.mockClear();
  await reachServer(desktopBridge().bridge);
  expect(Socket.all).toHaveLength(1);
  expect(pinFrames).not.toHaveBeenCalled();
  await reachServer(undefined);
  expect(Socket.all).toHaveLength(2);
  expect(pinFrames.mock.calls).toEqual([["http://127.0.0.1:5286"]]);
});

test("a send waiting minutes for its model to load is still answered, and ends only when the socket does", async () => {
  const socket = await boot();
  let outcome: unknown;
  void booted.reply("reply.send", { id: "r1", threadId: "t1", messageId: "m1", text: "hi" }).then((a) => { outcome = a; });
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(outcome).toBeUndefined();
  socket.close(); await vi.advanceTimersByTimeAsync(0);
  expect(outcome).toEqual({ answer: "not-reached", why: "closed" });
});
