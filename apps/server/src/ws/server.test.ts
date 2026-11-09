import {
  type Channel,
  type Client,
  type MethodName,
  type SocketLike,
  WireError,
  channelNames,
  createClient,
  methodNames,
} from "@gates-local/contracts";
import { methodSamples, pushSamples } from "@gates-local/contracts/testing";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type Handlers, type WsServer, type WsServerOptions, startWsServer } from "./server.ts";

const TOKEN = "per-launch-secret";
const APP_ORIGIN = "http://127.0.0.1:5187";

const open: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const o of open.splice(0).toReversed()) await o.close();
});

/** Every handler checks it got the sample params and answers the sample result. */
function sampleHandlers(seen: Array<[string, unknown]>): Handlers {
  const out: Record<string, (p: unknown) => unknown> = {};
  for (const m of methodNames) {
    out[m] = (params) => {
      seen.push([m, params]);
      return methodSamples[m].result;
    };
  }
  return out as unknown as Handlers;
}

async function start(handlers: Partial<Handlers>, extra: { logs?: string[]; onClientReady?: WsServerOptions["onClientReady"] } = {}): Promise<WsServer> {
  const server = await startWsServer({
    port: 0,
    token: TOKEN,
    allowedOrigins: [APP_ORIGIN],
    handlers,
    onClientReady: extra.onClientReady,
    log: (line) => extra.logs?.push(line),
  });
  open.push(server);
  return server;
}

function url(server: WsServer, token = TOKEN): string {
  return `ws://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}`;
}

function connect(server: WsServer, opts: { token?: string; origin?: string } = {}): WebSocket {
  const ws = new WebSocket(url(server, opts.token), opts.origin === undefined ? {} : { origin: opts.origin });
  open.push({ close: () => ws.terminate() });
  return ws;
}

async function client(server: WsServer, origin?: string): Promise<{ ws: WebSocket; client: Client }> {
  const ws = connect(server, { origin });
  const c = createClient(ws as unknown as SocketLike, { timeoutMs: 2000 });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, client: c };
}

/** Upgrade outcome: "open" or the HTTP status the server refused with. */
function upgrade(server: WsServer, opts: { token?: string; origin?: string; rawUrl?: string }): Promise<number | "open"> {
  const ws = new WebSocket(opts.rawUrl ?? url(server, opts.token), opts.origin === undefined ? {} : { origin: opts.origin });
  open.push({ close: () => ws.terminate() });
  return new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? -1));
    ws.once("error", () => resolve(-1));
  });
}

/** Raw socket: send text frames and read back the next frame. */
function rawFrames(ws: WebSocket) {
  const queue: string[] = [];
  const waiters: Array<(s: string) => void> = [];
  ws.on("message", (data) => {
    const text = String(data);
    const w = waiters.shift();
    if (w) w(text);
    else queue.push(text);
  });
  return {
    next(timeoutMs = 1000): Promise<unknown> {
      const q = queue.shift();
      if (q !== undefined) return Promise.resolve(JSON.parse(q));
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no frame")), timeoutMs);
        waiters.push((s) => {
          clearTimeout(t);
          resolve(JSON.parse(s));
        });
      });
    },
    pendingCount: () => queue.length,
  };
}

