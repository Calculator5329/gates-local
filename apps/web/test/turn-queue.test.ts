// Sending while something else is answering, against the in-memory server: the
// warning before a load stops another chat, the partial reply a stopped chat
// keeps, a turn left running behind another chat, and the queue of messages
// typed while a reply is being written.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockingTurn, FitReport, Message, Payload } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

type Session = typeof import("../src/session.ts");
type Store = typeof import("../src/store.ts");

let b: Browser;
let session: Session;
let store: Store;
let disconnect: (() => void) | undefined;

const st = () => store.getState();
const userMsg = (id: string, threadId: string, content = "hello"): Message => ({ id, threadId, role: "user", content, createdAt: 1 });
const asstMsg = (id: string, threadId: string, content = "hi there"): Message => ({ id, threadId, role: "assistant", content, model: "qwen3:14b", createdAt: 2 });
const chat = (turnId: string, threadId: string, event: Payload<"chat.event">["event"]) => b.server.push("chat.event", { turnId, threadId, event });
const BLOCKING: BlockingTurn[] = [{ threadId: "A", title: "First chat", model: "qwen3:14b" }];
// the model the sample list makes the pick
const MODEL = "gemma3:4b";
const sends = () => b.server.calls("chat.send").map((r) => r.params as { threadId: string; content: string; model: string; stopOthers?: boolean });

let created: string[];
let turnsOf: Record<string, number>;

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  created = ["A", "B", "C"];
  turnsOf = {};
  b.server.answer("threads.create", ({ title }) => ({ id: created.shift() ?? "Z", title: title ?? "", createdAt: 1, updatedAt: 1 }));
  b.server.answer("threads.get", ({ threadId }) => ({ thread: { id: threadId, title: threadId, createdAt: 1, updatedAt: 1 }, messages: [] }));
  b.server.answer("chat.send", ({ threadId, content }) => {
    const n = (turnsOf[threadId] = (turnsOf[threadId] ?? 0) + 1);
    return { turnId: `turn-${threadId}-${n}`, userMessage: userMsg(`u-${threadId}-${n}`, threadId, content) };
  });
  disconnect = session.connect();
  await until(() => st().imageStatus !== undefined && st().conn.kind === "open", 2000, "hydration");
  await tick();
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick();
  vi.unstubAllGlobals();
});

/** A new chat with this id, answering; the turn id is known when this returns. */
async function answering(id: string): Promise<string> {
  session.newThread();
  void session.send(`hello ${id}`);
  await until(() => st().live?.threadId === id && st().live?.turnId !== null && st().live?.pendingUser === null, 2000, `the turn in ${id}`);
  return st().live?.turnId ?? "";
}

const roles = () => (st().messages["A"] ?? []).map((m) => m.role);
const kept = () => (st().messages["A"] ?? []).find((m) => m.role === "assistant");

/** Chat A's reply got as far as `words` (none: nothing yet), and then ended on Stop. */
async function stopped(words: string): Promise<void> {
  const turn = await answering("A");
  if (words !== "") chat(turn, "A", { type: "delta", text: words });
  await tick();
  session.stop();
  chat(turn, "A", { type: "error", code: "cancelled", message: "stopped" });
  await tick();
}

const preempted = (partial?: Message): Payload<"chat.event">["event"] => ({
  type: "error",
  code: "preempted",
  message: "qwen3:14b at num_ctx 16384 needed the GPU memory other was using, so this reply stopped. Send the message again.",
  ...(partial ? { partial } : {}),
  neededBy: "qwen3:14b",
});

const report = (verdict: FitReport["verdict"]): FitReport => ({ ...methodSamples["fit.check"].result, verdict });

/** Chat A is answering and a new chat's send is waiting on the warning. */
async function warned(text = "for B"): Promise<void> {
  await answering("A");
  b.server.answer("turns.blocking", () => BLOCKING);
  session.newThread();
  store.setState({ draft: text });
  await session.send(text);
}

