// The window's side of the server's records, without a browser: what it asks the server again after
// a dropped connection, and an Edit that comes after the message went out.
import { type QueuedMessage, type Reply, WireError } from "@gates-local/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { State } from "../lib/store/store.ts";
import { queuedOf, repliesOf } from "../../test/queue.ts";

vi.stubGlobal("window", {});
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });

const { chooseForQueued, createChat, editQueued, oldQueueOwed, oldQueueRead } = await import("./chat.ts");
const { getState, runningTurn, setState } = await import("../lib/store/store.ts");
const { getDraft, clearDraft, dropDraft, replaceDraft } = await import("../lib/store/drafts.ts");
const initial = getState();

type Answer = (params: unknown) => Promise<unknown>;
const answers = new Map<string, Answer>();
const calls: { method: string; params: unknown }[] = [];
let chat: ReturnType<typeof createChat>;
const call = (method: string, params: unknown) => {
  calls.push({ method, params });
  return answers.get(method)?.(params) ?? Promise.resolve([]);
};
/** A waiting message as the server's record of it, at a stage; numbered after the one a test starts with. */
const record = (id: string, stage: object = { stage: "queued" }, rev = 2) => ({ id, threadId: "t1", rev, messageId: `m-${id}`, text: `words ${id}`, at: 1, ...stage }) as Reply;
const HELD = { stage: "held", held: { why: "restart" } };
const taken = (id: string) => ({ answer: "sending", reply: record(id, { stage: "starting", attempt: 1, startedAt: 1 }) });
// a call on one waiting message is done unless a test answers it otherwise
const reply = (method: string, params: { id: string }) => {
  calls.push({ method, params });
  return answers.get(method)?.(params) ?? Promise.resolve({ answer: "done", reply: record(params.id) });
};
const none = () => undefined;
// a fresh window per test: what it heard at connect starts over
beforeEach(() => {
  chat = createChat({
    applyServerEvent: (patch: Partial<State> | ((s: State) => Partial<State> | undefined)) => setState(typeof patch === "function" ? (s) => patch(s) ?? {} : patch),
    call, reply, codeOf: (e: unknown) => (e instanceof WireError ? e.code : "internal"),
    createThread: none, creatingDraft: none, loadThread: none, loading: () => false, noteMessage: none, withMessage: none, untrackedDone: none, openThread: none, blockingFor: () => [],
  } as unknown as Parameters<typeof createChat>[0]);
});
afterEach(() => {
  oldQueueRead([], false);
  answers.clear();
  calls.length = 0;
  storage.clear();
  clearDraft("t1");
  dropDraft("t1");
  setState(initial);
});

const settle = () => new Promise((r) => setTimeout(r, 0));
/** A message this browser saved before the server kept the queue. */
const row = (id: string): QueuedMessage => ({ id, threadId: "t1", messageId: `m-${id}`, text: `words ${id}`, at: 1, waitFor: "reply" });
/** The window with one message waiting in the open chat, as the server's record said. */
const waiting = (id: string) => ({ view: "thread" as const, threadId: "t1", replies: repliesOf([{ id, threadId: "t1", text: `words ${id}`, at: 1, waitFor: "reply" }]) });
/** A connection opens and the server lists its records. */
function listed(...replies: Reply[]): void {
  chat.connected();
  chat.replyListed(replies.map((r) => ({ reply: r })));
}
const adds = () => calls.filter((c) => c.method === "queue.add").map((c) => (c.params as QueuedMessage).id);
const owed = (id: string) => oldQueueOwed().some((q) => q.id === id);
const moved = () => storage.get("gates-local.queue-on-server") === "1";

it("an Edit that comes after the server started sending the message closes at the server's answer, and says it is on its way", async () => {
  setState(waiting("q1"));
  replaceDraft("t1", { text: "half a thought" });
  answers.set("reply.edit", () => Promise.resolve(taken("q1")));
  editQueued("q1");
  await settle();
  expect(getState().editingQueued).toBeNull();
  expect(getDraft("t1").text, "the words before the Edit are back").toBe("half a thought");
  expect(getState().notice).toBe("This message is already on its way.");
});