describe("round trip over a real socket", () => {
  it("TE-02: a failed snapshot closes the client before dispatch or live chat delivery", async () => {
    let dispatched = 0;
    const logs: string[] = [];
    const server = await start({ "threads.list": () => { dispatched++; return []; } }, {
      logs, onClientReady: () => { throw new Error("snapshot unavailable"); },
    });
    const connected = await client(server);
    await expect(connected.client.call("threads.list", {})).rejects.toMatchObject({ code: "closed" });
    expect(dispatched).toBe(0);
    expect(logs.some((line) => line.includes("snapshot unavailable"))).toBe(true);
  });

  it("TE-02: a quiet client gets current chat state, never a backlog of pre-request broadcasts", async () => {
    const payload = { threadId: "thread", turnId: "turn", event: { type: "delta" as const, text: "current" } };
    const server = await start({ "threads.list": () => [] }, { onClientReady: (push) => push("chat.event", payload) });
    const quiet = await client(server);
    const chat: unknown[] = [], changed: unknown[] = [];
    quiet.client.subscribe("chat.event", (event) => chat.push(event));
    quiet.client.subscribe("threads.changed", (event) => changed.push(event));
    for (let i = 0; i < 10_000; i++) server.push("chat.event", { ...payload, event: { type: "delta", text: "old" } });
    server.push("threads.changed", { threadId: "thread" });
    // Ping is not a request: the quiet client remains before the boundary.
    await new Promise<void>((resolve) => { quiet.ws.once("pong", () => resolve()); quiet.ws.ping(); });
    expect.soft(chat.length).toBe(0);
    expect(changed).toEqual([{ threadId: "thread" }]);
    await quiet.client.call("threads.list", {});
    expect(chat.length).toBe(1);
    expect(chat).toEqual([payload]);
  });

  it.each(methodNames.filter(method => method !== "sync.negotiate"))("%s", async (method: MethodName) => {
    const seen: Array<[string, unknown]> = [];
    const server = await start(sampleHandlers(seen));
    const { client: c } = await client(server);
    const { params, result } = methodSamples[method];
    await expect(c.call(method, params as never)).resolves.toEqual(result);
    expect(seen).toEqual([[method, params]]);
  });

  it("owns negotiation without an app handler and offers no incomplete ordered domain", async () => {
    const server = await start({});
    const desktop = await client(server);
    const other = await client(server, APP_ORIGIN);
    const result = await desktop.client.call("sync.negotiate", { ordered: ["settings", "threads"] });
    expect(result.ordered).toEqual([]);
    expect(result.epoch).toMatch(/^[\da-f-]{36}$/);
    await expect(other.client.negotiate()).resolves.toEqual({ mode: "legacy", epoch: result.epoch });
    const nextListener = await start({});
    const next = await client(nextListener);
    await expect(next.client.negotiate()).resolves.toEqual({ mode: "legacy", epoch: result.epoch });
  });

  it.each(channelNames)("push %s reaches every client", async (channel: Channel) => {
    const server = await start({});
    const a = await client(server);
    const b = await client(server, APP_ORIGIN);
    const got: { a: unknown[]; b: unknown[] } = { a: [], b: [] };
    a.client.subscribe(channel, (p) => got.a.push(p));
    b.client.subscribe(channel, (p) => got.b.push(p));
    const samples = pushSamples[channel];
    for (const payload of samples) server.push(channel, payload as never);
    // A round trip after the pushes proves they have all been read.
    await expect(a.client.call("threads.list", {})).rejects.toMatchObject({ code: "not-implemented" });
    await expect(b.client.call("threads.list", {})).rejects.toMatchObject({ code: "not-implemented" });
    expect(got.a).toEqual(samples);
    expect(got.b).toEqual(samples);
  });

  it("push refuses a payload that breaks its Schema, sending nothing", async () => {
    const server = await start({});
    expect(() => server.push("threads.changed", { threadId: 1 } as never)).toThrow(WireError);
  });
});