describe("a send that would stop another chat", () => {
  it("asks the server first and sends plainly when nothing is in the way", async () => {
    await answering("A");
    expect(b.server.calls("turns.blocking")).toHaveLength(1);
    expect(b.server.calls("turns.blocking")[0]?.params).toEqual({ model: MODEL, numCtx: st().numCtx });
    expect(sends()[0]).not.toHaveProperty("stopOthers");
    expect(st().stopAsk).toBeNull();
  });

  it("is sent even when the server cannot say what is in the way", async () => {
    b.server.answer("turns.blocking", () => {
      throw { code: "not-implemented", message: "no" };
    });
    await answering("A");
    expect(sends()).toHaveLength(1);
    expect(st().stopAsk).toBeNull();
  });

  it("waits for a yes, names what stops, and leaves the text in the box", async () => {
    await warned();
    expect(sends()).toHaveLength(1); // only chat A's own
    expect(st().stopAsk?.blocking).toEqual(BLOCKING);
    expect(st().draft).toBe("for B");
    expect(st().live?.threadId).toBe("A");
  });

  it("confirmed, sends with stopOthers and clears the box", async () => {
    await warned();
    session.confirmStopAsk(false);
    await until(() => sends().length === 2, 2000, "the second send");
    expect(sends()[1]).toMatchObject({ content: "for B", threadId: "B", stopOthers: true });
    expect(st().draft).toBe("");
    expect(st().stopAsk).toBeNull();
  });

  it("cancelled, sends nothing and keeps the text", async () => {
    await warned();
    session.cancelStopAsk();
    await tick();
    expect(sends()).toHaveLength(1);
    expect(st().stopAsk).toBeNull();
    expect(st().draft).toBe("for B");
  });

  it("confirming without the tick asks again next time", async () => {
    await warned();
    session.confirmStopAsk(false);
    await until(() => st().live?.threadId === "B" && st().live?.pendingUser === null, 2000, "turn B");
    session.newThread();
    await session.send("for C");
    expect(st().stopAsk?.blocking).toEqual(BLOCKING);
    expect(localStorage.getItem("gates-local.stop-others-ok")).toBeNull();
  });

  it("'Don't show this again' stops the other turn with no prompt from then on, and a cancel does not save it", async () => {
    await warned();
    session.cancelStopAsk();
    expect(localStorage.getItem("gates-local.stop-others-ok")).toBeNull();
    await session.send("for B");
    session.confirmStopAsk(true);
    await until(() => st().live?.threadId === "B" && st().live?.pendingUser === null, 2000, "turn B");
    expect(localStorage.getItem("gates-local.stop-others-ok")).toBe("1");
    session.newThread();
    await session.send("for C");
    await until(() => sends().length === 3, 2000, "the third send");
    expect(st().stopAsk).toBeNull();
    expect(sends()[2]).toMatchObject({ content: "for C", stopOthers: true });
  });

  it("Regenerate takes the same warning and keeps what is typed", async () => {
    const turn = await answering("A");
    chat(turn, "A", { type: "done", message: asstMsg("a1", "A"), stopReason: "stop" });
    await until(() => st().live === null, 2000, "A done");
    b.server.answer("turns.blocking", () => BLOCKING);
    store.setState({ draft: "half a thought" });
    session.retry();
    await until(() => st().stopAsk !== null, 2000, "the warning");
    expect(sends()).toHaveLength(1);
    session.confirmStopAsk(false);
    await until(() => sends().length === 2, 2000, "the resend");
    expect(sends()[1]).toMatchObject({ content: "hello A", threadId: "A", stopOthers: true });
    expect(st().draft).toBe("half a thought");
  });

  it("leaving the chat drops the warning", async () => {
    await warned();
    session.openThread("A");
    expect(st().stopAsk).toBeNull();
  });

  it("a second Enter while the server is being asked sends once", async () => {
    await answering("A");
    const held = b.server.hold("turns.blocking");
    session.newThread();
    void session.send("once");
    void session.send("once");
    const h = await held;
    h.respond([]);
    await until(() => sends().length === 2, 2000, "the send");
    await tick();
    expect(sends()).toHaveLength(2);
  });
});

