// An in-memory browser and server for the client's session tests: a fake
// WebSocket that speaks the protocol envelopes, a server that answers every
// method from the contract samples unless a test overrides or holds it, and
// the few browser globals session.ts touches (location, history, document,
// localStorage, requestAnimationFrame). Each test imports session.ts fresh.
import { vi } from "vitest";
import type { Channel, Message, MethodName, Params, Payload, QueuedMessage, ReplyAnswer, ReplyListed, ReplyRecord, ResultOf, SyncMetadata } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { createReplies, type QueuePatch } from "@gates-local/server/chat/replies.ts";
import { isLive, type End } from "@gates-local/server/chat/reply.ts";

/** The call a pushed record stands for when it says "tool" and the test pushed no step of its own. */
const SHOWN_CALL = "shown-call";

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
    this.server.left(this);
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
    this.caller = this.sockets.indexOf(socket) + 1;
    if (req.method === "chat.cancel") this.store.stop({ id: (req.params as Params<"chat.cancel">).turnId });
    const answer = (result: unknown) => socket.frame({ type: "response", id: req.id, ok: true, result });
    const send = req.params as Params<"chat.send">;
    const start = (payload: Payload<"chat.event">) => {
      // a Stop took the message back before its question was saved: its work saves nothing and starts nothing
      if (this.made.has(payload.turnId) && !this.over.has(payload.turnId) && this.store.of(payload.turnId)?.stage !== "starting") return;
      socket.frame({ type: "push", channel: "chat.event", payload: this.named("chat.event", payload) });
      this.heard(payload);
    };
    // the server takes a send's turn before it answers: until then the send is in its chat's way
    if (req.method === "chat.send") this.asked.set(req.id, send.threadId);
    const ok = req.method === "chat.send" ? (result: unknown) => {
      this.asked.delete(req.id);
      const turnId = this.running(send.threadId, result);
      // a window's own send: its record starts at once, and the window keeps the words
      if (turnId !== undefined) this.direct(turnId, send);
      sendAnswer(start, send, result, answer);
      this.pump();
    } : answer;
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
      ok(fn ? fn(req.params as never) : req.method.startsWith("queue.") || req.method.startsWith("reply.") ? this.queueCall(req) : methodSamples[req.method].result);
    } catch (e) {
      const f = e as { code?: string; message?: string; blocking?: unknown };
      err(f.code ?? "internal", f.message ?? "failed", f.blocking);
    }
  }

  /** `sync`: the number an ordered push carries (numbered-server.ts gives it). */
  push<C extends Channel>(channel: C, payload: Payload<C>, sync?: SyncMetadata): void {
    if (!this.muted) this.socket.frame({ type: "push", channel, payload: this.named(channel, payload), ...(sync === undefined ? {} : { sync }) });
    this.pushed(channel, payload);
  }

  /** A push to every open socket, as the real server sends it to each connected client. */
  broadcast<C extends Channel>(channel: C, payload: Payload<C>): void {
    const named = this.named(channel, payload);
    if (!this.muted) for (const s of this.sockets) s.frame({ type: "push", channel, payload: named });
    this.pushed(channel, payload);
  }

  private muted = false;
  /**
   * What `happens` happens on the server and reaches no window: a reply that began before a window
   * connected, or one that ended while its connection was down. The next reply.list says where
   * each record stands.
   */
  unheard(happens: () => void): void {
    this.muted = true;
    try {
      happens();
    } finally {
      this.muted = false;
    }
  }

  /** A chat event names the record its turn works for, as the server's does (app/run-turn.ts). */
  private named<C extends Channel>(channel: C, payload: Payload<C>): Payload<C> {
    if (channel !== "chat.event") return payload;
    const p = payload as Payload<"chat.event">;
    const replyId = p.replyId ?? this.store.of(p.turnId)?.id;
    return (replyId === undefined ? p : { ...p, replyId }) as Payload<C>;
  }

  // The server's record of every message: its real rules (server chat/replies.ts) and, in small,
  // the server's pump (app/queue-pump.ts) and what a turn's work says to its record. A waiting
  // message goes out as a chat.send the server makes itself, logged with the windows' calls and
  // answered by the same holds and answers.
  private readonly store = createReplies({
    log: () => undefined,
    changed: (list) => this.broadcast("queue.changed", list),
    told: (change) => this.broadcast("reply.changed", change),
    saved: () => undefined,
    deleting: () => false,
    closing: () => false,
    cut: (turnId, at) => this.cut(turnId, at),
    clock: (turnId, now) => this.clock(turnId, now),
  });
  /** The waiting messages, for a test that changes them as another window would. */
  readonly queue = {
    add: (entry: QueuedMessage) => this.store.add(entry),
    change: (id: string, patch: QueuePatch) => {
      const answer = this.store.update(id, patch, 0);
      // another window's call: the server looks at what may start now, as it does after any call
      this.pump();
      return answer;
    },
    remove: (id: string) => this.store.remove({ id }).answer === "done",
    list: () => this.store.list(),
  };
  /** Which connection has each message open in its composer, and which one is calling now. */
  private readonly editing = new Map<string, number>();
  private caller = 0;
  /** Turns from an answered chat.send until their done or error, by id: their chats. */
  private readonly replies = new Map<string, string>();
  /** Windows' chat.send calls not answered yet, by request id: their chats. */
  private readonly asked = new Map<string, string>();
  private readonly over = new Set<string>();
  private readonly attempts = new Map<string, number>();
  /** Each turn's last pushed record, and when the turn began for one with no push yet. */
  private readonly records = new Map<string, ReplyRecord>();
  private readonly begun = new Map<string, number>();
  private runtimeReady = methodSamples["runtime.status"].result.state === "ready";
  private hasModels = methodSamples["models.list"].result.models.length > 0;
  private pumpSoon = false;
  private pumping = false;
  private serverCalls = 0;

  /** The turn a chat.send was answered with, now in its chat's way; none for a replayed answer or a turn already over. */
  private running(threadId: string, result: unknown): string | undefined {
    const r = result as { turnId?: string; replayed?: boolean } | null;
    // a test may push a turn's end before its chat.send is answered
    if (r === null || typeof r !== "object" || r.replayed === true || typeof r.turnId !== "string" || this.over.has(r.turnId)) return undefined;
    this.replies.set(r.turnId, threadId);
    if (!this.begun.has(r.turnId)) this.begun.set(r.turnId, Date.now());
    return r.turnId;
  }

  /** The record of a send that waited in no list: taken at once for its turn (server app/handlers.ts). */
  private direct(turnId: string, send: Pick<Params<"chat.send">, "threadId" | "content" | "messageId" | "retryOf">): void {
    const at = this.begun.get(turnId) ?? Date.now();
    this.made.add(turnId);
    this.store.direct(turnId, send.threadId, { messageId: send.messageId ?? turnId, text: send.content, at }, send.retryOf !== undefined, at);
  }
  /** Turns the server has made a record for: one that moved on is not made again by a late event of its turn. */
  private readonly made = new Set<string>();

  /** The times of a turn's reply: its last pushed record, or one that has only begun. */
  private clock(turnId: string, now: number): ReplyRecord {
    return this.records.get(turnId) ?? { stage: "waiting", startedAt: this.begun.get(turnId) ?? now, workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {} };
  }

  /**
   * A Stop cut this turn's work: the reply's record, now stopping, goes to every window. What
   * waits behind it was held by the server's own rules in the same call (server chat/replies.ts).
   */
  private cut(turnId: string, at: number): void {
    const threadId = this.replies.get(turnId);
    // a record the test pushed as stopping has been sent already
    if (threadId === undefined || this.records.get(turnId)?.stoppedAt !== undefined) return;
    this.broadcast("chat.event", { turnId, threadId, event: { type: "reply", reply: { ...this.clock(turnId, at), stage: "stopping", stoppedAt: at } } });
  }

  /** Every record the server keeps, as reply.list answers a window that connects. */
  protected listing(): readonly ReplyListed[] {
    return this.store.records();
  }

  private queueCall(req: Request): readonly QueuedMessage[] | readonly ReplyListed[] | ReplyAnswer {
    if (req.method === "reply.list") return this.listing();
    const p = req.params as { id: string };
    const by = this.caller;
    const answer = this.replyCall(req, by);
    if (answer !== undefined) {
      if (req.method === "reply.edit" && answer.answer === "done") {
        if ((req.params as Params<"reply.edit">).open) this.editing.set(p.id, by);
        else this.editing.delete(p.id);
      }
      this.pump();
      return answer;
    }
    if (req.method === "queue.add") this.store.add(req.params as QueuedMessage);
    if (req.method === "queue.update") {
      const { id, ...patch } = req.params as Params<"queue.update">;
      if (this.store.update(id, patch, by) === "sending") throw Object.assign(new Error("This message is already being sent."), { code: "queue-sending" });
    }
    if (req.method === "queue.remove") this.store.remove({ id: p.id });
    this.pump();
    return this.store.list();
  }

  /** A call on one waiting message, answered by the server's own rules (server chat/replies.ts). */
  private replyCall(req: Request, by: number): ReplyAnswer | undefined {
    switch (req.method) {
      case "reply.change": return this.store.change(req.params as Params<"reply.change">, by);
      case "reply.edit": return this.store.edit(req.params as Params<"reply.edit">, by);
      case "reply.remove": return this.store.remove(req.params as Params<"reply.remove">);
      case "reply.now": return this.store.now(req.params as Params<"reply.now">);
      case "reply.hold": return this.store.hold(req.params as Params<"reply.hold">);
      case "reply.stop": return this.store.stop(req.params as Params<"reply.stop">);
      default: return undefined;
    }
  }

  /** A window's connection closed: the messages it had open in its composer are free again. */
  left(socket: FakeSocket): void {
    const by = this.sockets.indexOf(socket) + 1;
    for (const [id, who] of this.editing) {
      if (who !== by) continue;
      this.editing.delete(id);
      this.store.release(id, by);
    }
    this.pump();
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
      this.records.set(turnId, event.reply);
      if (event.reply.attempt > before) this.store.retrying(turnId);
      this.follow(turnId, event.reply);
      // the same times, on the record every window keeps
      this.store.clocked(turnId);
      return;
    }
    if (event.type === "start") {
      if (this.over.has(turnId)) return;
      if (!this.begun.has(turnId)) this.begun.set(turnId, Date.now());
      this.replies.set(turnId, threadId);
      this.questionSaved(turnId, threadId, event.userMessage, event.model, event.image === true);
      this.store.notify();
      return;
    }
    if (event.type !== "done" && event.type !== "error") return;
    this.over.add(turnId);
    this.replies.delete(turnId);
    // its chat.send may not be answered yet: the server's own turn has ended all the same
    for (const [id, t] of this.asked) if (t === threadId) this.asked.delete(id);
    const started = event.type === "done" || event.partial !== undefined || event.question !== undefined;
    // a turn the test never started (another window's, ended before this one looked): the server had its record all the same
    if (started && this.store.of(turnId) === undefined && !this.made.has(turnId)) this.direct(turnId, { threadId, content: "", messageId: `asked-${turnId}` });
    const rec = this.store.of(turnId);
    if (rec?.stage === "starting" && !started) {
      // refused, or cut, before its question was saved
      if (event.type === "error") this.store.refused(turnId, rec.attempt, { code: event.code, message: event.message, ...(event.blocking === undefined ? {} : { blocking: event.blocking }) });
    } else if (rec !== undefined) {
      // a test may push a turn's end with no start: its question was saved all the same
      if (rec.stage === "starting") this.questionSaved(turnId, threadId, { id: rec.words.messageId, threadId, role: "user", content: rec.words.text, createdAt: rec.words.at }, rec.words.model ?? "", rec.words.draw !== undefined);
      const end: End = event.type === "done" ? { how: "done", replyId: event.message.id }
        : event.ended?.reason === "failed" ? { how: "failed", code: event.code, message: event.message }
        : { how: "stopped", by: event.ended?.reason === "preempted" ? { who: "preempted" } : { who: "person" } };
      const rows = event.type === "done" ? [event.message] : event.partial !== undefined ? [event.partial] : event.question !== undefined ? [event.question] : [];
      this.store.ended(turnId, end, event.ended?.at ?? Date.now(), rows);
    }
    // its work has given back what it took
    this.store.left(turnId);
    this.store.notify();
    this.pump();
  }

  /**
   * A test pushed a turn's older record: the record every window keeps moves to the stage it says,
   * as the turn's work would have moved it (a load, a thought, a word, a call, a Stop at its time).
   */
  private follow(turnId: string, shown: ReplyRecord): void {
    const rec = this.store.of(turnId);
    if (rec === undefined) return;
    if (shown.stoppedAt !== undefined) return void this.store.stop({ id: turnId }, shown.stoppedAt);
    if (shown.stage === "loading") return void this.store.loading(turnId);
    if (!isLive(rec)) return;
    if (shown.stage === "tool") {
      if (rec.stage !== "tool") this.store.heard(turnId, { type: "tool", step: { callId: SHOWN_CALL, state: "running" } });
      return;
    }
    if (shown.stage !== "thinking" && shown.stage !== "writing") return;
    if (rec.calls.includes(SHOWN_CALL)) this.store.heard(turnId, { type: "tool", step: { callId: SHOWN_CALL, state: "done" } });
    this.store.heard(turnId, { type: shown.stage === "thinking" ? "thinking" : "delta", text: "." });
  }

  /** A turn's question was saved: its record becomes a reply. A turn the server made no record for (a test pushed its start) gets one first. */
  private questionSaved(turnId: string, threadId: string, question: Message, model: string, drawing: boolean): void {
    if (this.store.of(turnId) === undefined && !this.made.has(turnId)) this.direct(turnId, { threadId, content: question.content, messageId: question.id });
    const rec = this.store.of(turnId);
    if (rec?.stage === "starting") this.store.started(turnId, rec.attempt, question, model, { cold: false, drawing });
  }

  private pump(): void {
    if (this.pumpSoon) return;
    this.pumpSoon = true;
    setTimeout(() => { this.pumpSoon = false; this.sendQueued(); }, 0);
  }

  private sendQueued(): void {
    if (this.pumping) return;
    this.store.notify();
    const busy = new Set([...this.replies.values(), ...this.asked.values()]);
    const q = this.store.pick({ chat: this.runtimeReady && this.hasModels, anyWork: busy.size > 0, busy: (threadId) => busy.has(threadId) });
    if (q === undefined) return;
    this.pumping = true;
    const { words } = q;
    const params: Params<"chat.send"> = {
      threadId: q.threadId, content: words.text, messageId: words.messageId, model: words.model ?? "", numCtx: words.numCtx ?? 4096,
      ...(words.images?.length ? { images: words.images } : {}),
      ...(words.files?.length ? { files: words.files } : {}),
      ...(words.think === undefined ? {} : { think: words.think }),
      ...(words.draw === undefined ? {} : { draw: words.draw, ...(words.drawCount === undefined ? {} : { drawCount: words.drawCount }) }),
      ...(q.now ? (q.consent !== undefined ? { stopOthers: true, ...(q.consent.kind === "named" ? { stopTurns: [...q.consent.replies] } : {}) } : { askFirst: true }) : {}),
    };
    const done = () => { this.store.notify(); this.pumping = false; this.pump(); };
    const ok = (result: unknown) => {
      const r = result as { turnId?: string; replayed?: boolean };
      // its question turned out to be in the chat already: it was asked
      if (r.replayed === true) this.store.sent(words.messageId);
      else if (typeof r.turnId === "string") {
        const { turnId } = r;
        this.running(q.threadId, result);
        // The test names the turn in its answer, so the message is taken here, not before the call
        // as the server takes it. One that changed meanwhile is not taken: its turn runs as a send of its own.
        if (this.store.take(q.id, turnId, Date.now()) === undefined) this.direct(turnId, params);
        else {
          this.made.add(turnId);
          this.store.begun(turnId);
        }
      }
      sendAnswer((payload) => this.broadcast("chat.event", payload), params, result, () => undefined);
      done();
    };
    const err = (code: string, message = code, blocking?: unknown) => {
      // refused before any work began: taken and refused in one step, as the server's pump does
      const turnId = `server-refused-${this.serverCalls}`;
      const attempt = this.store.take(q.id, turnId, Date.now());
      if (attempt !== undefined) this.store.refused(turnId, attempt, { code, message, ...(blocking === undefined ? {} : { blocking: blocking as never }) });
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
