// Probe the real sidebar over the real session/store and the in-memory wire.
// The store hook reads a snapshot for static rendering; no browser runs here.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Payload } from "@gates-local/contracts";
import type { State } from "../src/store.ts";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

type Session = typeof import("../src/session.ts");
type Store = typeof import("../src/store.ts");
type Selector = (s: State) => unknown;
const IDS = ["A", "B", "C"];
const MODEL = "gemma3:4b";
const thread = (id: string) => ({ id, title: `Chat ${id}`, createdAt: 1, updatedAt: 1 });
const user = (id: string, threadId: string): Message => ({ id, threadId, role: "user", content: "hello", createdAt: 1 });
const reply = (threadId: string): Message => ({ id: `reply-${threadId}`, threadId, role: "assistant", content: "finished", model: MODEL, createdAt: 2 });

let b: Browser;
let session: Session;
let store: Store;
let Sidebar: typeof import("../src/Sidebar.tsx")["Sidebar"];
let disconnect: (() => void) | undefined;
let capture = false;
let selectors: Selector[];

const chat = (turnId: string, threadId: string, event: Payload<"chat.event">["event"]) => b.server.push("chat.event", { turnId, threadId, event });
/** The open chat's turn (what the old single live slot showed), or null. */
const openTurn = () => { const s = store.getState(); return s.threadId === null ? null : s.turns[s.threadId] ?? null; };

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  selectors = [];
  capture = false;
  vi.spyOn(store, "useStore").mockImplementation(<T>(selector: (s: State) => T): T => {
    if (capture) selectors.push(selector);
    return selector(store.getState());
  });
  ({ Sidebar } = await import("../src/Sidebar.tsx"));
  b.server.answer("threads.list", () => IDS.map(thread));
  b.server.answer("threads.get", ({ threadId }) => ({ thread: thread(threadId), messages: [] }));
  let n = 0;
  b.server.answer("chat.send", ({ threadId, model }) => {
    const turnId = `turn-${++n}`;
    const userMessage = user(`user-${n}`, threadId);
    // The real server broadcasts start before answering the sender's RPC.
    chat(turnId, threadId, { type: "start", model, userMessage });
    return { turnId, userMessage };
  });
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined && store.getState().threads.length === IDS.length, 2000, "hydration");
  await tick();
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const socket of b.server.sockets) socket.close();
  await tick();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function answering(id: string): Promise<string> {
  session.openThread(id);
  await session.send(`Question in ${id}`);
  await until(() => openTurn()?.threadId === id && openTurn()?.turnId !== null, 2000, `reply in ${id}`);
  await tick();
  return openTurn()?.turnId ?? "";
}

/** Deliver the server's start while its send response is still in flight. */
async function awaitingAcknowledgment(outcome: "accepted" | "turn-active" = "accepted"): Promise<() => Promise<void>> {
  session.openThread("A");
  const held = b.server.hold("chat.send");
  const sending = session.send("Question awaiting its acknowledgment");
  const rpc = await held;
  const userMessage = user("admitting-user", "A");
  chat("admitting-A", "A", { type: "start", model: rpc.params.model, userMessage });
  return async () => {
    if (outcome === "accepted") rpc.respond({ turnId: "admitting-A", userMessage });
    else rpc.fail("turn-active");
    await sending;
    await tick();
  };
}

/** Read each real row's accessible running mark, independently of the store's representation. */
function marked(): string[] {
  const html = renderToStaticMarkup(createElement(Sidebar));
  return IDS.filter((id) => {
    const row = html.split(`data-thread="${id}"`)[1]?.split('data-thread="')[0];
    expect(row, `the sidebar contains chat ${id}`).toBeDefined();
    return row?.includes('aria-label="Reply in progress"') === true;
  });
}

