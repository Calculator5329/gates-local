// An in-memory browser and server for the client's session tests: a fake
// WebSocket that speaks the protocol envelopes, a server that answers every
// method from the contract samples unless a test overrides or holds it, and
// the few browser globals session.ts touches (location, history, document,
// localStorage, requestAnimationFrame). Each test imports session.ts fresh.
import { vi } from "vitest";
import { type Channel, type Message, type MethodName, type Params, type Payload, type ReplyAnswer, type ReplyListed, type ResultOf, type ScopeName, type SyncDomain, type SyncMetadata, type SyncRow, type ToolStep, ORDERED_DOMAINS, PROTOCOL_VERSION, chatScope, methodSync, pushSync, scopesOf } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { createReplies } from "@gates-local/server/chat/replies.ts";
import { isLive, type End } from "@gates-local/server/chat/reply.ts";
import type { StartAnswer, StartParams, TurnSaid } from "@gates-local/server/app/turn.ts";
import type { ReplyRecord } from "@gates-local/server/chat/times.ts";

/** A push channel, or "turn": what a turn says as it runs, which the fake server takes as the real one does. */
type Pushed = Channel | "turn";
type PayloadOf<C extends Pushed> = C extends "turn" ? TurnSaid : C extends Channel ? Payload<C> : never;

/** The call a pushed record stands for when it says "tool" and the test pushed no step of its own. */
const SHOWN_CALL = "shown-call";

type Listener = (event: { data?: unknown }) => void;

/** The server starting a turn for a message it took: no call on the wire, but a test holds or answers it as one. */
type FakeMethod = MethodName | "turn.start";
const STARTED: StartAnswer = { turnId: "turn-1", userMessage: { id: "m1", threadId: "t1", role: "user", content: "hello", createdAt: 1 } };

export interface Held<M extends MethodName> {
  readonly params: Params<M>;
  respond(result: ResultOf<M>): void;
  fail(code: string, message?: string, blocking?: unknown): void;
}

export interface HeldStart {
  readonly params: StartParams;
  respond(result: StartAnswer): void;
  fail(code: string, message?: string, blocking?: unknown): void;
}

/** A call the server makes itself (turn.start), logged beside the windows' calls. */
type Logged = Omit<Request, "method"> & { readonly method: FakeMethod };

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
    if (this.readyState === 1) this.emit("message", { data: JSON.stringify(this.server.stamped(this, value)) });
  }
}

type Answer = (params: never) => unknown;

/** The chats a threads.list answer names: it carries each one's own number beside the list's. */
const listedIn = (method: MethodName, result: unknown): readonly string[] =>
  method === "threads.list" && Array.isArray(result) ? result.map((t: { id: string }) => t.id) : [];

/**
 * A turn's start as the server pushes it: the test's answer names the turn and the saved question.
 * A replayed answer, or one without the question (the test pushes the start itself), pushes nothing.
 */