describe("the chat that got stopped", () => {

  it("keeps its partial reply and one plain sentence while another chat is open", async () => {
    await warned();
    session.confirmStopAsk(false);
    await until(() => st().live?.threadId === "B" && st().live?.pendingUser === null, 2000, "turn B");
    chat("turn-A-1", "A", preempted(asstMsg("p1", "A", "so far")));
    await tick();
    expect(st().messages["A"]?.map((m) => m.id)).toContain("p1");
    expect(st().stopNotes["p1"]).toMatch(/^Stopped so .+ could load\.$/);
    expect(st().live?.threadId).toBe("B");
    expect(st().live?.end).toBeUndefined();
  });

  it("when it is the one on screen: the partial becomes the saved message, shown once", async () => {
    const turn = await answering("A");
    chat(turn, "A", { type: "delta", text: "so far" });
    b.frame();
    chat(turn, "A", preempted(asstMsg("p1", "A", "so far")));
    await tick();
    expect(st().live).toBeNull();
    expect(st().messages["A"]?.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["so far"]);
    expect(st().stopNotes["p1"]).toMatch(/^Stopped so .+ could load\.$/);
  });

  it("stopped before a word: the sentence is on the live turn", async () => {
    const turn = await answering("A");
    chat(turn, "A", preempted());
    await tick();
    expect(st().live?.end).toMatchObject({ kind: "error", code: "preempted" });
    expect(st().live?.end).toHaveProperty("message", expect.stringMatching(/^Stopped so .+ could load\.$/));
  });

  it("stopped before a word behind another chat: the sentence hangs on the question it did not answer", async () => {
    await warned();
    session.confirmStopAsk(false);
    await until(() => st().live?.threadId === "B" && st().live?.pendingUser === null, 2000, "turn B");
    chat("turn-A-1", "A", preempted());
    await tick();
    expect(st().stopNotes["u-A-1"]).toMatch(/^Stopped so .+ could load\.$/);
  });

  it("a runtime switch reads the same way", async () => {
    const turn = await answering("A");
    chat(turn, "A", { type: "delta", text: "so far" });
    chat(turn, "A", { type: "error", code: "runtime-changed", message: "The Ollama runtime changed while this reply was running, so it stopped. Send the message again.", partial: asstMsg("p2", "A", "so far") });
    await tick();
    expect(st().live).toBeNull();
    expect(st().stopNotes["p2"]).toBe("Stopped when the Ollama runtime changed.");
  });

  it("a turn this client never showed still leaves its partial in a thread it has", async () => {
    const turn = await answering("A");
    chat(turn, "A", { type: "done", message: asstMsg("a1", "A"), stopReason: "stop" });
    await until(() => st().live === null, 2000, "A done");
    session.newThread();
    chat("elsewhere", "A", preempted(asstMsg("p3", "A", "from the phone")));
    await tick();
    expect(st().messages["A"]?.map((m) => m.id)).toContain("p3");
    expect(st().stopNotes["p3"]).toMatch(/^Stopped so /);
  });
});

describe("a turn left running behind another chat", () => {
  it("keeps streaming and comes back with every word; the other chat's turn stays too", async () => {
    const a = await answering("A");
    chat(a, "A", { type: "delta", text: "one " });
    b.frame();
    const c = await answering("B");
    expect(sends()).toHaveLength(2);
    expect(b.server.calls("chat.cancel")).toHaveLength(0);
    chat(a, "A", { type: "delta", text: "two" });
    chat(c, "B", { type: "delta", text: "beta" });
    b.frame();
    session.openThread("A");
    expect(st().live).toMatchObject({ threadId: "A", turnId: a, text: "one two" });
    chat(c, "B", { type: "delta", text: " more" });
    session.openThread("B");
    expect(st().live).toMatchObject({ threadId: "B", turnId: c, text: "beta more" });
  });

  it("its reply lands when it finishes, and the queue moves only when nothing is running", async () => {
    const a = await answering("A");
    await session.send("after A");
    const c = await answering("B");
    expect(st().queued.map((q) => q.text)).toEqual(["after A"]);
    b.server.answer("threads.get", ({ threadId }) => ({
      thread: { id: threadId, title: threadId, createdAt: 1, updatedAt: 1 },
      messages: threadId === "A" ? [asstMsg("a1", "A", "A's reply")] : [],
    }));
    chat(a, "A", { type: "done", message: asstMsg("a1", "A", "A's reply"), stopReason: "stop" });
    await until(() => st().messages["A"]?.some((m) => m.id === "a1") === true, 2000, "A's reply");
    expect(sends().map((s) => s.content)).not.toContain("after A");
    chat(c, "B", { type: "done", message: asstMsg("b1", "B"), stopReason: "stop" });
    await until(() => sends().some((s) => s.content === "after A"), 2000, "the queued message");
  });

  it("Stop and the composer belong to the open chat only", async () => {
    await answering("A");
    expect(store.streamingHere(st())).toBe(true);
    session.newThread();
    expect(store.streaming(st())).toBe(true);
    expect(store.streamingHere(st())).toBe(false);
  });
});

