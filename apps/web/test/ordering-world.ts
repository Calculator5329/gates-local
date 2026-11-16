// Real sessions and protocol decoding; only the browser surface/transport and
// React's non-rendering hooks are supplied by the test. No browser is started.
import type { ReactNode } from "react";
import { isValidElement } from "react";
import { vi } from "vitest";
import type { Message, Params, Payload, Reply, ReplyListed, ResultOf, Settings, SettingsPatch, SyncDomain, SyncMetadata } from "@gates-local/contracts";
import { type Numbering, numberServer } from "./numbered-server.ts";
import { decodeResult } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { FakeServer, FakeSocket, installBrowser } from "./harness.ts";

export const SPEECH_URL = "http://speech.invalid";
type Request = Parameters<FakeServer["handle"]>[1];
interface Delivery { readonly socket: FakeSocket; readonly request: Request; readonly result: unknown; readonly sync?: SyncMetadata }

/** The chats a window shows a reply being written in, each with its turn id (null while its send waits for the answer). */
export function runningIds(store: typeof import("../src/lib/store/store.ts")): Record<string, string | null> {
  const s = store.getState();
  return Object.fromEntries([...store.runningThreads(s)].map((threadId) => [threadId, s.turns[threadId]?.turnId ?? null]));
}

/** The chat on screen's turn in a window, or null. */
export function openTurn(store: typeof import("../src/lib/store/store.ts")) {
  const s = store.getState();
  return s.threadId === null ? null : s.turns[s.threadId] ?? null;
}

/** A bounded microtask drain; event preconditions check readiness explicitly. */
export async function drain(): Promise<void> {
  for (let turn = 0; turn < 64; turn++) await Promise.resolve();
}

export class OrderingServer extends FakeServer {
  orderedSettings = false;
  private settingsRevision = 0;
  settingsSync(): SyncMetadata | undefined {
    // Setup-only external writers assign settings directly. Capture their
    // commit once, before either window receives its versioned push.
    if (JSON.stringify(this.settings) !== JSON.stringify(this.stampedSettings)) {
      this.settingsRevision++; this.stampedSettings = this.settings;
    }
    return this.orderedSettings ? { epoch: "replay-process", changes: [{ scope: "settings", kind: "snapshot", rev: this.settingsRevision }] } : undefined;
  }
  settings: Settings = { ...methodSamples["settings.get"].result, whisperUrl: SPEECH_URL };
  private stampedSettings = this.settings;
  readonly deliveries = new Map<string, Delivery>();
  readonly writes: Array<{ socket: FakeSocket; patch: SettingsPatch; key: string }> = [];
  connectName = "connect";
  readonly messages: Message[] = [];
  readonly turns = new Map<string, Message>();
  readonly admissions = new Map<string, Message>();
  readonly startTargets = new Map<string, readonly FakeSocket[]>();
  /** Turns whose reply is saved or ended: a window connecting now is told nothing of them. */
  readonly ended = new Set<string>();
  readonly cancelled: string[] = [];
  readonly labels = new Map<FakeSocket, string>();
  holdHydration = false;
  modelsSnapshot: ResultOf<"models.list">["models"] = methodSamples["models.list"].result.models;
  holdChat = false;
  deferAdmission = false;
  private nextTurn = 0;
  private nextHealth = 0;