describe("refused at the boundary, connection stays usable", () => {
  it("answers each malformed frame with its named code and keeps serving", async () => {
    const logs: string[] = [];
    const server = await start(sampleHandlers([]), { logs });
    const ws = connect(server);
    const frames = rawFrames(ws);
    await new Promise((r) => ws.once("open", r));

    // No usable id: dropped with a log, no response.
    ws.send("{not json");
    ws.send(JSON.stringify({ type: "request", method: "threads.list", params: {} }));
    ws.send(Buffer.from(JSON.stringify({ type: "request", id: "b", method: "threads.list", params: {} })), { binary: true });

    ws.send(JSON.stringify({ type: "request", id: "1", method: "threads.list" }));
    expect(await frames.next()).toMatchObject({ type: "response", id: "1", ok: false, error: { code: "bad-message" } });

    ws.send(JSON.stringify({ type: "request", id: "2", method: "threads.nuke", params: {} }));
    expect(await frames.next()).toMatchObject({ id: "2", ok: false, error: { code: "unknown-method" } });

    ws.send(JSON.stringify({ type: "request", id: "3", method: "threads.get", params: { threadId: 3 } }));
    expect(await frames.next()).toMatchObject({ id: "3", ok: false, error: { code: "bad-params" } });

    ws.send(JSON.stringify({ type: "request", id: "4", method: "threads.list", params: {} }));
    expect(await frames.next()).toEqual({ type: "response", id: "4", ok: true, result: methodSamples["threads.list"].result });
    expect(frames.pendingCount()).toBe(0);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(logs.filter((l) => l.startsWith("dropped frame"))).toHaveLength(3);
  });

  it("carries a handler's blocking list to the client, and only a well-formed one", async () => {
    const blocking = [{ threadId: "t1", title: "First", model: "qwen3.5:9b", turnId: "turn-1" }];
    const server = await start({
      "chat.send": () => {
        throw Object.assign(new Error("in the way"), { code: "would-stop", blocking });
      },
      "threads.get": () => {
        throw Object.assign(new Error("odd"), { code: "odd", blocking: "not a list" });
      },
    });
    const { client: c } = await client(server);
    const params = { threadId: "t1", content: "hi", model: "m", numCtx: 8192 } as const;
    await expect(c.call("chat.send", params)).rejects.toMatchObject({ code: "would-stop", message: "in the way", blocking });
    const odd: unknown = await c.call("threads.get", { threadId: "t1" }).catch((e: unknown) => e);
    expect(odd).toMatchObject({ code: "odd" });
    expect((odd as { blocking?: unknown }).blocking).toBeUndefined();
  });

  it("turns handler failures into ok:false responses with a code", async () => {
    const logs: string[] = [];
    const server = await start(
      {
        "threads.get": () => {
          throw new WireError("not-found", "no thread t9");
        },
        "threads.create": async () => {
          throw Object.assign(new Error("disk full"), { code: "store-failed" });
        },
        "threads.rename": () => {
          throw new Error("boom");
        },
        "runtime.status": () => ({ state: "sleepy" }) as never,
      },
      { logs },
    );
    const { client: c } = await client(server);
    await expect(c.call("threads.get", { threadId: "t9" })).rejects.toMatchObject({ code: "not-found", message: "no thread t9" });
    await expect(c.call("threads.create", {})).rejects.toMatchObject({ code: "store-failed" });
    await expect(c.call("threads.rename", { threadId: "t1", title: "x" })).rejects.toMatchObject({ code: "internal", message: "boom" });
    await expect(c.call("runtime.status", {})).rejects.toMatchObject({ code: "bad-result" });
    await expect(c.call("models.list", {})).rejects.toMatchObject({ code: "not-implemented" });
    expect(logs.some((l) => l.includes("threads.rename handler threw"))).toBe(true);
    expect(logs.some((l) => l.includes("runtime.status returned a result"))).toBe(true);
  });
});

describe("upgrade gate", () => {
  it("refuses a wrong, missing or prefix token with 401", async () => {
    const server = await start({});
    expect(await upgrade(server, { token: "wrong" })).toBe(401);
    expect(await upgrade(server, { token: "" })).toBe(401);
    expect(await upgrade(server, { token: TOKEN.slice(0, -1) })).toBe(401);
    expect(await upgrade(server, { token: `${TOKEN}x` })).toBe(401);
    expect(await upgrade(server, { rawUrl: `ws://127.0.0.1:${server.port}/` })).toBe(401);
  });

  it("refuses a foreign Origin with 403 and admits none or an allowed one", async () => {
    const server = await start({});
    expect(await upgrade(server, { origin: "http://evil.example" })).toBe(403);
    expect(await upgrade(server, { origin: "http://127.0.0.1:9999" })).toBe(403);
    expect(await upgrade(server, { origin: "null" })).toBe(403);
    expect(await upgrade(server, { origin: APP_ORIGIN })).toBe("open");
    expect(await upgrade(server, {})).toBe("open");
  });

  it("refuses to bind a non-loopback host", async () => {
    await expect(startWsServer({ host: "0.0.0.0", port: 0, token: TOKEN, allowedOrigins: [], handlers: {} })).rejects.toMatchObject({
      code: "bad-params",
    });
    await expect(startWsServer({ port: 0, token: "", allowedOrigins: [], handlers: {} })).rejects.toBeInstanceOf(WireError);
  });

  it("answers plain HTTP with 426", async () => {
    const server = await start({});
    const res = await fetch(`http://127.0.0.1:${server.port}/?token=${TOKEN}`);
    expect(res.status).toBe(426);
  });
});

describe("close", () => {
  it("rejects pending calls with closed when the server goes away", async () => {
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => {
      entered = r;
    });
    const server = await startWsServer({
      port: 0,
      token: TOKEN,
      allowedOrigins: [],
      handlers: {
        "models.refresh": () => {
          entered();
          return new Promise<never>(() => {});
        },
      },
      log: () => {},
    });
    const { client: c } = await client(server);
    const pending = c.call("models.refresh", {});
    await inHandler;
    await server.close();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await expect(c.closed).resolves.toBeUndefined();
  });
});
