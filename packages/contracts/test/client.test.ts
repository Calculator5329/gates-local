import { afterEach, describe, expect, it, vi } from "vitest";
import { type SocketLike, WireError, createClient, encodeResult } from "../src/index.ts";
import { methodSamples, pushSamples } from "../src/testing.ts";

type Listener = (event: { data?: unknown }) => void;

/** In-memory WebSocket stand-in: records sends, lets the test fire events. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<Listener>>();
  send(data: string) {
    if (this.readyState !== 1) throw new Error("InvalidStateError");
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.fire("close", {});
  }
  addEventListener(type: string, l: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(l);
  }
  removeEventListener(type: string, l: Listener) {
    this.listeners.get(type)?.delete(l);
  }
  fire(type: string, event: { data?: unknown }) {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  open() {
    this.readyState = 1;
    this.fire("open", {});
  }
  lastRequest(): { id: string; method: string; params: unknown } {
    const last = this.sent.at(-1);
    if (last === undefined) throw new Error("nothing sent");
    return JSON.parse(last) as { id: string; method: string; params: unknown };
  }
  reply(frame: unknown) {
    this.fire("message", { data: frame });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createClient", () => {
  it("queues calls made while connecting and sends them on open", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    const p = client.call("threads.list", {});
    expect(socket.sent).toEqual([]);
    socket.open();
    const req = socket.lastRequest();
    expect(req.method).toBe("threads.list");
    const frame = encodeResult(req.id, "threads.list", methodSamples["threads.list"].result);
    if (!frame.ok) throw frame.error;
    socket.reply(frame.value);
    await expect(p).resolves.toEqual(methodSamples["threads.list"].result);
  });

  it("decodes results on the client and rejects a result that breaks its Schema", async () => {
    const socket = new FakeSocket();
    socket.open();
    const client = createClient(socket, { onProtocolError: () => {} });
    const p = client.call("runtime.status", {});
    const { id } = socket.lastRequest();
    socket.reply(JSON.stringify({ type: "response", id, ok: true, result: { state: "sleepy" } }));
    await expect(p).rejects.toMatchObject({ name: "WireError", code: "bad-result" });
  });

  it("passes a server error code through", async () => {
    const socket = new FakeSocket();
    socket.open();
    const client = createClient(socket);
    const p = client.call("threads.get", { threadId: "nope" });
    const { id } = socket.lastRequest();
    socket.reply(JSON.stringify({ type: "response", id, ok: false, error: { code: "not-found", message: "no thread" } }));
    await expect(p).rejects.toMatchObject({ code: "not-found", message: "no thread" });
  });

  it("refuses params that break the Schema before sending", async () => {
    const socket = new FakeSocket();
    socket.open();
    const client = createClient(socket);
    await expect(client.call("fit.check", { model: "m", numCtx: -1 })).rejects.toMatchObject({ code: "bad-params" });
    expect(socket.sent).toEqual([]);
  });

  it("times out a call and reports the late response instead of resolving", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.open();
    const errors: WireError[] = [];
    const client = createClient(socket, { timeoutMs: 50, onProtocolError: (e) => errors.push(e) });
    const p = client.call("models.refresh", {});
    const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
    vi.advanceTimersByTime(51);
    await assertion;
    const { id } = socket.lastRequest();
    socket.reply(JSON.stringify({ type: "response", id, ok: true, result: [] }));
    expect(errors.map((e) => e.code)).toEqual(["bad-message"]);
  });

  it("rejects every pending call when the socket closes, and later calls too", async () => {
    const socket = new FakeSocket();
    socket.open();
    const client = createClient(socket);
    const a = client.call("threads.list", {});
    const b = client.call("chat.cancel", { turnId: "x" });
    socket.readyState = 3;
    socket.fire("close", {});
    await expect(a).rejects.toMatchObject({ code: "closed" });
    await expect(b).rejects.toMatchObject({ code: "closed" });
    await expect(client.call("threads.list", {})).rejects.toBeInstanceOf(WireError);
    await expect(client.closed).resolves.toBeUndefined();
  });

  it("client.close() rejects pending calls at once", async () => {
    const socket = new FakeSocket();
    socket.open();
    socket.close = () => {
      socket.readyState = 2; // closing handshake never finishes in this fake
    };
    const client = createClient(socket);
    const a = client.call("threads.list", {});
    client.close();
    await expect(a).rejects.toMatchObject({ code: "closed" });
  });

  it("delivers decoded pushes to subscribers, drops bad ones, and unsubscribes", () => {
    const socket = new FakeSocket();
    socket.open();
    const errors: string[] = [];
    const client = createClient(socket, { onProtocolError: (e) => errors.push(e.code) });
    const got: unknown[] = [];
    const off = client.subscribe("threads.changed", (p) => got.push(p.threadId));
    socket.reply(JSON.stringify({ type: "push", channel: "threads.changed", payload: { threadId: "t1" } }));
    socket.reply(JSON.stringify({ type: "push", channel: "threads.changed", payload: { threadId: 1 } }));
    socket.reply(JSON.stringify({ type: "push", channel: "nope", payload: {} }));
    socket.reply("garbage");
    socket.reply(Buffer.from(JSON.stringify({ type: "push", channel: "models.changed", payload: pushSamples["models.changed"][0] })));
    off();
    socket.reply(JSON.stringify({ type: "push", channel: "threads.changed", payload: { threadId: "t2" } }));
    expect(got).toEqual(["t1"]);
    expect(errors).toEqual(["bad-payload", "bad-payload", "bad-message"]);
  });
});