it.each([
  ["sent", { answer: "gone", why: "sent" }, "That message was already sent."],
  ["removed in another window", { answer: "gone", why: "removed" }, "That message was removed."],
  ["open in another window", { answer: "elsewhere", reply: record("q1", { stage: "editing", by: "2", back: { stage: "queued" } }) }, "That message is open in another window."],
])("an Edit of a message already %s closes and says so", async (_what, answer, said) => {
  setState(waiting("q1"));
  replaceDraft("t1", { text: "half a thought" });
  answers.set("reply.edit", () => Promise.resolve(answer));
  editQueued("q1");
  await settle();
  expect(getState().editingQueued).toBeNull();
  expect(getDraft("t1").text, "the words before the Edit are back").toBe("half a thought");
  expect(getState().notice).toBe(said);
});

it("an Edit that never reaches the server stays open, and the next connection asks again", async () => {
  setState(waiting("q1"));
  answers.set("reply.edit", () => Promise.resolve({ answer: "not-reached", why: "closed" }));
  editQueued("q1");
  await settle();
  expect(getState().editingQueued).toBe("q1");
  expect(getState().notice).toBeNull();
  answers.clear();
  listed(record("q1"));
  expect(calls.filter((c) => c.method === "reply.edit")).toHaveLength(2);
});

it("words typed into a late Edit before the server's answer stay in the composer as a new message", async () => {
  setState(waiting("q1"));
  let refuse!: () => void;
  answers.set("reply.edit", () => new Promise((yes) => { refuse = () => yes({ answer: "gone", why: "sent" }); }));
  editQueued("q1");
  replaceDraft("t1", { text: "words q1, and more" });
  refuse();
  await settle();
  expect(getState().editingQueued).toBeNull();
  expect(getDraft("t1")).toMatchObject({ text: "words q1, and more", sendId: null });
  expect(getState().notice).toBe("That message was already sent. Your new words are still in the composer.");
});

it("an Edit the server takes opens the message in the composer", async () => {
  setState(waiting("q1"));
  editQueued("q1");
  await settle();
  expect(getState().editingQueued).toBe("q1");
  expect(getDraft("t1").text).toBe("words q1");
});

it("a queue add whose answer was lost is not asked again once the server's record of it came", async () => {
  // this browser's queue from before the server kept it goes once, on hold
  answers.set("queue.add", () => new Promise(() => undefined));
  oldQueueRead([row("q1")], false);
  listed();
  expect(adds()).toEqual(["q1"]);
  // the add reached the server; its answer did not come back before the connection dropped
  chat.recordChanged({ kind: "is", reply: record("q1", HELD) });
  expect(owed("q1"), "the server has it").toBe(false);
  // another window removed it; this one reconnects
  listed();
  expect(adds(), "not asked again").toEqual(["q1"]);
  expect(queuedOf(getState())).toEqual([]);
});

it("a queue add the server refuses as removed shows no row, is owed no longer, and says nothing", async () => {
  answers.set("queue.add", () => Promise.reject(new WireError("queue-removed", "This message was removed from the queue.")));
  oldQueueRead([row("q1")], false);
  listed();
  await settle();
  expect(queuedOf(getState())).toEqual([]);
  expect(owed("q1")).toBe(false);
  expect(getState().notice).toBeNull();
});

it("a queued message refused for memory says what runs instead on its row alone, and the choice taken goes to the server's entry", async () => {
  const offer = { context: { numCtx: 8192, verdict: "fits" as const }, short: { needBytes: 2, gpuBytes: 1, ramBytes: 0, shortBytes: 1 } };
  setState(waiting("q1"));
  chat.recordChanged({ kind: "is", reply: record("q1", { model: "qwen3.5:9b", numCtx: 16384, stage: "held", held: { why: "refused", code: "wont-fit", message: "too big", offer } }) });
  expect(getState().notice, "the row carries the offer: nothing under the box says it again").toBeNull();
  expect(await chooseForQueued("q1", "qwen3.5:9b", 8192), "the server has the choice").toBe(true);
  expect(calls.at(-1)).toEqual({ method: "reply.change", params: { id: "q1", base: "m-q1", messageId: "m-q1", model: "qwen3.5:9b", numCtx: 8192 } });
});