  override handle(socket: FakeSocket, request: Request): void {
    const label = this.labels.get(socket) ?? "A";
    const save = (key: string, result: unknown, sync?: SyncMetadata) => this.deliveries.set(key, { socket, request, result, sync });
    const respond = (result: unknown, sync?: SyncMetadata) => socket.frame({ type: "response", id: request.id, ok: true, result, ...(sync ? { sync } : {}) });
    if (request.method === "sync.negotiate" && this.orderedSettings) {
      this.log.push(request); respond({ epoch: "replay-process", ordered: ["settings"] }); return;
    }
    if (request.method === "settings.get") {
      this.log.push(request);
      if (this.holdHydration && label === "A") save("snapshot", this.settings, this.settingsSync());
      else respond(this.settings, this.settingsSync());
    } else if (request.method === "models.list" && this.holdHydration && label === "A") {
      this.log.push(request); save("hydration", { runtime: methodSamples["models.list"].result.runtime, models: this.modelsSnapshot });
    } else if (request.method === "voice.check") {
      this.log.push(request); save(`health-${++this.nextHealth}`, methodSamples["voice.check"].result);
    } else if (request.method === "settings.update") {
      this.log.push(request);
      // The real wire decoder has already checked the outgoing request.
      const patch = request.params as Params<"settings.update">;
      const { voiceChange, whisperUrl, theme, imageGen } = patch;
      if (Object.keys(patch).some((key) => !["voiceChange", "whisperUrl", "theme", "imageGen"].includes(key))) throw new Error("Script a settings result for this patch first");
      const next = { ...this.settings, ...(theme ? { theme } : {}), ...(imageGen === undefined ? {} : { imageGen }), ...("whisperUrl" in patch ? { whisperUrl: whisperUrl ?? undefined } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(this.settings)) this.settingsRevision++;
      this.settings = next;
      this.stampedSettings = next;
      const key = `${label}-${"whisperUrl" in patch ? whisperUrl === null ? "disconnect" : this.connectName : "theme"}`;
      this.writes.push({ socket, patch, key });
      save(key, this.settings, this.settingsSync());
      // The sender's response and both windows' push deliveries are separate.
      this.deliveries.set(`${key}-push`, { socket, request, result: { ...this.settings, ...(voiceChange ? { voiceChange } : {}) }, sync: this.settingsSync() });
    } else if (request.method === "settings.model.update" && this.orderedSettings) {
      this.log.push(request);
      const { model, patch } = request.params as Params<"settings.model.update">;
      const overrides = { ...this.settings.modelSettings };
      if (patch === null) delete overrides[model];
      else overrides[model] = Object.fromEntries(Object.entries({ ...overrides[model], ...patch }).filter(([, value]) => value !== null));
      const decoded = decodeResult("settings.model.update", { ...this.settings, modelSettings: overrides });
      if (!decoded.ok) throw decoded.error;
      const next = decoded.value;
      if (JSON.stringify(next) !== JSON.stringify(this.settings)) this.settingsRevision++;
      this.settings = next; this.stampedSettings = next;
      const key = `${label}-model`;
      save(key, next, this.settingsSync());
      this.deliveries.set(`${key}-push`, { socket, request, result: next, sync: this.settingsSync() });
    } else if (request.method === "threads.get") {
      this.log.push(request);
      respond({ thread: methodSamples["threads.create"].result, messages: this.messages });
    } else if (request.method === "reply.send" && this.modelsSnapshot.length === 0) {
      // no model yet: the server keeps it waiting for the download, as the base server's queue does
      super.handle(socket, request);
    } else if (request.method === "chat.send" || request.method === "reply.send") {
      this.log.push(request);
      const { threadId, content, text, messageId, id, retryOf } = request.params as { threadId: string; content?: string; text?: string; messageId?: string; id?: string; retryOf?: string };
      const turnId = `turn-${++this.nextTurn}`;
      // saved under the id the send asked for, as app.ts saves it
      const userMessage: Message = { id: messageId ?? `user-${this.nextTurn}`, threadId, role: "user", content: content ?? text ?? "", createdAt: this.nextTurn };
      this.admissions.set(turnId, userMessage);
      if (id !== undefined) this.recordOf.set(turnId, id);
      if (retryOf !== undefined) this.retries.set(turnId, retryOf);
      // answered once it is taken (chat row 32); the start brings the saved question
      save(turnId, id === undefined ? { turnId } : { answer: "done", reply: this.startingRecord(turnId, userMessage) });
      if (!this.holdChat) this.response(turnId);
      if (!this.deferAdmission) this.admit(turnId);
    } else if (request.method === "reply.list") {
      this.log.push(request);
      respond(this.listed());
    } else if (request.method === "reply.stop") {
      this.log.push(request);
      const { id } = request.params as { id: string };
      // by the turn it stopped, whichever id the window named it by
      const turnId = [...this.recordOf].find(([, record]) => record === id)?.[0] ?? id;
      this.cancelled.push(turnId);
      // answered with the record it stopped, at a rev between its live one and its end
      const question = this.turns.get(turnId);
      respond(question === undefined ? methodSamples["reply.stop"].result : { answer: "done", reply: { ...this.live(turnId, question), rev: 3, stage: "stopping", stoppedAt: Date.now() } });
    } else super.handle(socket, request);
  }

  admit(turnId: string): void {
    const message = this.admissions.get(turnId);
    if (!message) throw new Error(`No pending admission: ${turnId}`);
    this.admissions.delete(turnId);
    this.messages.push(message); this.turns.set(turnId, message);
    // app.ts broadcasts start at admission, only to sockets open right then.
    this.startTargets.set(turnId, this.sockets.filter((socket) => socket.readyState === 1));
  }

  response(key: string, optional = false): void {
    const delivery = this.deliveries.get(key);
    if (!delivery) { if (optional) return; throw new Error(`No pending response: ${key}`); }
    this.deliveries.delete(key);
    delivery.socket.frame({ type: "response", id: delivery.request.id, ok: true, result: delivery.result, ...(delivery.sync ? { sync: delivery.sync } : {}) });
  }

  settingsPush(key: string, target: FakeSocket, tagged = true, optional = false): void {
    const delivery = this.deliveries.get(`${key}-push`);
    if (!delivery) { if (optional) return; throw new Error(`No committed settings push: ${key}`); }
    const payload = delivery.result as Payload<"settings.changed">;
    const { voiceChange: _voiceChange, ...settings } = payload;
    target.frame({ type: "push", channel: "settings.changed", payload: tagged ? payload : settings, ...(delivery.sync ? { sync: delivery.sync } : {}) });
  }

  /** The record each turn of a window's reply.send works for: the id the window made. */
  private readonly recordOf = new Map<string, string>();
  rid(turnId: string): string {
    return this.recordOf.get(turnId) ?? turnId;
  }
  /** The row each Retry's turn replaces. */
  private readonly retries = new Map<string, string>();
  private startingRecord(turnId: string, m: Message): Reply {
    const retryOf = this.retries.get(turnId);
    return { id: this.rid(turnId), threadId: m.threadId, rev: 1, messageId: m.id, text: m.content, at: m.createdAt, stage: "starting", attempt: 1, startedAt: 1, ...(retryOf === undefined ? {} : { retryOf }) };
  }

  /** A turn's record while its reply is written, as every window is told once its question is saved. */
  private live(turnId: string, question: Message): Reply {
    return { id: this.rid(turnId), threadId: question.threadId, rev: 2, questionId: question.id, model: "gemma3:4b", startedAt: 1, workMs: 0, toolMs: 0, try: 1, spans: [], callsAt: {}, stage: "thinking" };
  }

  /** What a window reads at connect: the messages that wait; and of this server's own turns, a send taken and not yet saved is on its way, a saved one is being written, an ended one is on no list. */
  private listed(): readonly ReplyListed[] {
    return [
      ...this.listing(),
      ...[...this.admissions].map(([turnId, m]): ReplyListed => ({ reply: this.startingRecord(turnId, m) })),
      ...[...this.turns].filter(([turnId]) => !this.ended.has(turnId)).map(([turnId, m]): ReplyListed => ({ reply: this.live(turnId, m) })),
    ];
  }

  /** The record's change follows the chat event on the same socket, as the server sends the two. */
  private record(target: FakeSocket, reply: Reply, saved: readonly Message[]): void {
    target.frame({ type: "push", channel: "reply.changed", payload: { kind: "is", reply, saved } });
  }

  chatPush(turnId: string, target: FakeSocket, done = false): void {
    const userMessage = this.turns.get(turnId);
    if (!userMessage) throw new Error(`No admitted turn: ${turnId}`);
    const message: Message = { ...userMessage, id: `reply-${turnId}`, role: "assistant", content: "reply" };
    const event: Payload<"chat.event">["event"] = done
      ? { type: "done", message, stopReason: "stop" }
      : { type: "start", model: "gemma3:4b", userMessage };
    target.frame({ type: "push", channel: "chat.event", payload: { turnId, replyId: this.rid(turnId), threadId: userMessage.threadId, event } });
    if (done) this.record(target, { id: this.rid(turnId), threadId: userMessage.threadId, rev: 4, stage: "done", at: Date.now(), questionId: userMessage.id, replyId: message.id }, [message]);
    else this.record(target, this.live(turnId, userMessage), [userMessage]);
  }

  /** How much of each turn's reply the server has written, for where its next words start. */
  private readonly written = new Map<string, number>();
  /** Words of a running reply; after Stop, its end with the saved row (runTurn in app.ts). */
  chatWords(turnId: string, target: FakeSocket, text: string, ended = false): void {
    const userMessage = this.turns.get(turnId);
    if (!userMessage) throw new Error(`No admitted turn: ${turnId}`);
    const event: Payload<"chat.event">["event"] = ended
      ? { type: "error", code: "cancelled", message: "stopped", partial: { id: `reply-${turnId}`, threadId: userMessage.threadId, role: "assistant", content: text, interrupted: true, createdAt: 1_000 }, ended: { reason: "stopped", at: Date.now() } }
      : { type: "delta", text };
    target.frame({ type: "push", channel: "chat.event", payload: { turnId, replyId: this.rid(turnId), threadId: userMessage.threadId, event } });
    if (event.type === "delta") {
      const from = this.written.get(turnId) ?? 0;
      this.written.set(turnId, from + text.length);
      target.frame({ type: "push", channel: "reply.words", payload: { id: this.rid(turnId), part: { type: "text", from, text } } });
    }
    if (event.type === "error" && event.partial !== undefined) this.record(target, { id: this.rid(turnId), threadId: userMessage.threadId, rev: 4, stage: "stopped", at: event.ended?.at ?? Date.now(), questionId: userMessage.id, replyId: event.partial.id, by: { who: "person" } }, [event.partial]);
  }

  /** A runtime error after some words: the terminal event carries the saved row and the server's reason. */
  chatFailed(turnId: string, target: FakeSocket, text: string, message: string): void {
    const userMessage = this.turns.get(turnId);
    if (!userMessage) throw new Error(`No admitted turn: ${turnId}`);
    const ended = { reason: "failed", at: 2_000 } as const;
    // the row carries how its turn ended, as the server stamps it (chat row 32)
    const partial: Message = { id: `reply-${turnId}`, threadId: userMessage.threadId, role: "assistant", content: text, interrupted: true, createdAt: 1_000,
      times: { startedAt: 1_000, spans: [], callsAt: {}, ended, why: { code: "runtime-error", message } } };
    target.frame({ type: "push", channel: "chat.event", payload: { turnId, replyId: this.rid(turnId), threadId: userMessage.threadId, event: { type: "error", code: "runtime-error", message, partial, ended } } });
    this.record(target, { id: this.rid(turnId), threadId: userMessage.threadId, rev: 4, stage: "failed", at: ended.at, questionId: userMessage.id, code: "runtime-error", message }, [partial]);
  }

  admittedPush(turnId: string, label: string): void {
    const target = this.startTargets.get(turnId)?.find((socket) => this.labels.get(socket) === label);
    if (target) this.chatPush(turnId, target);
  }
}

function button(node: ReactNode, name: string): (() => unknown) | undefined {
  if (Array.isArray(node)) return node.map((child) => button(child, name)).find((click) => click !== undefined);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => unknown }>(node)) return undefined;
  if (node.type === "button" && node.props.children === name) return node.props.onClick;
  return button(node.props.children, name);
}

