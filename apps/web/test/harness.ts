// An in-memory browser and server for the client's session tests: a fake
// WebSocket that speaks the protocol envelopes, a server that answers every
// method from the contract samples unless a test overrides or holds it, and
// the few browser globals session.ts touches (location, history, document,
// localStorage, requestAnimationFrame). Each test imports session.ts fresh.
import { vi } from "vitest";
import type { Channel, Message, MethodName, Params, Payload, QueuedMessage, ResultOf } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { createQueue } from "../../server/src/chat/queue.ts";

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

/**
 * chat.send as the server answers it (chat row 32): the turn id at once, then the turn's start
 * with the saved question on the same socket. A test gives the old answer, the turn id and the
 * saved question together, and this splits it; a replayed answer, or one without the question
 * (the test pushes the start itself), goes out as given.
 */
function sendAnswer(start: (payload: Payload<"chat.event">) => void, params: Params<"chat.send">, result: unknown, answer: (result: unknown) => void): void {
  const r = result as { turnId?: string; userMessage?: Message; replayed?: boolean } | null;
  if (r === null || typeof r !== "object" || r.userMessage === undefined || r.replayed === true || r.turnId === undefined) return answer(result);
  const { turnId, userMessage } = r;
  answer({ turnId });
  const event: Payload<"chat.event">["event"] = params.draw !== undefined
    ? { type: "start", model: params.draw.preset, userMessage, image: true }
    : { type: "start", model: params.model, userMessage };
  // its own task, as a browser delivers each frame: the answer's continuation runs first
  setTimeout(() => start({ turnId, threadId: params.threadId, event }), 0);
}

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
    if (req.method === "chat.cancel") this.stopped.add((req.params as Params<"chat.cancel">).turnId);
    const answer = (result: unknown) => socket.frame({ type: "response", id: req.id, ok: true, result });
    const send = req.params as Params<"chat.send">;
    const start = (payload: Payload<"chat.event">) => { socket.frame({ type: "push", channel: "chat.event", payload }); this.heard(payload); };
    // the server takes a send's turn before it answers: until then the send is in its chat's way
    if (req.method === "chat.send") this.asked.set(req.id, send.threadId);
    const ok = req.method === "chat.send" ? (result: unknown) => { this.asked.delete(req.id); this.running(send.threadId, result); sendAnswer(start, send, result, answer); this.pump(); } : answer;
    const err = (code: string, message = code, blocking?: unknown) => {
      if (this.asked.delete(req.id)) this.pump();
      socket.frame({ type: "response", id: req.id, ok: false, error: { code, message, ...(blocking === undefined ? {} : { blocking }) } });
    };
    this.route(req, ok, err);
  }

  /** A test's hold or answer for the method, else the queue's own answer, else the contract sample. */
  private route(req: Request, ok: (result: unknown) => void, err: (code: string, message?: string, blocking?: unknown) => void): void {
    const waiting = this.holds.get(req.method);
    const next = waiting?.shift();
    if (next) {
      next({ params: req.params as never, respond: ok, fail: err });
      return;
    }
    const fn = this.answers.get(req.method);
    try {
      ok(fn ? fn(req.params as never) : req.method.startsWith("queue.") ? this.queueCall(req) : methodSamples[req.method].result);
    } catch (e) {
      const f = e as { code?: string; message?: string; blocking?: unknown };
      err(f.code ?? "internal", f.message ?? "failed", f.blocking);
    }
  }

  push<C extends Channel>(channel: C, payload: Payload<C>): void {
    this.socket.frame({ type: "push", channel, payload });
    this.pushed(channel, payload);
  }

  /** A push to every open socket, as the real server sends it to each connected client. */
  broadcast<C extends Channel>(channel: C, payload: Payload<C>): void {
    for (const s of this.sockets) s.frame({ type: "push", channel, payload });
    this.pushed(channel, payload);
  }

  // The server's queue: its real rules (server chat/queue.ts) and, in small, the server's pump
  // (app.ts sendQueued and heard). A queued message goes out as a chat.send the server makes
  // itself, logged with the windows' calls and answered by the same holds and answers.
  readonly queue = createQueue({ changed: (list) => this.broadcast("queue.changed", list), log: () => undefined });
  /** Turns from an answered chat.send until their done or error, by id: their chats. */
  private readonly replies = new Map<string, string>();
  /** Windows' chat.send calls not answered yet, by request id: their chats. */
  private readonly asked = new Map<string, string>();
  private readonly started = new Set<string>();
  private readonly over = new Set<string>();
  private readonly stopped = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private runtimeReady = methodSamples["runtime.status"].result.state === "ready";
  private hasModels = methodSamples["models.list"].result.length > 0;
  private pumpSoon = false;
  private pumping = false;
  private serverCalls = 0;

  private running(threadId: string, result: unknown): void {
    const r = result as { turnId?: string; replayed?: boolean } | null;
    // a test may push a turn's end before its chat.send is answered
    if (r !== null && typeof r === "object" && r.replayed !== true && typeof r.turnId === "string" && !this.over.has(r.turnId)) this.replies.set(r.turnId, threadId);
  }

  private queueCall(req: Request): readonly QueuedMessage[] {
    const p = req.params as { id: string };
    if (req.method === "queue.add") this.queue.add(req.params as QueuedMessage);
    if (req.method === "queue.update") {
      const { id, ...patch } = req.params as Params<"queue.update">;
      if (this.queue.change(id, patch) === "sending") throw Object.assign(new Error("This message is already being sent."), { code: "queue-sending" });
    }
    if (req.method === "queue.remove") this.queue.remove(p.id);
    this.pump();
    return this.queue.list();
  }

  /** The server's catalog changed with no push yet (a scenario delivers that itself): its queue sees it. */
  catalogChanged(models: readonly unknown[]): void {
    this.hasModels = models.length > 0;
    this.pump();
  }

  private pushed(channel: Channel, payload: unknown): void {
    if (channel === "chat.event") this.heard(payload as Payload<"chat.event">);
    if (channel === "runtime.changed") { this.runtimeReady = (payload as Payload<"runtime.changed">).state === "ready"; this.pump(); }
    if (channel === "models.changed") { this.hasModels = (payload as Payload<"models.changed">).length > 0; this.pump(); }
  }

  private heard({ turnId, threadId, event }: Payload<"chat.event">): void {
    if (event.type === "reply") {
      const before = this.attempts.get(turnId) ?? 1;
      this.attempts.set(turnId, event.reply.attempt);
      if (event.reply.attempt > before) this.queue.retrying(threadId);
      return;
    }
    if (event.type === "start") {
      if (this.over.has(turnId)) return;
      this.started.add(turnId);
      this.replies.set(turnId, threadId);
      this.queue.started(event.userMessage.id);
      return;
    }
    if (event.type !== "done" && event.type !== "error") return;
    this.over.add(turnId);
    this.replies.delete(turnId);
    // its chat.send may not be answered yet: the server's own turn has ended all the same
    for (const [id, t] of this.asked) if (t === threadId) this.asked.delete(id);
    const stopped = this.stopped.delete(turnId);
    if (!this.started.delete(turnId)) {
      if (event.type === "error") {
        const why = { code: event.code, message: event.message, ...(event.blocking === undefined ? {} : { blocking: event.blocking }) };
        if (!this.queue.refused(turnId, why) && (event.ended?.reason === "stopped" || stopped)) this.queue.ended(threadId, "stopped");
      }
    } else if (event.type === "done") this.queue.ended(threadId, stopped ? "stopped" : "done");
    else this.queue.ended(threadId, event.ended?.reason === "failed" && (this.attempts.get(turnId) ?? 1) > 1 ? "failed-again" : "stopped");
    this.pump();
  }

  private pump(): void {
    if (this.pumpSoon) return;
    this.pumpSoon = true;
    setTimeout(() => { this.pumpSoon = false; this.sendQueued(); }, 0);
  }

  private sendQueued(): void {
    if (this.pumping) return;
    const busy = new Set([...this.replies.values(), ...this.asked.values()]);
    const q = this.queue.next({ chat: this.runtimeReady && this.hasModels, anyTurn: busy.size > 0, busy });
    if (q === undefined) return;
    this.pumping = true;
    const params: Params<"chat.send"> = {
      threadId: q.threadId, content: q.text, messageId: q.messageId, model: q.model ?? "", numCtx: q.numCtx ?? 4096,
      ...(q.images?.length ? { images: q.images } : {}),
      ...(q.files?.length ? { files: q.files } : {}),
      ...(q.think === undefined ? {} : { think: q.think }),
      ...(q.draw === undefined ? {} : { draw: q.draw, ...(q.drawCount === undefined ? {} : { drawCount: q.drawCount }) }),
      ...(q.now === true ? (q.stopOthers === true ? { stopOthers: true, ...(q.stopTurns === undefined ? {} : { stopTurns: [...q.stopTurns] }) } : { askFirst: true }) : {}),
    };
    const done = () => { this.pumping = false; this.pump(); };
    const ok = (result: unknown) => {
      const r = result as { turnId?: string; replayed?: boolean };
      if (r.replayed === true) this.queue.started(q.messageId);
      else if (typeof r.turnId === "string") { this.running(q.threadId, result); this.queue.sending(q.id, r.turnId); }
      sendAnswer((payload) => this.broadcast("chat.event", payload), params, result, () => undefined);
      done();
    };
    const err = (code: string, message = code, blocking?: unknown) => {
      this.queue.turnless(q.id, { code, message, ...(blocking === undefined ? {} : { blocking: blocking as never }) });
      done();
    };
    const req: Request = { id: `server-${++this.serverCalls}`, method: "chat.send", params };
    this.log.push(req);
    this.route(req, ok, err);
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
