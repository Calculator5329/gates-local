// Sending while something else is answering, against the in-memory server: the
// warning before a load stops another chat, the partial reply a stopped chat
// keeps, a turn left running behind another chat, and the queue of messages
// typed while a reply is being written.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockingTurn, Message, Payload } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, type Held, installBrowser, tick, until } from "./harness.ts";
import { replay } from "./ordering-replay.ts";
import { gpuReadFailure } from "../../server/src/fit/gpu.ts";
import { draftView } from "./draft-view.ts";

type Session = typeof import("../src/session.ts");
type Store = typeof import("../src/store.ts");

let b: Browser;
let session: Session;
let store: Store;
let draftSource: typeof import("../src/drafts.ts");
let disconnect: (() => void) | undefined;

const st = () => draftView(store, draftSource);
const type = (text: string) => draftSource.replaceDraft(store.getState().threadId, { text });
/** The open chat's turn (what the old single live slot showed), or null. */
const live = () => { const s = st(); return s.threadId === null ? null : s.turns[s.threadId] ?? null; };
const userMsg = (id: string, threadId: string, content = "hello"): Message => ({ id, threadId, role: "user", content, createdAt: 1 });
const asstMsg = (id: string, threadId: string, content = "hi there"): Message => ({ id, threadId, role: "assistant", content, model: "qwen3:14b", createdAt: 2 });
const chat = (turnId: string, threadId: string, event: Payload<"chat.event">["event"]) => b.server.push("chat.event", { turnId, threadId, event });
const BLOCKING: BlockingTurn[] = [{ threadId: "A", title: "First chat", model: "qwen3:14b", turnId: "turn-A-1" }];
// the model the sample list makes the pick
const MODEL = "gemma3:4b";
const sends = () => b.server.calls("chat.send").map((r) => r.params as { threadId: string; content: string; model: string; stopOthers?: boolean });

it("CO-06 replay: a refused GPU send shows the server explanation and restores its words", async () => {
  const sentence = gpuReadFailure("nvidia-smi timed out");
  await replay({
    name: "GPU read refusal returns the message to the composer",
    create: async () => {
      type("keep these words");
      const waiting = b.server.hold("chat.send");
      const sent = session.send(st().draft);
      return { request: await waiting, sent };
    },
    events: [{ name: "send.refused", run: async w => {
      w.request.fail("gpu-unreadable", sentence);
      await w.sent;
    } }],
    check(_w, _order, complete) {
      if (!complete) return;
      expect(st()).toMatchObject({ draft: "keep these words", queued: [], notice: `${sentence} Your message is back in the box.` });
      expect(st().turns, "the refused send leaves no turn behind").toEqual({});
    },
    dispose: async () => {},
  });
});

it.each(["Settings", "another thread"])("round 4: a timeout retry keeps its identity after visiting %s and returning", async destination => {
  const realTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => realTimeout(fn, ms === 30_000 ? 15 : ms, ...args));
  const { settingsScreen } = await import("../src/screen-loaders.ts");
  const load = vi.spyOn(settingsScreen, "load").mockResolvedValue();
  try {
    type("same recovered words");
    const waiting = b.server.hold("chat.send");
    const sent = session.send(st().draft);
    const request = await waiting;
    const original = request.params.messageId;
    await sent;
    expect(st().draft).toBe("same recovered words");
    if (destination === "Settings") {
      session.openSettings();
      await until(() => st().view === "settings", 2000, "Settings navigation");
      session.leaveSettings();
    } else {
      session.openThread("B");
      session.openThread("A");
    }
    expect(st()).toMatchObject({ view: "thread", threadId: "A", draft: "same recovered words" });
    await session.send(st().draft);
    expect(b.server.calls("chat.send").at(-1)?.params).toHaveProperty("messageId", original);
  } finally { load.mockRestore(); timer.mockRestore(); }
});

it("round 4: sending the recovered words in B never uses A's identity", async () => {
  const drafts = await import("../src/drafts.ts");
  drafts.editDraft("recovered words");
  const waiting = b.server.hold("chat.send");
  const sent = session.send(drafts.getDraft().text);
  const original = await waiting;
  original.fail("timeout", "not confirmed");
  await sent;
  session.openThread("B");
  expect(drafts.getDraft("A").text).toBe("recovered words");
  expect(drafts.getDraft("B").text).toBe("");
  drafts.editDraft("recovered words");
  const checking = b.server.hold("turns.blocking");
  const sendInB = session.send(drafts.getDraft().text);
  const check = await checking;
  chat("late-A", "A", { type: "start", model: MODEL, userMessage: userMsg(original.params.messageId!, "A", "recovered words") });
  expect(drafts.getDraft("B").text).toBe("recovered words");
  check.respond([]);
  await sendInB;
  const retry = b.server.calls("chat.send").at(-1)?.params as { threadId: string; messageId: string };
  expect(retry.threadId).toBe("B");
  expect(retry.messageId).not.toBe(original.params.messageId);
});

it("round 4: a late confirmation retires the unchanged copy after A to B to A", async () => {
  type("recovered words");
  const waiting = b.server.hold("chat.send");
  const sent = session.send(st().draft);
  const original = await waiting;
  original.fail("timeout", "not confirmed");
  await sent;
  session.openThread("B");
  session.openThread("A");
  chat("late-A", "A", { type: "start", model: MODEL, userMessage: userMsg(original.params.messageId!, "A", "recovered words") });
  expect(st().draft).toBe("");
  expect(st().draftSendId).toBeNull();
});

it("round 4: editing recovered words after navigation creates a new identity", async () => {
  type("recovered words");
  const waiting = b.server.hold("chat.send");
  const sent = session.send(st().draft);
  const original = await waiting;
  original.fail("timeout", "not confirmed");
  await sent;
  session.openThread("B");
  session.openThread("A");
  draftSource.editDraft("edited words");
  await session.send(st().draft);
  expect(b.server.calls("chat.send").at(-1)?.params).not.toHaveProperty("messageId", original.params.messageId);
});

it("PC-04: second Enter during thread creation sends the visible draft once", async () => {
  type("one draft");
  const creating = b.server.hold("threads.create");
  const first = session.send(st().draft);
  const request = await creating;
  const second = session.send(st().draft);
  request.respond({ id: "A", title: "one draft", createdAt: 1, updatedAt: 1 });
  await Promise.all([first, second]);
  expect(b.server.calls("threads.create")).toHaveLength(1);
  expect(sends()).toHaveLength(1);
});

