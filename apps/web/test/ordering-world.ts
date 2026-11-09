// Real sessions and protocol decoding; only the browser surface/transport and
// React's non-rendering hooks are supplied by the test. No browser is started.
import type { ReactNode } from "react";
import { isValidElement } from "react";
import { vi } from "vitest";
import type { Message, Params, Payload, ResultOf, Settings, SettingsPatch } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { FakeServer, FakeSocket, installBrowser } from "./harness.ts";

export const SPEECH_URL = "http://speech.invalid";
type Request = Parameters<FakeServer["handle"]>[1];
interface Delivery { readonly socket: FakeSocket; readonly request: Request; readonly result: unknown }

/** A bounded microtask drain; event preconditions check readiness explicitly. */
export async function drain(): Promise<void> {
  for (let turn = 0; turn < 64; turn++) await Promise.resolve();
}

export class OrderingServer extends FakeServer {
  settings: Settings = { ...methodSamples["settings.get"].result, whisperUrl: SPEECH_URL };
  readonly deliveries = new Map<string, Delivery>();
  readonly writes: Array<{ socket: FakeSocket; patch: SettingsPatch; key: string }> = [];
  connectName = "connect";
  readonly messages: Message[] = [];
  readonly turns = new Map<string, Message>();
  readonly admissions = new Map<string, Message>();
  readonly startTargets = new Map<string, readonly FakeSocket[]>();
  readonly cancelled: string[] = [];
  readonly labels = new Map<FakeSocket, string>();
  holdHydration = false;
  modelsSnapshot: ResultOf<"models.list"> = methodSamples["models.list"].result;
  holdChat = false;
  deferAdmission = false;
  private nextTurn = 0;
  private nextHealth = 0;

  override handle(socket: FakeSocket, request: Request): void {
    const label = this.labels.get(socket) ?? "A";
    const save = (key: string, result: unknown) => this.deliveries.set(key, { socket, request, result });
    const respond = (result: unknown) => socket.frame({ type: "response", id: request.id, ok: true, result });
    if (request.method === "settings.get") {
      this.log.push(request);
      if (this.holdHydration && label === "A") save("snapshot", this.settings);
      else respond(this.settings);
    } else if (request.method === "models.list" && this.holdHydration && label === "A") {
      this.log.push(request); save("hydration", this.modelsSnapshot);
    } else if (request.method === "voice.check") {
      this.log.push(request); save(`health-${++this.nextHealth}`, methodSamples["voice.check"].result);
    } else if (request.method === "settings.update") {
      this.log.push(request);
      // The real wire decoder has already checked the outgoing request.
      const patch = request.params as Params<"settings.update">;
      const { voiceChange, whisperUrl, theme, imageGen } = patch;
      if (Object.keys(patch).some((key) => !["voiceChange", "whisperUrl", "theme", "imageGen"].includes(key))) throw new Error("Script a settings result for this patch first");
      this.settings = { ...this.settings, ...(theme ? { theme } : {}), ...(imageGen === undefined ? {} : { imageGen }), ...("whisperUrl" in patch ? { whisperUrl: whisperUrl ?? undefined } : {}) };
      const key = `${label}-${"whisperUrl" in patch ? whisperUrl === null ? "disconnect" : this.connectName : "theme"}`;
      this.writes.push({ socket, patch, key });
      save(key, this.settings);
      // The sender's response and both windows' push deliveries are separate.
      this.deliveries.set(`${key}-push`, { socket, request, result: { ...this.settings, ...(voiceChange ? { voiceChange } : {}) } });
    } else if (request.method === "threads.get") {
      this.log.push(request);
      respond({ thread: methodSamples["threads.create"].result, messages: this.messages });
    } else if (request.method === "chat.send") {
      this.log.push(request);
      const { threadId, content } = request.params as { threadId: string; content: string };
      const turnId = `turn-${++this.nextTurn}`;
      const userMessage: Message = { id: `user-${this.nextTurn}`, threadId, role: "user", content, createdAt: this.nextTurn };
      this.admissions.set(turnId, userMessage);
      if (!this.deferAdmission) this.admit(turnId);
      save(turnId, { turnId, userMessage });
      if (!this.holdChat) this.response(turnId);
    } else if (request.method === "chat.cancel") {
      this.log.push(request);
      this.cancelled.push((request.params as { turnId: string }).turnId);
      respond({ cancelled: true });
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
    delivery.socket.frame({ type: "response", id: delivery.request.id, ok: true, result: delivery.result });
  }

  settingsPush(key: string, target: FakeSocket, tagged = true, optional = false): void {
    const delivery = this.deliveries.get(`${key}-push`);
    if (!delivery) { if (optional) return; throw new Error(`No committed settings push: ${key}`); }
    const payload = delivery.result as Payload<"settings.changed">;
    const { voiceChange: _voiceChange, ...settings } = payload;
    target.frame({ type: "push", channel: "settings.changed", payload: tagged ? payload : settings });
  }

  chatPush(turnId: string, target: FakeSocket, done = false): void {
    const userMessage = this.turns.get(turnId);
    if (!userMessage) throw new Error(`No admitted turn: ${turnId}`);
    const event: Payload<"chat.event">["event"] = done
      ? { type: "done", message: { ...userMessage, id: `reply-${turnId}`, role: "assistant", content: "reply" }, stopReason: "stop" }
      : { type: "start", model: "gemma3:4b", userMessage };
    target.frame({ type: "push", channel: "chat.event", payload: { turnId, threadId: userMessage.threadId, event } });
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
  readonly session: typeof import("../src/session.ts");
  readonly store: typeof import("../src/store.ts");
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
  get a(): WindowSession { const a = this.windows[0]; if (!a) throw new Error("Missing window A"); return a; }
  get b(): WindowSession { const b = this.windows[1]; if (!b) throw new Error("Missing window B"); return b; }

  static async create(twoWindows = true): Promise<OrderingWorld> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1_800_000_000_000);
    installBrowser();
    const world = new OrderingWorld();
    vi.stubGlobal("WebSocket", class extends FakeSocket { constructor(url: string) { super(url, world.server); } });
    for (const label of twoWindows ? ["A", "B"] : ["A"]) {
      vi.resetModules();
      vi.doUnmock("../src/session.ts");
      // Historical source is read from a cache copy, with imports redirected
      // to the current support modules. Current runs use the production file.
      const historical = process.env["REPLAY_SESSION"];
      const session: typeof import("../src/session.ts") = historical ? await import(/* @vite-ignore */ historical) : await import("../src/session.ts");
      const store = await import("../src/store.ts");
      if (historical) vi.doMock("../src/session.ts", () => session);
      const { VoiceSettings } = await import("../src/VoiceSettings.tsx");
      const close = session.connect();
      await drain();
      const socket = world.server.socket;
      world.server.labels.set(socket, label);
      if (store.getState().imageStatus === undefined) throw new Error("Boot did not finish within 64 promise jobs");
      const tree = VoiceSettings();
      world.windows.push({ session, store, close, socket, click(name) {
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
    vi.doUnmock("../src/session.ts");
  }
}