describe("picking a model while another is answering", () => {
  it("loads now when nothing would have to stop", async () => {
    await answering("A");
    session.pickModel(MODEL);
    await until(() => b.server.calls("models.load").length === 1, 2000, "the load");
  });

  it("does not sit behind the answer: no load until the send", async () => {
    await answering("A");
    b.server.answer("turns.blocking", () => BLOCKING);
    session.pickModel(MODEL);
    await until(() => b.server.calls("turns.blocking").length === 2, 2000, "the question");
    await tick(5);
    expect(st().model).toBe(MODEL);
    expect(b.server.calls("models.load")).toHaveLength(0);
  });
});

describe("a model that fits only once the other chat stops", () => {
  it("is marked sendable when stopping the turn makes room", async () => {
    b.server.answer("fit.check", () => report("refuse"));
    b.server.answer("turns.blocking", () => BLOCKING);
    session.ensureFit(MODEL, 16384);
    await until(() => st().stopFrees[store.fitKey(MODEL, 16384)] === true, 2000, "the mark");
  });

  it("stays refused when nothing is in the way", async () => {
    b.server.answer("fit.check", () => report("refuse"));
    session.ensureFit(MODEL, 16384);
    await until(() => st().fits[store.fitKey(MODEL, 16384)] !== undefined, 2000, "the fit");
    await tick(5);
    expect(st().stopFrees[store.fitKey(MODEL, 16384)]).toBeUndefined();
  });
});