it("a choice for a message another window has open is not taken, and says so", async () => {
  setState(waiting("q1"));
  answers.set("reply.change", () => Promise.resolve({ answer: "elsewhere", reply: record("q1", { stage: "editing", by: "2", back: { stage: "queued" } }) }));
  expect(await chooseForQueued("q1", "qwen3.5:9b", 8192)).toBe(false);
  expect(getState().notice).toBe("That message is open in another window.");
});

it("a picture the server took a Stop for has nothing left to stop here, while its engine still lets go", () => {
  setState({ view: "thread", threadId: "t1" });
  listed();
  const drawing = { id: "p1", threadId: "t1", rev: 3, stage: "drawing", questionId: "m-p1", preset: "preset", startedAt: 10_000, jobs: [] } as const;
  chat.recordChanged({ kind: "is", reply: drawing });
  expect(runningTurn(getState(), "t1"), "the composer offers Stop").toMatchObject({ turnId: "p1", reply: { stage: "drawing" } });
  chat.recordChanged({ kind: "is", reply: { ...drawing, rev: 4, stoppedAt: 14_000 } });
  expect(runningTurn(getState(), "t1"), "nothing more to press").toBeUndefined();
  // the turn stays until the server's record ends: a second reply cannot start in this chat yet
  expect(getState().turns.t1).toMatchObject({ turnId: "p1", end: { kind: "stopped", secs: 4 }, reply: { stage: "drawing", stoppedAt: 14_000 } });
});

it("a message the server sent leaves what this window would ask again", async () => {
  answers.set("queue.add", () => new Promise(() => undefined));
  oldQueueRead([row("q1")], false);
  listed();
  // the server took it and sent it: its record says it is on its way
  chat.recordChanged({ kind: "is", reply: record("q1", { stage: "starting", attempt: 1, startedAt: 1 }) });
  listed();
  expect(adds()).toEqual(["q1"]);
});

// A person who updates with three messages waiting still has them, whichever arrives first: the
// server's list at connect, or this browser's saved queue read back from disk.
it.each(["the server's list", "the saved queue"])("an old saved queue reaches the server once, on hold, when %s comes first", async (first) => {
  const old = [row("a"), row("b"), row("c")];
  answers.set("queue.add", () => new Promise(() => undefined));
  if (first === "the server's list") listed();
  oldQueueRead(old, false);
  if (first === "the saved queue") listed();
  expect(adds()).toEqual(["a", "b", "c"]);
  expect(calls.filter((c) => c.method === "queue.add").every((c) => (c.params as QueuedMessage).held === true)).toBe(true);
  expect(old.every((q) => owed(q.id)), "kept saved until the server answers").toBe(true);
  expect(moved(), "not marked moved before the server has any").toBe(false);
  // the server has them now; the next connect and a second read of the save add nothing
  listed(...old.map((q) => record(q.id, HELD)));
  expect(moved(), "marked moved").toBe(true);
  oldQueueRead(old, false);
  expect(adds(), "never twice").toEqual(["a", "b", "c"]);
});

it("an old saved queue the server already has is not added again, and is no longer owed", async () => {
  oldQueueRead([row("q1")], false);
  listed(record("q1", HELD));
  expect(adds()).toEqual([]);
  expect(owed("q1")).toBe(false);
});

it("an old saved message is owed until the server answers its add", async () => {
  let answer!: () => void;
  answers.set("queue.add", () => new Promise((yes) => { answer = () => yes(undefined); }));
  oldQueueRead([row("q1")], false);
  listed();
  expect(owed("q1")).toBe(true);
  answer();
  await settle();
  expect(owed("q1")).toBe(false);
});