export interface WindowSession {
  readonly session: typeof import("../src/lib/session/index.ts");
  readonly store: typeof import("../src/lib/store/store.ts");
  readonly drafts: typeof import("../src/lib/store/drafts.ts");
  readonly close: () => void;
  socket: FakeSocket;
  click(name: "Connect" | "Disconnect"): void;
}

export class OrderingWorld {
  readonly server = new OrderingServer();
  readonly windows: WindowSession[] = [];
  eligible = false;
  connectStarted = false;
  intent: "old" | "connect" | "disconnect" | null = null;
  readonly healthSaves = new Map<string, boolean>();
  expectedCancelled = new Set<string>();
  /** Set when the world was created serving numbered kinds. */
  numbering: Numbering | undefined;
  get a(): WindowSession { const a = this.windows[0]; if (!a) throw new Error("Missing window A"); return a; }
  get b(): WindowSession { const b = this.windows[1]; if (!b) throw new Error("Missing window B"); return b; }

  /** `serves`: kinds the server numbers from the first connection on (numbered-server.ts), as the real one does. */
  static async create(twoWindows = true, orderedSettings = process.env["REPLAY_ORDERED_SETTINGS"] !== "0", serves: readonly SyncDomain[] = []): Promise<OrderingWorld> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1_800_000_000_000);
    installBrowser();
    const world = new OrderingWorld();
    world.server.orderedSettings = orderedSettings;
    if (serves.length > 0) world.numbering = numberServer(world.server, { serves });
    vi.stubGlobal("WebSocket", class extends FakeSocket { constructor(url: string) { super(url, world.server); } });
    for (const label of twoWindows ? ["A", "B"] : ["A"]) {
      vi.resetModules();
      vi.doUnmock("../src/lib/session/index.ts");
      // Historical source is read from a cache copy, with imports redirected
      // to the current support modules. Current runs use the production file.
      const historical = process.env["REPLAY_SESSION"];
      const session: typeof import("../src/lib/session/index.ts") = historical ? await import(/* @vite-ignore */ historical) : await import("../src/lib/session/index.ts");
      const store = await import("../src/lib/store/store.ts");
      const drafts = await import("../src/lib/store/drafts.ts");
      if (historical) vi.doMock("../src/lib/session/index.ts", () => session);
      const { VoiceSettings } = await import("../src/voice/VoiceSettings.tsx");
      const close = session.connect();
      await drain();
      const socket = world.server.socket;
      world.server.labels.set(socket, label);
      if (store.getState().imageStatus === undefined) throw new Error("Boot did not finish within 64 promise jobs");
      const tree = VoiceSettings();
      world.windows.push({ session, store, drafts, close, socket, click(name) {
        const click = button(tree, name);
        if (!click) throw new Error(`Missing ${name} button`);
        click();
      } });
    }
    return world;
  }

  async drop(): Promise<void> {
    this.server.holdHydration = true;
    this.a.socket.close();
    await drain();
  }

  async reconnect(): Promise<void> {
    await vi.advanceTimersByTimeAsync(250);
    await drain();
    this.a.socket = this.server.socket;
    this.server.labels.set(this.a.socket, "A");
    if (!this.server.deliveries.has("snapshot") || !this.server.deliveries.has("hydration")) throw new Error("Reconnect did not request hydration");
  }

  async step(run: () => void): Promise<void> { run(); await drain(); }

  async dispose(): Promise<void> {
    for (const window of this.windows) window.close();
    this.server.accepting = false;
    for (const socket of this.server.sockets) socket.close();
    await drain();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
    vi.doUnmock("../src/lib/session/index.ts");
  }
}