function sendAnswer(start: (payload: TurnSaid) => void, params: StartParams, result: unknown, answer: (result: unknown) => void): void {
  const r = result as { turnId?: string; userMessage?: Message; replayed?: boolean } | null;
  if (r === null || typeof r !== "object" || r.userMessage === undefined || r.replayed === true || r.turnId === undefined) return answer(result);
  const { turnId, userMessage } = r;
  answer({ turnId });
  const event: TurnSaid["event"] = params.draw !== undefined
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
  private readonly answers = new Map<FakeMethod, Answer>([["turns.blocking", () => []], ["turn.start", () => STARTED],
    ["sync.negotiate", (p: Params<"sync.negotiate">) => ({ epoch: this.epoch, ordered: ORDERED_DOMAINS.filter((d) => p.ordered.includes(d)), protocol: PROTOCOL_VERSION })]]);
  private readonly holds = new Map<FakeMethod, Array<(h: Held<never>) => void>>();
  readonly log: Logged[] = [];

  /** The open socket, the one the client uses now. */
  get socket(): FakeSocket {
    const s = this.sockets.findLast((x) => x.readyState === 1);
    if (!s) throw new Error("no open socket");
    return s;
  }

  /** Answer every call of this method with fn's result; a thrown { code, message } fails it. */
  answer<M extends MethodName>(method: M, fn: (params: Params<M>) => ResultOf<M>): void;
  answer(method: "turn.start", fn: (params: StartParams) => StartAnswer): void;
  answer(method: FakeMethod, fn: (params: never) => unknown): void {
    this.answers.set(method, fn as Answer);
  }

  /** The next call of this method waits until the test responds to it. */
  hold<M extends MethodName>(method: M): Promise<Held<M>>;
  hold(method: "turn.start"): Promise<HeldStart>;
  hold(method: FakeMethod): Promise<unknown> {
    return new Promise((resolve) => {
      const list = this.holds.get(method) ?? [];
      list.push(resolve as (h: Held<never>) => void);
      this.holds.set(method, list);
    });
  }

  /** The record a server turn works for: a window keys its live reply by this id, made at the press for its own reply.send. */
  replyOf(turnId: string): string {
    return this.alias.get(turnId) ?? turnId;
  }

  calls(method: FakeMethod): Logged[] {
    return this.log.filter((r) => r.method === method);
  }

  /** The epoch every negotiation answers; a test sets a new one to stand for a restarted server. */
  epoch = "sample-process";
  private readonly revs = new Map<string, number>();
  /** What each socket's negotiation answered, whoever answered it. */
  private readonly agreed = new WeakMap<FakeSocket, { readonly epoch: string; readonly ordered: readonly SyncDomain[] }>();

  /**
   * The numbers a frame of `row` carries, taken now: the next for each whole thing, so an answer
   * read before a later push is older than it, as on the real server. A chat's own number (its
   * messages) moves only when a test says so (`chatWritten`), never with its row. The chat list
   * also carries the number of each chat it lists (`listed`).
   */
  private numbers(socket: FakeSocket, row: SyncRow | undefined, about: unknown, listed: readonly string[] = []): SyncMetadata | undefined {
    const agreed = this.agreed.get(socket);
    if (row === undefined || agreed === undefined || !agreed.ordered.includes(row.domain)) return undefined;
    return { epoch: agreed.epoch, changes: [...scopesOf(row, about).map((scope) => {
      const rev = (this.revs.get(scope) ?? 0) + (scope.startsWith("thread:") ? 0 : 1);
      this.revs.set(scope, rev);
      return { scope, kind: "snapshot" as const, rev };
    }), ...this.chats(listed)] };
  }

  private chats(ids: readonly string[]): SyncMetadata["changes"] {
    return ids.map((id) => ({ scope: chatScope(id), kind: "snapshot" as const, rev: this.revs.get(chatScope(id)) ?? 0 }));
  }

  // why: a test that frames an answer or a push itself gets the number the server would give it as it goes
  stamped(socket: FakeSocket, value: unknown): unknown {
    const frame = value as { type?: string; ok?: boolean; id?: string; channel?: Channel; payload?: unknown; sync?: SyncMetadata };
    if ("sync" in frame) return value;
    if (frame.type === "push" && frame.channel !== undefined) {
      const sync = this.numbers(socket, pushSync(frame.channel), frame.payload);
      return sync === undefined ? value : { ...frame, sync };
    }
    if (frame.type !== "response" || frame.ok !== true) return value;
    const request = socket.sent.find((r) => r.id === frame.id);
    if (request?.method === "sync.negotiate") {
      const result = (frame as { result: { epoch: string; ordered: readonly SyncDomain[] } }).result;
      this.agreed.set(socket, { epoch: result.epoch, ordered: result.ordered });
      return value;
    }
    const sync = request === undefined ? undefined : this.numbers(socket, methodSync(request.method), request.params, listedIn(request.method, (frame as { result?: unknown }).result));
    return sync === undefined ? value : { ...frame, sync };
  }

  /** The number a push of `scope` carries when it goes out with the write that has the number now. */
  at(scope: ScopeName): SyncMetadata {
    return { epoch: this.epoch, changes: [{ scope, kind: "snapshot", rev: this.revs.get(scope) ?? 0 }] };
  }

  /** Another window wrote to a chat's messages: its number moves, and the next row pushed for it says so. */
  chatWritten(threadId: string): void {
    const scope = chatScope(threadId);
    this.revs.set(scope, (this.revs.get(scope) ?? 0) + 1);
  }

  // why: a test that holds an answer itself gives it the number it took when it was handled
  numbersFor(socket: FakeSocket, req: Request): SyncMetadata | undefined {
    return this.numbers(socket, methodSync(req.method), req.params);
  }

  handle(socket: FakeSocket, req: Request): void {
    this.log.push(req);
    this.caller = this.sockets.indexOf(socket) + 1;
    const sync = this.numbers(socket, methodSync(req.method), req.params);
    const answer = (result: unknown) => {
      const chats = this.chats(listedIn(req.method, result));
      socket.frame({ type: "response", id: req.id, ok: true, result, ...(sync === undefined ? {} : { sync: { ...sync, changes: [...sync.changes, ...chats] } }) });
    };
    const err = (code: string, message = code, blocking?: unknown) => {
      socket.frame({ type: "response", id: req.id, ok: false, error: { code, message, ...(blocking === undefined ? {} : { blocking }) } });
    };
    if (req.method === "reply.send" && !this.holds.get(req.method)?.length && !this.answers.has(req.method)) return this.replySend(req, answer, err);
    this.route(req, answer, err);
  }

  /**
   * reply.send as the server answers it (app/handlers.ts): the record is made at once under the
   * window's id. One with nothing in its way starts now, as a turn.start the test holds or
   * answers; the turn the test names is another name for that record.
   */
  private replySend(req: Request, answer: (result: unknown) => void, fail: (code: string, message?: string, blocking?: unknown) => void): void {
    const p = req.params as Params<"reply.send">;
    const behind = p.draw !== undefined || (this.runtimeReady && this.hasModels) ? "reply" as const : !this.runtimeReady ? "setup" as const : "download" as const;
    const busy = [...this.replies.values(), ...this.asked.values()].includes(p.threadId);
    const sent = this.store.send(p, { at: Date.now(), behind, busy, turnId: p.id });
    if (sent.kind === "cannot") return fail("turn-active", `thread ${p.threadId} has a reply on its way or a message waiting; a Retry does not wait`);
    if (sent.kind === "answer") {
      this.pump();
      return answer(sent.answer);
    }
    const { words } = sent.picked;
    const params: StartParams = {
      threadId: p.threadId, content: words.text, messageId: words.messageId, model: words.model ?? "", numCtx: words.numCtx ?? 4096,
      ...(words.images?.length ? { images: words.images } : {}),
      ...(words.files?.length ? { files: words.files } : {}),
      ...(words.think === undefined ? {} : { think: words.think }),
      ...(words.retryOf === undefined ? {} : { retryOf: words.retryOf }),
      ...(words.draw === undefined ? {} : { draw: words.draw, ...(words.drawCount === undefined ? {} : { drawCount: words.drawCount }) }),
      ...(sent.picked.now ? (sent.picked.consent !== undefined ? { stopOthers: true, ...(sent.picked.consent.kind === "named" ? { stopTurns: [...sent.picked.consent.replies] } : {}) } : { askFirst: true }) : {}),
    };
    const call: Logged = { id: `server-${++this.serverCalls}`, method: "turn.start", params };
    this.log.push(call);
    // until it is answered, the send is in its chat's way
    this.asked.set(call.id, p.threadId);
    this.starting.set(p.id, { threadId: p.threadId, messageId: words.messageId });
    const settle = () => {
      this.asked.delete(call.id);
      this.starting.delete(p.id);
    };
    const ok = (result: unknown) => {
      settle();
      const r = result as { turnId?: string; userMessage?: Message; replayed?: boolean };
      if (r.replayed === true) {
        this.store.refused(p.id, sent.attempt, { code: "internal", message: "this message was already sent" });
        this.store.sent(words.messageId);
        this.pump();
        return answer({ answer: "gone", why: "sent", ...(r.userMessage === undefined ? {} : { question: r.userMessage }) });
      }
      if (typeof r.turnId === "string") this.alias.set(r.turnId, p.id);
      // a Stop took it back while it started: its work saves nothing
      if (!this.store.starting(p.id, sent.attempt)) {
        this.pump();
        return answer(sent.answer());
      }
      this.running(p.threadId, { turnId: p.id });
      this.made.add(p.id);
      this.store.begun(p.id);
      answer(sent.answer());
      sendAnswer((payload) => this.broadcast("turn", payload), params, { ...r, turnId: p.id }, () => undefined);
      this.pump();
    };
    const err = (code: string, message = code, blocking?: unknown) => {
      settle();
      this.store.refused(p.id, sent.attempt, { code, message, ...(blocking === undefined ? {} : { blocking: blocking as never }) });
      this.pump();
      // a Retry has no row to hold its refusal: the window that pressed it is told
      if (p.retryOf !== undefined) return fail(code, message, blocking);
      answer(sent.answer());
    };
    this.route(call, ok, err);
  }
  /** The windows' reply.send records still waiting for the test's turn.start answer, by record id. */
  private readonly starting = new Map<string, { readonly threadId: string; readonly messageId: string }>();
  /** A turn id a test named, for the record it works for. */
  private readonly alias = new Map<string, string>();

  /**
   * A chat event a test pushed under the turn id it named, under the record's id. A start that
   * saved the question of a send still waiting for its answer is that send's: it began.
   */
  private aliased<C extends Pushed>(channel: C, payload: PayloadOf<C>): PayloadOf<C> {
    if (channel !== "turn") return payload;
    const p = payload as TurnSaid;
    if (!this.alias.has(p.turnId) && p.event.type === "start" && !this.made.has(p.turnId) && this.store.of(p.turnId) === undefined) {
      const question = p.event.userMessage.id;
      const mine = [...this.starting].find(([, s]) => s.threadId === p.threadId && s.messageId === question)?.[0];
      if (mine !== undefined) {
        this.alias.set(p.turnId, mine);
        this.running(p.threadId, { turnId: mine });
        this.made.add(mine);
        this.store.begun(mine);
      }
    }
    const to = this.alias.get(p.turnId);
    return (to === undefined ? payload : { ...p, turnId: to }) as PayloadOf<C>;
  }

  /** A test's hold or answer for the method, else the queue's own answer, else the contract sample. */
  private route(req: Logged, ok: (result: unknown) => void, err: (code: string, message?: string, blocking?: unknown) => void): void {
    const waiting = this.holds.get(req.method);
    const next = waiting?.shift();
    if (next) {
      next({ params: req.params as never, respond: ok, fail: err });
      return;
    }
    const fn = this.answers.get(req.method);
    try {
      ok(fn ? fn(req.params as never) : req.method.startsWith("reply.") ? this.queueCall(req as Request) : methodSamples[req.method as MethodName].result);
    } catch (e) {
      const f = e as { code?: string; message?: string; blocking?: unknown };
      err(f.code ?? "internal", f.message ?? "failed", f.blocking);
    }
  }

  /**
   * `sync`: the number an ordered push carries (numbered-server.ts gives it). A "turn" is what the
   * server's turn says as it runs (app/turn.ts): no window hears it, only its words and record.
   */
  push<C extends Pushed>(channel: C, given: PayloadOf<C>, sync?: SyncMetadata): void {
    this.sent(() => [this.socket], channel, given, sync);
  }

  /** A push to every open socket, as the real server sends it to each connected client. */
  broadcast<C extends Pushed>(channel: C, given: PayloadOf<C>): void {
    this.sent(() => this.sockets, channel, given);
  }

  private sent<C extends Pushed>(to: () => readonly FakeSocket[], channel: C, given: PayloadOf<C>, sync?: SyncMetadata): void {
    const payload = this.aliased(channel, given);
    const words = this.words(channel, payload);
    if (!this.muted) for (const s of to()) {
      if (channel !== "turn") s.frame({ type: "push", channel, payload, ...(sync === undefined ? {} : { sync }) });
      if (words !== undefined) s.frame({ type: "push", channel: "reply.words", payload: words });
    }
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

  /** Each running reply's words so far, by record id, as the server's turn keeps them (app/run-turn.ts). */
  private readonly said = new Map<string, { text: string; thinking: string; steps: Map<string, ToolStep> }>();

  /** The reply.words push that goes with a chat event's words, each part saying where it starts. */
  private words<C extends Pushed>(channel: C, payload: PayloadOf<C>): Payload<"reply.words"> | undefined {
    if (channel !== "turn") return undefined;
    const { turnId, event } = payload as TurnSaid;
    const id = (payload as TurnSaid).replyId ?? this.store.of(turnId)?.id;
    if (id === undefined) return undefined;
    if (event.type === "done" || event.type === "error") return void this.said.delete(id);
    if (event.type === "reply") {
      if (event.reply.attempt <= (this.attempts.get(turnId) ?? 1)) return undefined;
      this.said.delete(id);
      return { id, part: { type: "again" } };
    }
    if (event.type !== "delta" && event.type !== "thinking" && event.type !== "tool") return undefined;
    const so = this.said.get(id) ?? { text: "", thinking: "", steps: new Map<string, ToolStep>() };
    this.said.set(id, so);
    if (event.type === "tool") {
      so.steps.set(event.step.callId, event.step);
      return { id, part: event };
    }
    const kind = event.type === "delta" ? "text" : "thinking";
    const from = so[kind].length;
    so[kind] += event.text;
    return event.text === "" ? undefined : { id, part: { type: kind, from, text: event.text } };
  }


  // The server's record of every message: its real rules (server chat/replies.ts) and, in small,
  // the server's pump (app/queue-pump.ts) and what a turn's work says to its record. A waiting
  // message goes out as a turn.start the server makes itself, logged with the windows' calls and
  // answered by the same holds and answers.
  private readonly store = createReplies({
    log: () => undefined,
    told: (change) => this.broadcast("reply.changed", change),
    saved: () => undefined,
    deleting: () => false,
    closing: () => false,
    cut: (turnId, at) => this.cut(turnId, at),
    clock: (turnId, now) => this.clock(turnId, now),
  });
  /** The waiting messages, for a test that changes them as another window would. */
  readonly queue = {
    /** Sent from another window while its chat is busy, so it waits: on hold with `held`. */
    add: ({ at = 1, waitFor = "reply", ...said }: Params<"reply.send"> & { readonly at?: number; readonly waitFor?: "setup" | "download" | "reply" }) => {
      this.store.send(said, { at, behind: waitFor, busy: true, turnId: said.id });
    },
    /** New words from another window, from the words the server has. */
    change: (id: string, words: { readonly messageId: string; readonly text?: string }) => this.another(() => {
      const base = this.store.list().find((e) => e.id === id)?.messageId ?? words.messageId;
      return this.store.change({ id, base, ...words }, 0);
    }),
    now: (id: string) => this.another(() => this.store.now({ id })),
    remove: (id: string) => this.store.remove({ id }).answer === "done",
    list: () => this.store.list(),
  };
  /** Another window's call: the server looks at what may start now, as it does after any call. */
  private another(call: () => ReplyAnswer): ReplyAnswer {
    const answer = call();
    this.pump();
    return answer;
  }
  /** Which connection has each message open in its composer, and which one is calling now. */
  private readonly editing = new Map<string, number>();
  private caller = 0;
  /** Turns from an answered turn.start until their done or error, by id: their chats. */
  private readonly replies = new Map<string, string>();
  /** The server's turn.start calls not answered yet, by call id: their chats. */
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

  /** The turn a turn.start was answered with, now in its chat's way; none for a replayed answer or a turn already over. */
  private running(threadId: string, result: unknown): string | undefined {
    const r = result as { turnId?: string; replayed?: boolean } | null;
    // a test may push a turn's end before its turn.start is answered
    if (r === null || typeof r !== "object" || r.replayed === true || typeof r.turnId !== "string" || this.over.has(r.turnId)) return undefined;
    this.replies.set(r.turnId, threadId);
    if (!this.begun.has(r.turnId)) this.begun.set(r.turnId, Date.now());
    return r.turnId;
  }

  /** The record of a turn the test started without a send: taken at once, as a send into a free chat is (server app/handlers.ts). */
  private direct(turnId: string, send: Pick<StartParams, "threadId" | "content" | "messageId" | "retryOf">): void {
    const at = this.begun.get(turnId) ?? Date.now();
    this.made.add(turnId);
    const { threadId, content: text, messageId = turnId, retryOf } = send;
    this.store.send({ id: turnId, threadId, text, messageId, numCtx: 4096, ...(retryOf === undefined ? {} : { retryOf }) }, { at, behind: "reply", busy: false, turnId });
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
    this.broadcast("turn", { turnId, threadId, event: { type: "reply", reply: { ...this.clock(turnId, at), stage: "stopping", stoppedAt: at } } });
  }

  /** Every record the server keeps, as reply.list answers a window that connects. */
  protected listing(): readonly ReplyListed[] {
    return this.store.records().map((l) => {
      const so = this.said.get(l.reply.id);
      // why: words come only after the question is saved; a reply still starting has none to list
      return so === undefined || l.reply.stage === "starting" ? l : { ...l, soFar: { text: so.text, thinking: so.thinking, steps: [...so.steps.values()] } };
    });
  }

  private queueCall(req: Request): readonly ReplyListed[] | ReplyAnswer {
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
    throw new Error(`the fake server does not answer ${req.method}`);
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
    for (const [id, who] of this.editing) if (who === by) this.editing.delete(id);
    this.store.windowGone(by);
    this.pump();
  }

  /** The server's catalog changed with no push yet (a scenario delivers that itself): its queue sees it. */
  catalogChanged(models: readonly unknown[]): void {
    this.hasModels = models.length > 0;
    this.pump();
  }

  private pushed(channel: Pushed, payload: unknown): void {
    if (channel === "turn") this.heard(payload as TurnSaid);
    if (channel === "runtime.changed") { this.runtimeReady = (payload as Payload<"runtime.changed">).state === "ready"; this.pump(); }
    if (channel === "models.changed") { this.hasModels = (payload as Payload<"models.changed">).length > 0; this.pump(); }
  }

  private heard({ turnId, threadId, event }: TurnSaid): void {
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
    // its turn.start may not be answered yet: the server's own turn has ended all the same
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
    const params: StartParams = {
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
      sendAnswer((payload) => this.broadcast("turn", payload), params, result, () => undefined);
      done();
    };
    const err = (code: string, message = code, blocking?: unknown) => {
      // refused before any work began: taken and refused in one step, as the server's pump does
      const turnId = `server-refused-${this.serverCalls}`;
      const attempt = this.store.take(q.id, turnId, Date.now());
      if (attempt !== undefined) this.store.refused(turnId, attempt, { code, message, ...(blocking === undefined ? {} : { blocking: blocking as never }) });
      done();
    };
    const req: Logged = { id: `server-${++this.serverCalls}`, method: "turn.start", params };
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