it("PC-04: failed thread creation keeps newer draft attachments", async () => {
  type("earlier words"); store.setState({ runtime: { ...methodSamples["runtime.status"].result, state: "installing" } });
  const creating = b.server.hold("threads.create");
  const sent = session.send(st().draft);
  const request = await creating;
  const images = ["data:image/png;base64,newer"];
  draftSource.replaceDraft(st().threadId, { text: "newer words", images });
  request.fail("closed", "creation not confirmed");
  await sent;
  expect(st()).toMatchObject({ draft: "newer words", draftImages: images });
});

it("PC-03: reconnect retry keeps the identity of the unacknowledged send", async () => {
  type("saved before socket loss");
  const waiting = b.server.hold("chat.send");
  const sent = session.send(st().draft);
  const request = await waiting;
  const id = (request.params as { messageId?: string }).messageId;
  expect(id).toEqual(expect.any(String));
  b.server.answer("threads.get", ({ threadId }) => ({ thread: { id: threadId, title: "A", createdAt: 1, updatedAt: 1 }, messages: [userMsg(id!, threadId, "saved before socket loss")] }));
  b.server.socket.close();
  await sent;
  await until(() => st().conn.kind === "open", 2000, "reconnected");
  await session.send(st().draft);
  expect(b.server.calls("chat.send").at(-1)?.params).toHaveProperty("messageId", id);
});

it("PC-02: late success cannot erase words being edited from a recovered queue row", async () => {
  const realTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => realTimeout(fn, ms === 30_000 ? 15 : ms, ...args));
  try {
    type("original words");
    const waiting = b.server.hold("chat.send");
    const sent = session.send(st().draft);
    const request = await waiting;
    type("newer draft");
    await until(() => st().queued.length === 1, 2000, "recovered queue");
    const q = st().queued[0]!;
    session.editQueued(q.id);
    draftSource.editDraft("edited recovery words");
    const id = (request.params as { messageId?: string }).messageId ?? "u-A-1";
    chat("turn-A-1", "A", { type: "start", model: MODEL, userMessage: userMsg(id, "A", "original words") });
    request.respond({ turnId: "turn-A-1", userMessage: userMsg(id, "A", "original words") });
    await sent;
    await tick();
    expect(st().editingQueued).toBeNull();
    expect(st().draft).toBe("edited recovery words");
    await session.send(st().draft);
    expect(st().draft === "edited recovery words" || st().queued.some(item => item.text === "edited recovery words") || sends().some(item => item.content === "edited recovery words")).toBe(true);
    const last = b.server.calls("chat.send").at(-1);
    const edited = st().queued.find(item => item.text === "edited recovery words")?.messageId ?? (last ? (last.params as { messageId?: string }).messageId : undefined);
    expect(edited).toEqual(expect.any(String));
    expect(edited).not.toBe(id);
  } finally { timer.mockRestore(); }
});

it("PC-06: a stalled open-socket admission releases Send for a safe retry", async () => {
  const realTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => realTimeout(fn, ms === 30_000 ? 15 : ms, ...args));
  try {
    type("stalled send");
    const waiting = b.server.hold("chat.send");
    void session.send(st().draft);
    await waiting;
    await until(() => st().draft === "stalled send", 2000, "restored timeout");
    await session.send(st().draft);
    expect(sends()).toHaveLength(2);
  } finally { timer.mockRestore(); }
});

it.each(["timeout", "closed", "image-input"])("returns an unconfirmed %s send to view with its images", async code => {
  const images = ["data:image/png;base64,cGl4ZWw="];
  draftSource.replaceDraft(st().threadId, { text: "keep my words", images });
  const waiting = b.server.hold("chat.send");
  const sent = session.send("keep my words");
  (await waiting).fail(code, "Not confirmed");
  await sent;
  expect(st()).toMatchObject({ draft: "keep my words", draftImages: images });
});

it("keeps newer typing and puts an unconfirmed timeout in a visible held queue", async () => {
  const images = ["data:image/png;base64,cGl4ZWw="];
  draftSource.replaceDraft(st().threadId, { text: "earlier words", images });
  const waiting = b.server.hold("chat.send");
  const sent = session.send("earlier words");
  const request = await waiting;
  type("newer words");
  request.fail("timeout", "Not confirmed");
  await sent;
  expect(st().draft).toBe("newer words");
  expect(st().queued).toContainEqual(expect.objectContaining({ text: "earlier words", images, held: true }));
});

it.each([false, true])("late confirmation retires only the matching recovered copy (new draft: %s)", async newer => {
  const realTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => realTimeout(fn, ms === 30_000 ? 15 : ms, ...args));
  try {
    const images = ["data:image/png;base64,cGl4ZWw="];
    draftSource.replaceDraft(st().threadId, { text: "slow admission", images });
    const waiting = b.server.hold("chat.send");
    const sent = session.send("slow admission");
    const request = await waiting;
    const id = request.params.messageId!;
    if (newer) type("newer words");
    await sent;
    expect(newer ? st().queued[0]?.text : st().draft).toBe("slow admission");
    chat("turn-A-1", "A", { type: "start", model: MODEL, userMessage: userMsg(id, "A", "slow admission") });
    await tick();
    expect(st().draft).toBe(newer ? "newer words" : "");
    expect(st().queued).toEqual([]);
    expect(st().messages["A"]?.filter(m => m.content === "slow admission")).toHaveLength(1);
    expect(sends()).toHaveLength(1);
    expect(b.server.calls("chat.cancel")).toHaveLength(0);
    expect(live()?.turnId).toBe("turn-A-1");
  } finally { timer.mockRestore(); }
});

let created: string[];
let turnsOf: Record<string, number>;

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  draftSource = await import("../src/drafts.ts");
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

it("snapshots attached images into a queued send and restores them for editing", async () => {
  await answering("A");
  draftSource.replaceDraft(st().threadId, { images: ["data:image/png;base64,cGl4ZWw="] });
  await session.send("queued image");
  const q = st().queued[0]!;
  expect(q).toMatchObject({ images: ["data:image/png;base64,cGl4ZWw="] });
  expect(st().draftImages).toEqual([]);
  session.editQueued(q.id);
  expect(st().draftImages).toEqual(["data:image/png;base64,cGl4ZWw="]);
  await session.send("edited image");
  chat("turn-A-1", "A", { type: "done", message: asstMsg("a-A-1", "A"), stopReason: "stop" });
  await until(() => b.server.calls("chat.send").length === 2, 2000, "queued image send");
  expect(b.server.calls("chat.send")[1]?.params).toMatchObject({ images: ["data:image/png;base64,cGl4ZWw="] });
});