describe("messages typed while a reply is being written", () => {
  it("queue instead of stopping it, and send when it finishes", async () => {
    const turn = await answering("A");
    store.setState({ draft: "next" });
    await session.send("next");
    expect(st().queued).toMatchObject([{ threadId: "A", text: "next", waitFor: "reply", model: MODEL }]);
    expect(st().draft).toBe("");
    expect(sends()).toHaveLength(1);
    expect(b.server.calls("chat.cancel")).toHaveLength(0);
    expect(st().live?.turnId).toBe(turn);

    chat(turn, "A", { type: "done", message: asstMsg("a1", "A"), stopReason: "stop" });
    await until(() => sends().length === 2, 2000, "the queued send");
    expect(sends()[1]).toMatchObject({ threadId: "A", content: "next", model: MODEL });
    expect(st().queued).toEqual([]);
  });

  it("go out on the model they were typed for", async () => {
    const turn = await answering("A");
    await session.send("next");
    store.setState({ model: "something-else" });
    chat(turn, "A", { type: "done", message: asstMsg("a1", "A"), stopReason: "stop" });
    await until(() => sends().length === 2, 2000, "the queued send");
    expect(sends()[1]?.model).toBe(MODEL);
  });

  it("go one at a time, oldest first", async () => {
    const turn = await answering("A");
    await session.send("one");
    await session.send("two");
    chat(turn, "A", { type: "done", message: asstMsg("a1", "A"), stopReason: "stop" });
    await until(() => sends().length === 2, 2000, "the first");
    await until(() => st().live?.turnId === "turn-A-2" && st().live?.pendingUser === null, 2000, "turn 2");
    expect(sends().map((s) => s.content)).toEqual(["hello A", "one"]);
    expect(st().queued.map((q) => q.text)).toEqual(["two"]);
    chat("turn-A-2", "A", { type: "done", message: asstMsg("a2", "A"), stopReason: "stop" });
    await until(() => sends().length === 3, 2000, "the second");
    expect(sends()[2]?.content).toBe("two");
  });

  it("Stop holds the queue; Send now releases it", async () => {
    const turn = await answering("A");
    await session.send("next");
    session.stop();
    await tick();
    expect(b.server.calls("chat.cancel")).toHaveLength(1);
    chat(turn, "A", { type: "error", code: "cancelled", message: "stopped" });
    await tick();
    expect(sends()).toHaveLength(1);
    expect(st().queued).toMatchObject([{ text: "next", held: true }]);
    session.sendQueuedNow(st().queued[0]?.id ?? "");
    await until(() => sends().length === 2, 2000, "the release");
    expect(sends()[1]?.content).toBe("next");
    expect(st().queued).toEqual([]);
  });

  it("a held message does not leave when another chat finishes", async () => {
    const turn = await answering("A");
    await session.send("next");
    session.stop();
    chat(turn, "A", { type: "error", code: "cancelled", message: "stopped" });
    await tick();
    const other = await answering("B");
    chat(other, "B", { type: "done", message: asstMsg("b1", "B"), stopReason: "stop" });
    await until(() => st().live === null, 2000, "B done");
    await tick();
    expect(sends().map((s) => s.content)).not.toContain("next");
  });

  it("Send now interrupts: the reply stops, and this one goes once it has ended", async () => {
    const turn = await answering("A");
    await session.send("first");
    await session.send("urgent");
    session.sendQueuedNow(st().queued[1]?.id ?? "");
    await tick();
    expect(b.server.calls("chat.cancel")).toHaveLength(1);
    expect(sends()).toHaveLength(1); // the server refuses a second turn until this one ends
    chat(turn, "A", { type: "error", code: "cancelled", message: "stopped" });
    await until(() => sends().length === 2, 2000, "the interrupt");
    expect(sends()[1]?.content).toBe("urgent");
    expect(st().queued.map((q) => q.text)).toEqual(["first"]);
    expect(st().queued[0]?.held).toBe(true);
  });

  describe("a reply the person stopped", () => {
    it("Send now keeps the interrupted words above the new message, with one sentence", async () => {
      const turn = await answering("A");
      chat(turn, "A", { type: "delta", text: "words so far" });
      await tick();
      await session.send("urgent");
      session.sendQueuedNow(st().queued[0]?.id ?? "");
      chat(turn, "A", { type: "error", code: "cancelled", message: "stopped" });
      await until(() => sends().length === 2, 2000, "the interrupt");
      await tick();
      expect(roles()).toEqual(["user", "assistant", "user"]);
      expect(kept()?.content).toBe("words so far");
      expect(st().stopNotes[kept()?.id ?? ""]).toMatch(/^Stopped after \d+ s\.$/);
    });

    it("a later send keeps it too", async () => {
      await stopped("words so far");
      await session.send("next try");
      await until(() => sends().length === 2, 2000, "the send");
      await tick();
      expect(roles()).toEqual(["user", "assistant", "user"]);
      expect(kept()?.content).toBe("words so far");
    });

    it("Retry replaces it: that is what Retry asked for", async () => {
      await stopped("words so far");
      session.retry();
      await until(() => sends().length === 2, 2000, "the retry");
      await tick();
      expect(kept()).toBeUndefined();
    });

    it("with no words yet leaves nothing behind", async () => {
      await stopped("");
      await session.send("next try");
      await until(() => sends().length === 2, 2000, "the send");
      await tick();
      expect(kept()).toBeUndefined();
    });
  });

  it("a queued message that fails to send goes back in the queue, the box untouched", async () => {
    const turn = await answering("A");
    await session.send("next");
    b.server.answer("chat.send", () => {
      throw { code: "internal", message: "no" };
    });
    store.setState({ draft: "still typing" });
    chat(turn, "A", { type: "done", message: asstMsg("a1", "A"), stopReason: "stop" });
    await until(() => st().notice !== null, 2000, "the notice");
    expect(st().queued.map((q) => q.text)).toEqual(["next"]);
    expect(st().draft).toBe("still typing");
  });

  it("Remove drops it", async () => {
    await answering("A");
    await session.send("next");
    session.removeQueued(st().queued[0]?.id ?? "");
    expect(st().queued).toEqual([]);
    expect(st().draft).toBe("");
  });

  it("Edit works in the composer, keeps its place, and the next Send updates it", async () => {
    await answering("A");
    await session.send("one");
    await session.send("two");
    const id = st().queued[0]?.id ?? "";
    session.editQueued(id);
    expect(st().draft).toBe("one");
    expect(st().editingQueued).toBe(id);
    await session.send("one, better");
    expect(st().queued.map((q) => q.text)).toEqual(["one, better", "two"]);
    expect(st().editingQueued).toBeNull();
    expect(st().draft).toBe("");
    expect(sends()).toHaveLength(1);
  });

  it("the message being edited stays while the next one goes", async () => {
    const turn = await answering("A");
    await session.send("one");
    await session.send("two");
    session.editQueued(st().queued[0]?.id ?? "");
    chat(turn, "A", { type: "done", message: asstMsg("a1", "A"), stopReason: "stop" });
    await until(() => sends().length === 2, 2000, "the next");
    expect(sends()[1]?.content).toBe("two");
    expect(st().queued.map((q) => q.text)).toEqual(["one"]);
  });

  it("Cancel editing puts the box back", async () => {
    await answering("A");
    await session.send("one");
    session.editQueued(st().queued[0]?.id ?? "");
    session.cancelQueuedEdit();
    expect(st().editingQueued).toBeNull();
    expect(st().draft).toBe("");
    expect(st().queued.map((q) => q.text)).toEqual(["one"]);
  });
});
