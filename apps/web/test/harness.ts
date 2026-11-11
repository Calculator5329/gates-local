// An in-memory browser and server for the client's session tests: a fake
// WebSocket that speaks the protocol envelopes, a server that answers every
// method from the contract samples unless a test overrides or holds it, and
// the few browser globals session.ts touches (location, history, document,
// localStorage, requestAnimationFrame). Each test imports session.ts fresh.
import { vi } from "vitest";
import type { Channel, MethodName, Params, Payload, ResultOf } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";

type Listener = (event: { data?: unknown }) => void;

export interface Held<M extends MethodName> {
  readonly params: Params<M>;
  respond(result: ResultOf<M>): void;
  fail(code: string, message?: string, blocking?: unknown): void;
}

interface Request {
  readonly id: string;
  readonly method: MethodName;
  readonly params: unknown;
}

export class FakeSocket {
  readyState = 0;
  readonly sent: Request[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  readonly url: string;
  private readonly server: FakeServer;
  constructor(url: string, server: FakeServer) {
    this.url = url;
    this.server = server;
    server.sockets.push(this);
    queueMicrotask(() => this.open());
  }
  addEventListener(type: string, l: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) this.listeners.set(type, (set = new Set()));
    set.add(l);
  }
  removeEventListener(type: string, l: Listener): void {
    this.listeners.get(type)?.delete(l);
  }
  private emit(type: string, event: { data?: unknown } = {}): void {
    // a copy: a listener may remove itself while this runs
    for (const l of Array.from(this.listeners.get(type) ?? [])) l(event);
  }
  open(): void {
    if (this.readyState !== 0) return;
    if (!this.server.accepting) {
      this.readyState = 3;
      this.emit("close");
      return;
    }
    this.readyState = 1;
    this.emit("open");
  }
  send(data: string): void {
    const m = JSON.parse(data) as Request;
    this.sent.push(m);
    queueMicrotask(() => this.server.handle(this, m));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  frame(value: unknown): void {
    if (this.readyState === 1) this.emit("message", { data: JSON.stringify(value) });
  }
}

type Answer = (params: never) => unknown;

export class FakeServer {
  readonly sockets: FakeSocket[] = [];
  /** False refuses new connections (they close at once). */
  accepting = true;
  // no turn is in the way of a send unless a test says so
  private readonly answers = new Map<MethodName, Answer>([["turns.blocking", () => []]]);
  private readonly holds = new Map<MethodName, Array<(h: Held<never>) => void>>();
  readonly log: Request[] = [];

  /** The open socket, the one the client uses now. */
  get socket(): FakeSocket {
    const s = this.sockets.findLast((x) => x.readyState === 1);
    if (!s) throw new Error("no open socket");
    return s;
  }

  /** Answer every call of this method with fn's result; a thrown { code, message } fails it. */
  answer<M extends MethodName>(method: M, fn: (params: Params<M>) => ResultOf<M>): void {
    this.answers.set(method, fn as Answer);
  }

  /** The next call of this method waits until the test responds to it. */
  hold<M extends MethodName>(method: M): Promise<Held<M>> {
    return new Promise((resolve) => {
      const list = this.holds.get(method) ?? [];
      list.push(resolve as (h: Held<never>) => void);
      this.holds.set(method, list);
    });
  }

  calls(method: MethodName): Request[] {
    return this.log.filter((r) => r.method === method);
  }

  handle(socket: FakeSocket, req: Request): void {
    this.log.push(req);
    const ok = (result: unknown) => socket.frame({ type: "response", id: req.id, ok: true, result });
    const err = (code: string, message = code, blocking?: unknown) => socket.frame({ type: "response", id: req.id, ok: false, error: { code, message, ...(blocking === undefined ? {} : { blocking }) } });
    const waiting = this.holds.get(req.method);
    const next = waiting?.shift();
    if (next) {
      next({ params: req.params as never, respond: ok, fail: err });
      return;
    }
    const fn = this.answers.get(req.method);
    try {
      ok(fn ? fn(req.params as never) : methodSamples[req.method].result);
    } catch (e) {
      const f = e as { code?: string; message?: string; blocking?: unknown };
      err(f.code ?? "internal", f.message ?? "failed", f.blocking);
    }
  }

  push<C extends Channel>(channel: C, payload: Payload<C>): void {
    this.socket.frame({ type: "push", channel, payload });
  }

  /** A push to every open socket, as the real server sends it to each connected client. */
  broadcast<C extends Channel>(channel: C, payload: Payload<C>): void {
    for (const s of this.sockets) s.frame({ type: "push", channel, payload });
  }
}

export interface Browser {
  readonly server: FakeServer;
  /** Run the animation frame callbacks queued now. */
  frame(): void;
  readonly location: { search: string; hash: string; pathname: string };
  /** Where the fake history stands, and a popstate listener for Back. */
  readonly history: { index(): number; onPop(listener: () => void): void };
}

/** Install the fake browser globals; call before importing session.ts. */
export function installBrowser(): Browser {
  const server = new FakeServer();
  const location = { search: `?server=${encodeURIComponent("ws://127.0.0.1:1/?token=t")}`, hash: "", pathname: "/" };
  let rafs = new Map<number, (t: number) => void>();
  let nextRaf = 1;
  const storage = new Map<string, string>();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("location", location);
  // a stack of entries: Back is async, like a browser's, and runs the popstate listeners
  const entries: { state: unknown; hash: string }[] = [{ state: null, hash: "" }];
  let at = 0;
  const popListeners: Array<() => void> = [];
  vi.stubGlobal("history", {
    get state() { return entries[at]!.state; },
    get length() { return entries.length; },
    pushState: (state: unknown) => {
      entries.splice(at + 1);
      entries.push({ state, hash: location.hash });
      at++;
    },
    replaceState: (state: unknown, _t: string, url?: string) => {
      if (url !== undefined) location.hash = url.startsWith("#") ? url : "";
      entries[at] = { state, hash: location.hash };
    },
    back: () => {
      setTimeout(() => {
        if (at === 0) return;
        at--;
        location.hash = entries[at]!.hash;
        for (const listener of popListeners) listener();
      }, 0);
    },
  });
  vi.stubGlobal("document", { documentElement: { setAttribute: () => undefined, removeAttribute: () => undefined } });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  });
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    const id = nextRaf++;
    rafs.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void rafs.delete(id));
  vi.stubGlobal(
    "WebSocket",
    class extends FakeSocket {
      constructor(url: string) {
        super(url, server);
      }
    },
  );
  return {
    server,
    location,
    history: {
      index: () => at,
      onPop: (listener) => void popListeners.push(listener),
    },
    frame() {
      const now = rafs;
      rafs = new Map();
      for (const cb of now.values()) cb(performance.now());
    },
  };
}

/** Let queued microtasks and zero-delay timers run. */
export async function tick(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Wait until pred holds (real timers), or fail after ms. */
export async function until(pred: () => boolean, ms = 2000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
