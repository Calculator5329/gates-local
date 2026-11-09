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
  it("accepts negotiation synchronously before a following ordered push", async () => {
    const socket = new FakeSocket(); socket.open();
    const client = createClient(socket);
    const seen: unknown[] = [];
    client.subscribe("settings.changed", (value, sync) => seen.push([value, sync]));
    const ready = client.negotiate();
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: true, result: { epoch: "current", ordered: ["settings"] } }));
    expect(client.sync).toEqual({ mode: "ordered", epoch: "current", domains: ["settings"] });
    const sync = { epoch: "current", changes: [{ scope: "settings", kind: "snapshot", rev: 0 }] };
    socket.reply(JSON.stringify({ type: "push", channel: "settings.changed", payload: methodSamples["settings.get"].result, sync }));
    await ready;
    expect(seen).toEqual([[methodSamples["settings.get"].result, sync]]);
    client.close();
  });

  it.each([
    undefined,
    { epoch: "old", changes: [{ scope: "settings", kind: "snapshot", rev: 1 }] },
    { epoch: "current", changes: [] },
    { epoch: "current", changes: [{ scope: "settings", kind: "invalidate", rev: 1 }] },
    { epoch: "current", changes: [{ scope: "settings", kind: "snapshot", rev: 1 }, { scope: "settings", kind: "snapshot", rev: 2 }] },
  ])("ordered settings rejects missing, foreign or ambiguous metadata: %j", async sync => {
    const socket = new FakeSocket(); socket.open();
    const errors: WireError[] = [];
    const client = createClient(socket, { onProtocolError: error => errors.push(error) });
    const ready = client.negotiate();
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: true, result: { epoch: "current", ordered: ["settings"] } }));
    await ready;
    const result = client.call("settings.get", {});
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: true, result: methodSamples["settings.get"].result, sync }));
    await expect(result).rejects.toMatchObject({ code: "bad-message" });
    expect(errors).toEqual([expect.objectContaining({ code: "bad-message" })]);
    expect(socket.readyState).toBe(3);
    expect(client.sync).toBeUndefined();
  });

  it("ordered pushes without required metadata resynchronize instead of silently using legacy mode", async () => {
    const socket = new FakeSocket(); socket.open();
    const errors: WireError[] = [];
    const client = createClient(socket, { onProtocolError: error => errors.push(error) });
    const ready = client.negotiate();
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: true, result: { epoch: "current", ordered: ["settings"] } }));
    await ready;
    const seen: unknown[] = [];
    client.subscribe("settings.changed", value => seen.push(value));
    socket.reply(JSON.stringify({ type: "push", channel: "settings.changed", payload: methodSamples["settings.get"].result }));
    expect(seen).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "bad-message" })]);
    expect(socket.readyState).toBe(3);
  });
  it.each([false, true])("SS6-02/03: a throwing metadata hook preserves delivery and acknowledgement (reporter throws=%s)", async reporterThrows => {
    const socket = new FakeSocket(); socket.open();
    const errors: WireError[] = [];
    const client = createClient(socket, { onProtocolError: error => {
      errors.push(error);
      if (reporterThrows) throw new Error("Reporter failed");
    } });
    const created = methodSamples["threads.create"].result;
    const result = client.call("threads.create", { title: "First" }, { onMetadata: () => { throw new Error("Observer failed"); } });
    const frame = encodeResult(socket.lastRequest().id, "threads.create", created);
    if (!frame.ok) throw frame.error;
    expect(() => socket.reply(frame.value)).not.toThrow();
    await expect(result).resolves.toEqual(created);
    expect(errors).toEqual([expect.objectContaining({ code: "internal", message: "metadata callback threw: Observer failed" })]);
    expect(socket.readyState).toBe(1);
    client.close();
  });

  it.each([false, true])("SS6-02/03: a throwing push subscriber preserves other subscribers and acknowledgements (reporter throws=%s)", async reporterThrows => {
    const socket = new FakeSocket(); socket.open();
    const errors: WireError[] = [];
    const client = createClient(socket, { onProtocolError: error => {
      errors.push(error);
      if (reporterThrows) throw new Error("Reporter failed");
    } });
    const got: unknown[] = [];
    const sync = { epoch: "process-a", changes: [{ scope: "threads", kind: "snapshot", rev: 1 }] };
    client.subscribe("threads.changed", (_payload, metadata) => { expect(metadata).toEqual(sync); throw new Error("Push observer failed"); });
    client.subscribe("threads.changed", (payload, metadata) => got.push([payload, metadata]));
    const result = client.call("threads.create", { title: "First" });
    expect(() => socket.reply(JSON.stringify({ type: "push", channel: "threads.changed", payload: { threadId: "one" }, sync }))).not.toThrow();
    const frame = encodeResult(socket.lastRequest().id, "threads.create", methodSamples["threads.create"].result);
    if (!frame.ok) throw frame.error;
    socket.reply(frame.value);
    await expect(result).resolves.toEqual(methodSamples["threads.create"].result);
    expect(got).toEqual([[{ threadId: "one" }, sync]]);
    expect(errors).toEqual([expect.objectContaining({ code: "internal", message: "subscriber for threads.changed threw: Push observer failed" })]);
    expect(socket.readyState).toBe(1);
    client.close();
  });
  it("negotiates settings once per socket and retains legacy mode when the server selects none", async () => {
    const socket = new FakeSocket(); socket.open();
    const client = createClient(socket);
    expect(client.sync).toBeUndefined();
    const first = client.negotiate();
    expect(client.negotiate()).toBe(first);
    const request = socket.lastRequest();
    expect(request).toMatchObject({ method: "sync.negotiate", params: { ordered: ["settings"] } });
    socket.reply(JSON.stringify({ type: "response", id: request.id, ok: true, result: { epoch: "process-a", ordered: [] } }));
    await expect(first).resolves.toEqual({ mode: "legacy", epoch: "process-a" });
    expect(client.sync).toEqual({ mode: "legacy", epoch: "process-a" });
    expect(socket.sent).toHaveLength(1);
    client.close();
  });

  it.each(["unknown-method", "not-implemented"])("falls back explicitly only on %s", async code => {
    const socket = new FakeSocket(); socket.open();
    const client = createClient(socket);
    const result = client.negotiate();
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: false, error: { code, message: "old server" } }));
    await expect(result).resolves.toEqual({ mode: "legacy" });
    expect(socket.readyState).toBe(1);
    const call = client.call("threads.list", {});
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: true, result: [] }));
    await expect(call).resolves.toEqual([]);
    client.close();
  });

  it.each(["internal", "timeout", "bad-result"])("does not silently downgrade on negotiation %s", async code => {
    const socket = new FakeSocket(); socket.open();
    const errors: string[] = [];
    const client = createClient(socket, { onProtocolError: error => errors.push(error.code) });
    const result = client.negotiate();
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: false, error: { code, message: "failed" } }));
    await expect(result).rejects.toMatchObject({ code });
    expect(client.sync).toBeUndefined();
    expect(socket.readyState).toBe(3);
    expect(errors).toEqual([code]);
  });

  it("closes instead of downgrading when the negotiation really times out", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket(); socket.open();
    const client = createClient(socket, { timeoutMs: 25, onProtocolError: () => {} });
    const result = expect(client.negotiate()).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(26);
    await result;
    expect(client.sync).toBeUndefined();
    expect(socket.readyState).toBe(3);
  });

  it.each([{ epoch: "process-a", ordered: ["models"] }, { epoch: "", ordered: [] }])("refuses unsolicited capabilities or a malformed epoch: %j", async result => {
    const socket = new FakeSocket(); socket.open();
    const client = createClient(socket, { onProtocolError: () => {} });
    const pending = client.negotiate();
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: true, result }));
    await expect(pending).rejects.toMatchObject({ code: "bad-result" });
    expect(client.sync).toBeUndefined();
    expect(socket.readyState).toBe(3);
  });

  it("cannot accept a negotiation continuation after its socket closes", async () => {
    const socket = new FakeSocket(); socket.open();
    const client = createClient(socket);
    const result = client.negotiate();
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: true, result: { epoch: "old", ordered: [] } }));
    client.close();
    await expect(result).rejects.toMatchObject({ code: "closed" });
    expect(client.sync).toBeUndefined();
    const fresh = new FakeSocket(); fresh.open();
    const next = createClient(fresh);
    const ready = next.negotiate();
    fresh.reply(JSON.stringify({ type: "response", id: fresh.lastRequest().id, ok: true, result: { epoch: "new", ordered: [] } }));
    await expect(ready).resolves.toEqual({ mode: "legacy", epoch: "new" });
    next.close();
  });

  it("delivers captured metadata before promise completion, without adopting its epoch", async () => {
    const socket = new FakeSocket(); socket.open();
    const client = createClient(socket);
    const negotiation = client.negotiate();
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: true, result: { epoch: "current", ordered: [] } }));
    await negotiation;
    const trace: string[] = [];
    const sync = { epoch: "late-old-process", changes: [{ scope: "threads", kind: "snapshot", rev: 1 }] };
    client.subscribe("threads.changed", (_payload, metadata) => { expect(metadata).toEqual(sync); trace.push("push"); });
    const result = client.call("threads.list", {}, { onMetadata: metadata => { expect(metadata).toEqual(sync); trace.push("metadata"); } }).then(() => trace.push("completion"));
    socket.reply(JSON.stringify({ type: "response", id: socket.lastRequest().id, ok: true, result: [], sync }));
    expect(trace).toEqual(["metadata"]);
    socket.reply(JSON.stringify({ type: "push", channel: "threads.changed", payload: { threadId: "one" }, sync }));
    await result;
    expect(trace).toEqual(["metadata", "push", "completion"]);
    expect(client.sync).toEqual({ mode: "legacy", epoch: "current" });
    client.close();
  });
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