it("sends an image-only first message with a usable thread title", async () => {
  session.newThread();
  draftSource.replaceDraft(st().threadId, { images: ["data:image/png;base64,cGl4ZWw="] });
  await session.send("");
  expect(b.server.calls("threads.create").at(-1)?.params).toEqual({ title: "Attached images" });
  expect(b.server.calls("chat.send").at(-1)?.params).toMatchObject({ content: "", images: ["data:image/png;base64,cGl4ZWw="] });
});

/** A new chat with this id, answering; the turn id is known when this returns. */
async function answering(id: string): Promise<string> {
  session.newThread();
  void session.send(`hello ${id}`);
  await until(() => live()?.threadId === id && live()?.turnId !== null && live()?.pendingUser === null, 2000, `the turn in ${id}`);
  return live()?.turnId ?? "";
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

it("keeps a terminal omission notice beside an off-screen partial reply", async () => {
  const turn = await answering("A");
  chat(turn, "A", { type: "delta", text: "Partial answer" });
  await tick();
  await answering("B");
  chat(turn, "A", { type: "error", code: "cancelled", message: "stopped", contextNotice: "Some earlier images are unavailable." });
  expect((st().messages["A"] ?? []).at(-1)).toMatchObject({ content: "Partial answer", contextNotice: "Some earlier images are unavailable." });
});

it.each([false, true])("keeps omission notices beside stopped words (notice before stop: %s)", async earlyNotice => {
  const turn = await answering("A");
  if (earlyNotice) {
    chat(turn, "A", { type: "delta", text: "", contextNotice: "Some earlier images are unavailable." });
    await tick();
    expect(live()?.firstTokenAt).toBeUndefined();
  }
  chat(turn, "A", { type: "delta", text: "Partial answer" });
  await tick();
  session.stop();
  if (!earlyNotice) chat(turn, "A", { type: "error", code: "cancelled", message: "stopped", contextNotice: "Some earlier images are unavailable." });
  await tick();
  expect(live()).toHaveProperty("contextNotice", "Some earlier images are unavailable.");
  await answering("B");
  // the terminal of the earlier-notice case comes after the person moved on, with the saved row
  if (earlyNotice) chat(turn, "A", { type: "error", code: "cancelled", message: "stopped", partial: { ...asstMsg("p-notice", "A", "Partial answer"), contextNotice: "Some earlier images are unavailable.", interrupted: true } });
  expect((st().messages["A"] ?? []).at(-1)).toMatchObject({ content: "Partial answer", contextNotice: "Some earlier images are unavailable." });
});

/** Chat A is answering and a new chat's send is waiting on the warning. */
async function warned(text = "for B"): Promise<void> {
  await answering("A");
  b.server.answer("turns.blocking", () => BLOCKING);
  session.newThread();
  type(text);
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
    expect(store.runningThreads(st()).has("A")).toBe(true);
  });

  it("confirmed, sends with stopOthers and clears the box", async () => {
    await warned();
    const source = draftSource.currentDraftKey();
    session.confirmStopAsk(false);
    await until(() => sends().length === 2, 2000, "the second send");
    expect(sends()[1]).toMatchObject({ content: "for B", threadId: "B", stopOthers: true });
    expect(draftSource.getDraft(source).text).toBe("");
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
    await until(() => live()?.threadId === "B" && live()?.pendingUser === null, 2000, "turn B");
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
    await until(() => live()?.threadId === "B" && live()?.pendingUser === null, 2000, "turn B");
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
    await until(() => live() === null, 2000, "A done");
    b.server.answer("turns.blocking", () => BLOCKING);
    type("half a thought");
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

const ask = async (reply: Payload<"chat.event">["event"]) => {
  const turn = await answering("A");
  chat(turn, "A", { type: "delta", text: "so far" });
  b.frame();
  if (reply.type === "error") session.stop();
  chat(turn, "A", reply);
  await tick();
  return st().messages["A"]?.find((m) => m.role === "user")?.id ?? "";
};
const saved = (id: string, content = "so far") => ({ ...asstMsg(id, "A", content), interrupted: true as const });
const cancelledWith = (partial: Message): Payload<"chat.event">["event"] => ({ type: "error", code: "cancelled", message: "stopped", partial });
const replies = () => (st().messages["A"] ?? []).filter((m) => m.role === "assistant").map((m) => m.content);

describe("the chat that got stopped", () => {

  it("keeps its partial reply and one plain sentence while another chat is open", async () => {
    await warned();
    session.confirmStopAsk(false);
    await until(() => live()?.threadId === "B" && live()?.pendingUser === null, 2000, "turn B");
    chat("turn-A-1", "A", preempted(asstMsg("p1", "A", "so far")));
    await tick();
    expect(st().messages["A"]?.map((m) => m.id)).toContain("p1");
    expect(st().stopNotes["p1"]).toEqual({ kind: "said", words: expect.stringMatching(/^Stopped so .+ could load\.$/) });
    expect(live()?.threadId).toBe("B");
    expect(live()?.end).toBeUndefined();
  });

  it("when it is the one on screen: the partial becomes the saved message, shown once", async () => {
    const turn = await answering("A");
    chat(turn, "A", { type: "delta", text: "so far" });
    b.frame();
    chat(turn, "A", preempted(asstMsg("p1", "A", "so far")));
    await tick();
    expect(live()).toBeNull();
    expect(st().messages["A"]?.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["so far"]);
    expect(st().stopNotes["p1"]).toEqual({ kind: "said", words: expect.stringMatching(/^Stopped so .+ could load\.$/) });
  });

  describe("Retry", () => {
    const unfinished: Payload<"chat.event">["event"] = { type: "error", code: "cancelled", message: "stopped", partial: { ...asstMsg("p8", "A", "so far"), interrupted: true } };

    it("of an unfinished reply names the question, and the old rows go once the server answers", async () => {
      const question = await ask(unfinished);
      const held = b.server.hold("chat.send");
      session.retry();
      const h = await held;
      expect(h.params).toMatchObject({ retryOf: question, content: "hello A" });
      expect((st().messages["A"] ?? []).map((m) => m.id)).toEqual([question, "p8"]);
      h.respond({ turnId: "turn-retry", userMessage: userMsg("u-again", "A", "hello A") });
      await until(() => live()?.turnId === "turn-retry", 2000, "the retry");
      expect((st().messages["A"] ?? []).map((m) => m.id)).toEqual(["u-again"]);
    });

    it("of a finished reply is a new question and names nothing", async () => {
      await ask({ type: "done", message: asstMsg("whole", "A"), stopReason: "stop" });
      const held = b.server.hold("chat.send");
      session.retry();
      const h = await held;
      expect(h.params).not.toHaveProperty("retryOf");
    });

    it("that the server refuses leaves the unfinished words where they were", async () => {
      const question = await ask(unfinished);
      const held = b.server.hold("chat.send");
      session.retry();
      (await held).fail("wont-fit", "no");
      await tick();
      expect((st().messages["A"] ?? []).map((m) => m.id)).toEqual([question, "p8"]);
    });
  });

  describe("a reply the person stopped, saved by the server", () => {
    it("takes the live row's place, shown once with one note, and the queue waits for Send now", async () => {
      const turn = await answering("A");
      await session.send("next");
      chat(turn, "A", { type: "delta", text: "so far" });
      b.frame();
      session.stop();
      chat(turn, "A", cancelledWith(saved("p4")));
      await tick();
      expect(live()).toBeNull();
      expect(replies()).toEqual(["so far"]);
      expect(st().stopNotes["p4"]).toEqual({ kind: "stopped", secs: expect.any(Number) });
      expect(st().queued).toMatchObject([{ text: "next", held: true }]);
      expect(sends()).toHaveLength(1);
    });

    it("still only once when the person has moved on before the server's answer", async () => {
      const turn = await answering("A");
      chat(turn, "A", { type: "delta", text: "so far" });
      b.frame();
      session.stop();
      await answering("B");
      chat(turn, "A", cancelledWith(saved("p5")));
      await tick();
      expect(replies()).toEqual(["so far"]);
      expect(live()?.threadId).toBe("B");
    });

    it("a Stop that lost the race to the last token leaves the finished reply and still holds the queue", async () => {
      const turn = await answering("A");
      await session.send("next");
      chat(turn, "A", { type: "delta", text: "all of it" });
      b.frame();
      session.stop();
      chat(turn, "A", done("whole", "A"));
      await tick();
      expect(live()).toBeNull();
      expect(st().stopNotes["whole"]).toBeUndefined();
      expect(st().queued).toMatchObject([{ text: "next", held: true }]);
      expect(sends()).toHaveLength(1);
    });

    it("a reply that broke mid-way says so once, leaving the kept-words sentence to the row", async () => {
      const turn = await answering("A");
      chat(turn, "A", { type: "delta", text: "so far" });
      b.frame();
      chat(turn, "A", { type: "error", code: "runtime-error", message: "the model crashed", partial: saved("p6") });
      await tick();
      expect(live()).toBeNull();
      expect(replies()).toEqual(["so far"]);
      expect(st().stopNotes["p6"]).toEqual({ kind: "said", words: "The reply didn't finish. The model crashed." });
    });

    it("a reply this window left running, stopped from elsewhere, still says it was stopped", async () => {
      const turn = await answering("A");
      chat(turn, "A", { type: "delta", text: "so far" });
      b.frame();
      await answering("B");
      chat(turn, "A", cancelledWith(saved("p7")));
      await tick();
      expect(replies()).toEqual(["so far"]);
      expect(st().stopNotes["p7"]).toEqual({ kind: "stopped", secs: expect.any(Number) });
    });
  });

  it("stopped before a word: the sentence is on the live turn", async () => {
    const turn = await answering("A");
    chat(turn, "A", preempted());
    await tick();
    expect(live()?.end).toMatchObject({ kind: "error", code: "preempted" });
    expect(live()?.end).toHaveProperty("message", expect.stringMatching(/^Stopped so .+ could load\.$/));
  });

  it("stopped before a word behind another chat: the sentence hangs on the question it did not answer", async () => {
    await warned();
    session.confirmStopAsk(false);
    await until(() => live()?.threadId === "B" && live()?.pendingUser === null, 2000, "turn B");
    chat("turn-A-1", "A", preempted());
    await tick();
    expect(st().stopNotes["u-A-1"]).toEqual({ kind: "said", words: expect.stringMatching(/^Stopped so .+ could load\.$/) });
  });

  it("a runtime switch reads the same way", async () => {
    const turn = await answering("A");
    chat(turn, "A", { type: "delta", text: "so far" });
    chat(turn, "A", { type: "error", code: "runtime-changed", message: "The Ollama runtime changed while this reply was running, so it stopped. Send the message again.", partial: asstMsg("p2", "A", "so far") });
    await tick();
    expect(live()).toBeNull();
    expect(st().stopNotes["p2"]).toEqual({ kind: "said", words: "Stopped when the Ollama runtime changed." });
  });

  it("a turn this client never showed still leaves its partial in a thread it has", async () => {
    const turn = await answering("A");
    chat(turn, "A", { type: "done", message: asstMsg("a1", "A"), stopReason: "stop" });
    await until(() => live() === null, 2000, "A done");
    session.newThread();
    chat("elsewhere", "A", preempted(asstMsg("p3", "A", "from the phone")));
    await tick();
    expect(st().messages["A"]?.map((m) => m.id)).toContain("p3");
    expect(st().stopNotes["p3"]).toEqual({ kind: "said", words: expect.stringMatching(/^Stopped so /) });
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
    expect(live()).toMatchObject({ threadId: "A", turnId: a, text: "one two" });
    chat(c, "B", { type: "delta", text: " more" });
    session.openThread("B");
    expect(live()).toMatchObject({ threadId: "B", turnId: c, text: "beta more" });
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
    expect(store.runningThreads(st()).has("A")).toBe(true);
    expect(store.streamingHere(st())).toBe(false);
  });
});

describe("picking a model while another is answering", () => {
  it.each([false, true])("a replayed parked acknowledgement frees its slot and the automatic queue (finished before acknowledgement: %s)", async finishedFirst => {
    const waiting = b.server.hold("chat.send");
    const sending = session.send("recovered A");
    const request = await waiting;
    const second = await answering("B");
    await session.send("after B");
    const userMessage = userMsg(request.params.messageId!, "A", "recovered A");
    chat("original-A", "A", { type: "start", model: MODEL, userMessage });
    chat("original-A", "A", { type: "delta", text: "original reply" });
    const finish = () => chat("original-A", "A", { type: "done", message: asstMsg("answer-A", "A", "original reply"), stopReason: "stop" });
    if (finishedFirst) finish();
    request.respond({ turnId: `saved-${userMessage.id}`, userMessage, replayed: true });
    await sending;
    if (!finishedFirst) {
      expect(store.runningThreads(st()).has("A")).toBe(true);
      finish();
    }
    expect.soft(store.runningThreads(st()).has("A")).toBe(false);
    chat(second, "B", { type: "done", message: asstMsg("answer-B", "B"), stopReason: "stop" });
    await until(() => sends().some(send => send.content === "after B"), 1000, "queued words after replayed acknowledgement");
    expect(sends().map(send => send.content)).toEqual(["recovered A", "hello B", "after B"]);
  });

  it("Send now interrupts only its thread and sends without waiting for a parked reply", async () => {
    const a = await answering("A");
    const images = ["data:image/png;base64,cGl4ZWw="];
    draftSource.replaceDraft(st().threadId, { images });
    await session.send("send now");
    const id = st().queued[0]?.id;
    const messageId = st().queued[0]?.messageId;
    expect(id).toBeDefined();
    await answering("B");
    session.openThread("A");
    session.sendQueuedNow(id ?? "");
    chat(a, "A", { type: "error", code: "cancelled", message: "stopped" });
    await until(() => sends().length === 3, 1000, "the explicit Send now");
    expect(sends()[2]).toMatchObject({ threadId: "A", content: "send now" });
    expect(b.server.calls("chat.send")[2]?.params).toMatchObject({ images, messageId });
    expect(b.server.calls("chat.cancel").map((r) => r.params)).toEqual([{ turnId: a }]);
  });

  it("loads another model now when nothing would have to stop", async () => {
    await answering("A");
    session.pickModel("qwen3:14b");
    await until(() => b.server.calls("models.load").length === 1, 2000, "the load");
  });

  it("does not sit behind the answer: no load until the send", async () => {
    await answering("A");
    b.server.answer("turns.blocking", () => BLOCKING);
    session.pickModel("qwen3:14b");
    await until(() => b.server.calls("turns.blocking").length === 2, 2000, "the question");
    await tick(5);
    expect(st().model).toBe("qwen3:14b");
    expect(b.server.calls("models.load")).toHaveLength(0);
  });
});

describe("messages typed while a reply is being written", () => {
  it("queue instead of stopping it, and send when it finishes", async () => {
    const turn = await answering("A");
    type("next");
    await session.send("next");
    expect(st().queued).toMatchObject([{ threadId: "A", text: "next", waitFor: "reply", model: MODEL }]);
    expect(st().draft).toBe("");
    expect(sends()).toHaveLength(1);
    expect(b.server.calls("chat.cancel")).toHaveLength(0);
    expect(live()?.turnId).toBe(turn);

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
    await until(() => live()?.turnId === "turn-A-2" && live()?.pendingUser === null, 2000, "turn 2");
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
    await until(() => live() === null, 2000, "B done");
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
      expect(st().stopNotes[kept()?.id ?? ""]).toEqual({ kind: "stopped", secs: expect.any(Number) });
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
    type("still typing");
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

const CANCELLED: Payload<"chat.event">["event"] = { type: "error", code: "cancelled", message: "stopped" };
const done = (id: string, threadId: string): Payload<"chat.event">["event"] => ({ type: "done", message: asstMsg(id, threadId), stopReason: "stop" });
const texts = () => st().queued.map((q) => q.text);

/** Chat A's reply was stopped with these messages waiting, all on hold; their ids in order. */
async function onHold(...words: string[]): Promise<string[]> {
  const turn = await answering("A");
  for (const w of words) await session.send(w);
  session.stop();
  chat(turn, "A", CANCELLED);
  await tick();
  return st().queued.map((q) => q.id);
}

/** "next" waits behind chat A's reply; that reply ended and its send is held at admission. */
async function admitting(): Promise<Held<"chat.send">> {
  const turn = await answering("A");
  await session.send("next");
  const held = b.server.hold("chat.send");
  chat(turn, "A", done("a1", "A"));
  const h = await held;
  expect(st().queued).toEqual([]);
  return h;
}

/** "typed" is at admission in chat A, the first turn this session. */
async function typed(): Promise<Held<"chat.send">> {
  session.newThread();
  const held = b.server.hold("chat.send");
  void session.send("typed");
  const h = await held;
  expect(st().draft).toBe("");
  return h;
}

/** "one" is open for editing and the reply it waited for has ended. */
async function editedThroughDone(): Promise<void> {
  const turn = await answering("A");
  await session.send("one");
  session.editQueued(st().queued[0]?.id ?? "");
  chat(turn, "A", done("a1", "A"));
  await until(() => live() === null, 2000, "A done");
  await tick();
  expect(sends()).toHaveLength(1);
}

const WOULD_STOP_MESSAGE = "this would stop another reply";

/** Typed in A and stopped at admission; then B sent, which took the live slot, and the person came back to A. */
async function stoppedThenReplaced(): Promise<Held<"chat.send">> {
  const h = await typed();
  session.stop();
  await answering("B");
  session.openThread("A");
  // B's reply runs in its own chat; A's stopped send no longer has a turn to come back to
  expect(store.runningThreads(st()).has("B")).toBe(true);
  expect(st().turns["A"]).toBeUndefined();
  return h;
}

/** A message typed during setup whose automatic send was refused once setup finished. */
async function refusedAfterSetup(): Promise<string> {
  const ready = methodSamples["runtime.status"].result;
  b.server.push("runtime.changed", { ...ready, state: "installing" });
  await until(() => st().runtime?.state === "installing", 2000, "setup");
  session.newThread();
  await session.send("typed during setup");
  expect(st().queued).toMatchObject([{ waitFor: "setup" }]);
  const held = b.server.hold("chat.send");
  b.server.push("runtime.changed", ready);
  (await held).fail("internal", "no");
  await until(() => st().queued.length === 1, 2000, "the message back");
  return st().queued[0]?.id ?? "";
}

function stoppedWords(threadId = "A"): void {
  const m = (st().messages[threadId] ?? []).find((x) => x.role === "assistant");
  expect(m?.content).toBe("words so far");
  expect(st().stopNotes[m?.id ?? ""]).toEqual({ kind: "stopped", secs: expect.any(Number) });
}

describe("a message the person typed is never lost", () => {
  describe("a Send now that fails (CFS-01)", () => {
    it("goes back at its own place, on hold, and the box keeps what is in it", async () => {
      const ids = await onHold("one", "two", "three");
      type("something else");
      const held = b.server.hold("chat.send");
      session.sendQueuedNow(ids[1] ?? "");
      const h = await held;
      expect(texts()).toEqual(["one", "three"]);
      h.fail("internal", "no");
      await until(() => st().queued.length === 3, 2000, "the message back");
      expect(texts()).toEqual(["one", "two", "three"]);
      expect(st().queued[1]).toMatchObject({ id: ids[1], held: true });
      expect(st().draft).toBe("something else");
      expect(st().notice).not.toBeNull();
    });

    it("says the queue has it, not the box", async () => {
      const ids = await onHold("one");
      const held = b.server.hold("chat.send");
      session.sendQueuedNow(ids[0] ?? "");
      (await held).fail("closed", "gone");
      await until(() => st().queued.length === 1, 2000, "the message back");
      expect(st().notice).toMatch(/queue/);
      expect(st().notice).not.toMatch(/box/);
    });
  });

  it("a Regenerate that fails leaves the box alone: its words are already in the chat", async () => {
    const turn = await answering("A");
    chat(turn, "A", done("a1", "A"));
    await until(() => live() === null, 2000, "A done");
    type("half a thought");
    const held = b.server.hold("chat.send");
    session.retry();
    (await held).fail("internal", "no");
    await until(() => st().notice !== null, 2000, "the notice");
    expect(st().draft).toBe("half a thought");
    expect(st().queued).toEqual([]);
  });

  describe("a queued message whose send is refused", () => {
    it("after Stop during admission is back in its own chat's queue (CFS-02)", async () => {
      const h = await admitting();
      session.stop();
      h.fail("wont-fit", "no");
      await until(() => st().queued.length === 1, 2000, "the message back");
      expect(st().queued).toMatchObject([{ threadId: "A", text: "next", held: true }]);
      expect(live()?.ending).toBeUndefined();
      expect(live()?.pendingUser).toBeNull();
    });

    it("while another chat owns the live slot is back in its own chat's queue, and the notice says where (CFS-03)", async () => {
      const h = await admitting();
      const other = await answering("B");
      h.fail("wont-fit", "no");
      await until(() => st().queued.length === 1, 2000, "the message back");
      expect(st().queued).toMatchObject([{ threadId: "A", text: "next", held: true }]);
      expect(live()?.turnId).toBe(other);
      expect(st().notice).toMatch(/hello A/);
    });

    it("holds what was waiting behind it, so nothing overtakes it", async () => {
      const turn = await answering("A");
      await session.send("first");
      await session.send("second");
      const held = b.server.hold("chat.send");
      chat(turn, "A", done("a1", "A"));
      (await held).fail("wont-fit", "no");
      await until(() => st().queued.length === 2, 2000, "the message back");
      await tick();
      expect(texts()).toEqual(["first", "second"]);
      expect(st().queued.map((q) => q.held)).toEqual([true, true]);
      expect(sends().map((s) => s.content)).toEqual(["hello A", "first"]);
    });
  });

  it("a refused send wakes what another chat has waiting behind it", async () => {
    const a = await answering("A");
    await session.send("for A");
    const c = await answering("B");
    await session.send("for B");
    chat(a, "A", done("a1", "A"));
    await tick();
    const held = b.server.hold("chat.send");
    chat(c, "B", done("b1", "B"));
    (await held).fail("wont-fit", "no");
    await until(() => sends().some((s) => s.content === "for B"), 2000, "B's queued message");
    expect(st().queued).toMatchObject([{ threadId: "A", text: "for A", held: true }]);
  });

  describe("a typed message whose send is refused after the person moved on", () => {
    it("behind another chat, it restores its source draft and leaves the open chat alone", async () => {
      const drafts = await import("../src/drafts.ts");
      session.newThread();
      const held = b.server.hold("chat.send");
      void session.send("typed");
      const h = await held;
      await answering("B");
      h.fail("wont-fit", "no");
      await until(() => drafts.getDraft("A").text === "typed", 2000, "A's draft restored");
      expect(drafts.getDraft("A").text).toBe("typed");
      expect(st().queued).toEqual([]);
      expect(drafts.getDraft("B").text).toBe("");
      expect(st().messages["B"]?.some(m => m.content === "typed")).not.toBe(true);
    });

    it("with new words typed in the box, the box keeps them and the message waits in the queue", async () => {
      const h = await typed();
      type("the next thought");
      h.fail("wont-fit", "no");
      await until(() => st().queued.length === 1, 2000, "the message back");
      expect(st().draft).toBe("the next thought");
      expect(st().queued).toMatchObject([{ threadId: "A", text: "typed", held: true }]);
    });

    it("stopped during admission with an empty box, it is back in the box", async () => {
      const h = await typed();
      session.stop();
      h.fail("wont-fit", "no");
      await until(() => st().draft !== "", 2000, "the text back");
      expect(st().draft).toBe("typed");
      expect(st().queued).toEqual([]);
    });
  });

  describe("Remove while a Send now is waiting on its warning (CFS-04)", () => {
    it("takes the warning with it, and a confirm sends nothing", async () => {
      const ids = await onHold("next");
      b.server.answer("turns.blocking", () => BLOCKING);
      session.sendQueuedNow(ids[0] ?? "");
      await until(() => st().stopAsk !== null, 2000, "the warning");
      session.removeQueued(ids[0] ?? "");
      expect(st().stopAsk).toBeNull();
      session.confirmStopAsk(false);
      await tick();
      expect(sends()).toHaveLength(1);
    });

    it("a warning whose message left another way sends nothing on confirm", async () => {
      const ids = await onHold("next");
      b.server.answer("turns.blocking", () => BLOCKING);
      session.sendQueuedNow(ids[0] ?? "");
      await until(() => st().stopAsk !== null, 2000, "the warning");
      store.setState({ queued: [] });
      session.confirmStopAsk(false);
      await tick();
      expect(sends()).toHaveLength(1);
      expect(st().stopAsk).toBeNull();
    });

    it("removed while the server is being asked, it shows no warning and is not sent", async () => {
      const ids = await onHold("next");
      const held = b.server.hold("turns.blocking");
      session.sendQueuedNow(ids[0] ?? "");
      const h = await held;
      session.removeQueued(ids[0] ?? "");
      h.respond(BLOCKING);
      await tick();
      expect(st().stopAsk).toBeNull();
      expect(sends()).toHaveLength(1);
    });

    it("removed while the server is being asked with nothing in the way, it is not sent", async () => {
      const ids = await onHold("next");
      const held = b.server.hold("turns.blocking");
      session.sendQueuedNow(ids[0] ?? "");
      const h = await held;
      session.removeQueued(ids[0] ?? "");
      h.respond([]);
      await tick();
      expect(sends()).toHaveLength(1);
    });
  });

  describe("the only queued message, edited while its reply finished (CFS-05)", () => {
    it("goes when the edit is finished", async () => {
      await editedThroughDone();
      await session.send("one, better");
      await until(() => sends().length === 2, 2000, "the queued send");
      expect(sends()[1]?.content).toBe("one, better");
    });

    it("goes when the edit is cancelled", async () => {
      await editedThroughDone();
      session.cancelQueuedEdit();
      await until(() => sends().length === 2, 2000, "the queued send");
      expect(sends()[1]?.content).toBe("one");
    });

    it("goes when leaving the chat ends the edit", async () => {
      await editedThroughDone();
      session.newThread();
      await until(() => sends().length === 2, 2000, "the queued send");
      expect(sends()[1]?.content).toBe("one");
    });

    it("waits while a reply is still being written", async () => {
      await answering("A");
      await session.send("one");
      session.editQueued(st().queued[0]?.id ?? "");
      await session.send("one, better");
      await tick();
      expect(sends()).toHaveLength(1);
      expect(texts()).toEqual(["one, better"]);
    });
  });

  describe("a stopped reply's words when something else takes the slot (CFS-06)", () => {
    it("stay when another chat sends", async () => {
      await stopped("words so far");
      await answering("B");
      session.openThread("A");
      stoppedWords();
    });

    it("stay when a reply running behind it comes back", async () => {
      await answering("A");
      const turn = await answering("B");
      chat(turn, "B", { type: "delta", text: "words so far" });
      await tick();
      session.stop();
      chat(turn, "B", CANCELLED);
      await tick();
      session.openThread("A");
      expect(live()?.threadId).toBe("A");
      stoppedWords("B");
    });

    it("stay when another client starts a turn here", async () => {
      await stopped("words so far");
      chat("elsewhere", "A", { type: "start", model: MODEL, userMessage: userMsg("u-phone", "A", "from the phone") });
      await tick();
      expect(live()?.turnId).toBe("elsewhere");
      stoppedWords();
    });

    it("Retry in their own chat still replaces them", async () => {
      await stopped("words so far");
      session.retry();
      await until(() => sends().length === 2, 2000, "the retry");
      await tick();
      expect(kept()).toBeUndefined();
    });
  });

  describe("a blocker the preflight missed (CFS-07)", () => {
    const WOULD_STOP = { code: "would-stop", message: "this would stop another reply", blocking: BLOCKING };

    /** The next chat.send is refused for a blocker; the ones after it go through as usual. */
    function refusedOnce(): void {
      void b.server.hold("chat.send").then((h) => h.fail(WOULD_STOP.code, WOULD_STOP.message, WOULD_STOP.blocking));
    }

    it("a person's send asks the server to refuse rather than wait", async () => {
      await answering("A");
      expect(sends()[0]).toMatchObject({ askFirst: true });
    });

    it("a queued message that goes on its own does not", async () => {
      const turn = await answering("A");
      await session.send("next");
      chat(turn, "A", done("a1", "A"));
      await until(() => sends().length === 2, 2000, "the queued send");
      expect(sends()[1]).not.toHaveProperty("askFirst");
      expect(sends()[1]).not.toHaveProperty("stopOthers");
    });

    it("shows the warning with the text still in the box, and confirm retries with stopOthers in the same chat", async () => {
      await answering("A");
      session.newThread();
      type("for B");
      refusedOnce();
      await session.send("for B");
      await until(() => st().stopAsk !== null, 2000, "the warning");
      expect(st().stopAsk?.blocking).toEqual(BLOCKING);
      expect(st().draft).toBe("for B");
      expect(st().notice).toBeNull();
      expect(b.server.calls("chat.cancel")).toHaveLength(0);
      expect(sends()).toHaveLength(2);
      session.confirmStopAsk(false);
      await until(() => sends().length === 3, 2000, "the retry");
      expect(sends()[2]).toMatchObject({ threadId: "B", content: "for B", stopOthers: true });
      expect(sends()[2]).not.toHaveProperty("askFirst");
      expect(b.server.calls("threads.create")).toHaveLength(2);
      expect(st().draft).toBe("");
    });

    it("cancelled, sends nothing more and keeps the text", async () => {
      await answering("A");
      session.newThread();
      type("for B");
      refusedOnce();
      await session.send("for B");
      await until(() => st().stopAsk !== null, 2000, "the warning");
      session.cancelStopAsk();
      await tick();
      expect(sends()).toHaveLength(2);
      expect(st().draft).toBe("for B");
    });

    it("with 'Don't show this again' saved, retries without asking", async () => {
      localStorage.setItem("gates-local.stop-others-ok", "1");
      await answering("A");
      session.newThread();
      refusedOnce();
      await session.send("for B");
      await until(() => sends().length === 3, 2000, "the retry");
      expect(st().stopAsk).toBeNull();
      expect(sends()[2]).toMatchObject({ content: "for B", stopOthers: true });
    });

    it("a Send now goes back at its place, and confirm sends it and takes it out", async () => {
      const ids = await onHold("one", "two");
      type("something else");
      refusedOnce();
      session.sendQueuedNow(ids[0] ?? "");
      await until(() => st().stopAsk !== null, 2000, "the warning");
      expect(texts()).toEqual(["one", "two"]);
      expect(st().draft).toBe("something else");
      session.confirmStopAsk(false);
      await until(() => sends().length === 3, 2000, "the retry");
      expect(sends()[2]).toMatchObject({ content: "one", stopOthers: true });
      expect(texts()).toEqual(["two"]);
      expect(st().draft).toBe("something else");
    });

    it("with other words in the box, the message waits in the queue instead of taking the box", async () => {
      await answering("A");
      session.newThread();
      const held = b.server.hold("chat.send");
      void session.send("for B");
      const h = await held;
      type("newer words");
      h.fail(WOULD_STOP.code, WOULD_STOP.message, WOULD_STOP.blocking);
      await until(() => st().queued.length === 1, 2000, "the message back");
      expect(st().stopAsk).toBeNull();
      expect(st().draft).toBe("newer words");
      expect(st().queued).toMatchObject([{ threadId: "B", text: "for B", held: true }]);
    });

    it("after the person left the chat, no warning opens on the wrong screen: the message returns to its source draft", async () => {
      const drafts = await import("../src/drafts.ts");
      await answering("A");
      session.newThread();
      const held = b.server.hold("chat.send");
      void session.send("for B");
      const h = await held;
      session.openThread("A");
      h.fail(WOULD_STOP.code, WOULD_STOP.message, WOULD_STOP.blocking);
      await until(() => drafts.getDraft("B").text === "for B", 2000, "B's draft restored");
      expect(st().stopAsk).toBeNull();
      expect(drafts.getDraft("B").text).toBe("for B");
      expect(st().queued).toEqual([]);
      expect(drafts.getDraft("A").text).toBe("");
      expect(st().messages["A"]?.some(m => m.content === "for B")).not.toBe(true);
    });
  });

  describe("Stop means stop", () => {
    it("a typed message refused after Stop keeps what was queued behind it on hold (CFT-01)", async () => {
      const h = await typed();
      await session.send("behind it");
      expect(texts()).toEqual(["behind it"]);
      session.stop();
      h.fail("wont-fit", "no");
      await until(() => st().draft === "typed", 2000, "the text back");
      await tick();
      expect(sends().map((s) => s.content)).toEqual(["typed"]);
      expect(st().queued).toMatchObject([{ threadId: "A", text: "behind it", held: true }]);
    });

    it("a stopped send never retries once another chat has taken the slot, with standing consent (CFT-02)", async () => {
      localStorage.setItem("gates-local.stop-others-ok", "1");
      const h = await stoppedThenReplaced();
      h.fail("would-stop", WOULD_STOP_MESSAGE, BLOCKING);
      await until(() => st().draft === "typed", 2000, "the text back");
      await tick();
      expect(sends().map((s) => s.content)).toEqual(["typed", "hello B"]);
      expect(sends().some((s) => s.stopOthers === true)).toBe(false);
    });

    it("a stopped send opens no warning either once another chat has taken the slot (CFT-02)", async () => {
      const h = await stoppedThenReplaced();
      h.fail("would-stop", WOULD_STOP_MESSAGE, BLOCKING);
      await until(() => st().draft === "typed", 2000, "the text back");
      expect(st().stopAsk).toBeNull();
    });

    it("what queued behind a stopped send stays on hold once another chat has taken the slot (CFT-01, CFT-02)", async () => {
      const drafts = await import("../src/drafts.ts");
      session.newThread();
      const held = b.server.hold("chat.send");
      void session.send("typed");
      const h = await held;
      await session.send("behind it");
      session.stop();
      const turnB = await answering("B");
      chat(turnB, "B", done("b1", "B"));
      await until(() => live() === null, 2000, "B done");
      expect(texts()).toEqual(["behind it"]);
      h.fail("wont-fit", "no");
      await until(() => drafts.getDraft("A").text === "typed", 2000, "A's draft restored");
      expect(drafts.getDraft("A").text).toBe("typed");
      expect(drafts.getDraft("B").text).toBe("");
      expect(st().messages["B"]?.some(m => m.content === "typed")).not.toBe(true);
      expect(st().queued).toMatchObject([{ threadId: "A", text: "behind it", held: true }]);
      await tick();
      expect(sends().map((s) => s.content)).toEqual(["typed", "hello B"]);
      expect(st().queued.every((q) => q.held === true)).toBe(true);
    });
  });

  describe("a message that waited for setup and was refused (CFT-03)", () => {
    it("reads as on hold, not as waiting for setup", async () => {
      await refusedAfterSetup();
      expect(st().queued).toMatchObject([{ text: "typed during setup", held: true, waitFor: "reply" }]);
    });

    it("goes when Send now is pressed", async () => {
      const id = await refusedAfterSetup();
      session.sendQueuedNow(id);
      await until(() => sends().length === 2, 2000, "the Send now");
      expect(sends()[1]).toMatchObject({ content: "typed during setup", askFirst: true });
      expect(st().queued).toEqual([]);
    });
  });

  describe("confirming names the turns the person agreed to stop (CFT-04)", () => {
    const OTHER: BlockingTurn[] = [{ threadId: "C", title: "Third chat", model: "qwen3:14b", turnId: "turn-C-1" }];

    it("the confirmed send carries exactly the turns the warning named", async () => {
      await warned();
      session.confirmStopAsk(false);
      await until(() => sends().length === 2, 2000, "the second send");
      expect(sends()[1]).toMatchObject({ stopOthers: true, stopTurns: ["turn-A-1"] });
    });

    it("a different turn in the way by then brings the warning back, naming it, and the next yes carries its id", async () => {
      await warned();
      const held = b.server.hold("chat.send");
      session.confirmStopAsk(false);
      (await held).fail("would-stop", WOULD_STOP_MESSAGE, OTHER);
      await until(() => st().stopAsk !== null, 2000, "the second warning");
      expect(st().stopAsk?.blocking).toEqual(OTHER);
      expect(st().draft).toBe("for B");
      session.confirmStopAsk(false);
      await until(() => sends().length === 3, 2000, "the retry");
      expect(sends()[2]).toMatchObject({ threadId: "B", content: "for B", stopOthers: true, stopTurns: ["turn-C-1"] });
    });

    it("ticking 'Don't show this again' is standing consent: no list of turns", async () => {
      await warned();
      session.confirmStopAsk(true);
      await until(() => sends().length === 2, 2000, "the second send");
      expect(sends()[1]).toMatchObject({ stopOthers: true });
      expect(sends()[1]).not.toHaveProperty("stopTurns");
    });

    it("already saved, the send goes with standing consent and no list of turns", async () => {
      localStorage.setItem("gates-local.stop-others-ok", "1");
      await warned();
      await until(() => sends().length === 2, 2000, "the second send");
      expect(sends()[1]).toMatchObject({ stopOthers: true });
      expect(sends()[1]).not.toHaveProperty("stopTurns");
    });
  });
});