describe("sidebar running replies", () => {
  it("hydrates a reply that started before this window connected", async () => {
    disconnect?.();
    b.server.answer("turns.active", () => [{ threadId: "A", turnId: "already-running" }]);
    store.setState({ imageStatus: undefined });
    disconnect = session.connect();
    await until(() => store.getState().imageStatus !== undefined, 2000, "second hydration");
    expect(marked()).toEqual(["A"]);
    chat("already-running", "A", { type: "done", message: reply("A"), stopReason: "stop" });
    expect(marked()).toEqual([]);
  });

  it("keeps the first row marked after opening another thread without sending", async () => {
    await answering("A");
    expect(marked()).toEqual(["A"]);
    session.openThread("B");
    await tick();
    expect(marked()).toEqual(["A"]);
  });

  it("keeps both rows marked when the second thread starts its own reply", async () => {
    await answering("A");
    await answering("B");
    expect(marked()).toEqual(["A", "B"]);
  });

  for (const terminal of ["done", "cancelled", "error"] as const) {
    it(`clears only the parked reply's mark on ${terminal}`, async () => {
      const a = await answering("A");
      await answering("B");
      expect(marked()).toEqual(["A", "B"]);
      chat(a, "A", terminal === "done" ? { type: "done", message: reply("A"), stopReason: "stop" } : { type: "error", code: terminal, message: terminal });
      await tick();
      expect(marked()).toEqual(["B"]);
    });

    it(`marks an off-screen reply started by another client and clears it on ${terminal}`, async () => {
      session.openThread("B");
      await tick();
      chat("remote-A", "A", { type: "start", model: MODEL, userMessage: user("remote-user", "A") });
      expect(marked()).toEqual(["A"]);
      chat("remote-A", "A", terminal === "done" ? { type: "done", message: reply("A"), stopReason: "stop" } : { type: "error", code: terminal, message: terminal });
      await tick();
      expect(marked()).toEqual([]);
    });
  }

  it("clears the mark immediately when the user stops the reply", async () => {
    await answering("A");
    expect(marked()).toEqual(["A"]);
    session.stop();
    expect(marked()).toEqual([]);
  });

  it("keeps a server-started reply marked while its send acknowledgment is pending in another chat", async () => {
    const acknowledge = await awaitingAcknowledgment();
    try {
      await answering("B");
      expect(marked()).toEqual(["A", "B"]);
    } finally {
      await acknowledge();
    }
  });

  it("Stop before acknowledgment clears the acknowledged turn and replay cannot restore it", async () => {
    const acknowledge = await awaitingAcknowledgment();
    try {
      session.stop();
      expect(marked(), "the server turn runs until its ID lets us cancel it").toEqual(["A"]);
    } finally {
      await acknowledge();
    }
    expect(marked()).toEqual([]);
  });

  it("Stop before acknowledgment cannot hide another client's reply when this send is refused", async () => {
    const acknowledge = await awaitingAcknowledgment("turn-active");
    try {
      session.stop();
      expect(marked()).toEqual(["A"]);
    } finally {
      await acknowledge();
    }
    expect(marked()).toEqual(["A"]);
    session.stop();
    expect(marked()).toEqual([]);
  });

  it("a reply ending before acknowledgment stays unmarked after replay and reopening its chat", async () => {
    const acknowledge = await awaitingAcknowledgment();
    session.openThread("B");
    const held = b.server.hold("chat.send");
    const sending = session.send("Another pending acknowledgment");
    const rpc = await held;
    const userMessage = user("second-admitting-user", "B");
    chat("admitting-B", "B", { type: "start", model: rpc.params.model, userMessage });
    let acknowledged = false;
    try {
      expect(marked()).toEqual(["A", "B"]);
      chat("admitting-A", "A", { type: "error", code: "cancelled", message: "cancelled" });
      expect(marked()).toEqual(["B"]);
      await acknowledge();
      acknowledged = true;
      expect(marked()).toEqual(["B"]);
      session.openThread("A");
      await tick();
      expect(marked()).toEqual(["B"]);
    } finally {
      if (!acknowledged) await acknowledge();
      rpc.respond({ turnId: "admitting-B", userMessage });
      await sending;
    }
  });

  it("keeps every sidebar selector's snapshot unchanged during foreground and parked token updates", async () => {
    const a = await answering("A");
    const other = await answering("B");
    capture = true;
    marked();
    capture = false;
    expect(selectors.length).toBeGreaterThan(0);
    const before = selectors.map((selector) => selector(store.getState()));
    let changed = 0;
    const off = store.subscribe(() => {
      if (selectors.some((selector, i) => !Object.is(selector(store.getState()), before[i]))) changed++;
    });
    try {
      for (let i = 0; i < 100; i++) {
        chat(a, "A", { type: "delta", text: "a" });
        chat(other, "B", { type: "delta", text: "b" });
        b.frame();
      }
    } finally {
      off();
    }
    expect(openTurn()?.text).toBe("b".repeat(100));
    expect(changed, "token publishes change no slice read by the sidebar").toBe(0);
  });

  it("a late terminal cannot clear a newer reply's mark in the same chat", async () => {
    session.openThread("B");
    await tick();
    chat("older-A", "A", { type: "start", model: MODEL, userMessage: user("older-user", "A") });
    chat("newer-A", "A", { type: "start", model: MODEL, userMessage: user("newer-user", "A") });
    expect(marked()).toEqual(["A"]);
    chat("older-A", "A", { type: "error", code: "cancelled", message: "cancelled" });
    expect(marked()).toEqual(["A"]);
    chat("newer-A", "A", { type: "done", message: reply("A"), stopReason: "stop" });
    expect(marked()).toEqual([]);
  });

  it("clears observed off-screen activity when the connection drops with no live turn", async () => {
    session.openThread("B");
    await tick();
    chat("remote-A", "A", { type: "start", model: MODEL, userMessage: user("remote-user", "A") });
    expect(marked()).toEqual(["A"]);
    expect(openTurn()).toBeNull();
    b.server.accepting = false;
    b.server.socket.close();
    await until(() => store.getState().conn.kind === "down", 2000, "disconnection");
    expect(marked()).toEqual([]);
  });
});
