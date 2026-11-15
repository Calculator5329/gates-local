// The window's side of the server's queue, without a browser: what it asks the server again after
// a dropped connection, and an Edit that comes after the message went out.
import { type QueuedMessage, WireError } from "@gates-local/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { State } from "../lib/store/store.ts";

vi.stubGlobal("window", {});
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });

const { chooseForQueued, createChat, editQueued, oldQueueRead, queueOnServer, stillOwed } = await import("./chat.ts");
const { getState, setState } = await import("../lib/store/store.ts");
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
/** A waiting message as the server's record of it, at a stage. */
const record = (id: string, stage: object = { stage: "queued" }) => ({ id, threadId: "t1", rev: 1, messageId: `m-${id}`, text: `words ${id}`, at: 1, ...stage });
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
    applyServerEvent: (patch: Partial<State> | ((s: State) => Partial<State>)) => setState(patch),
    call, reply, codeOf: (e: unknown) => (e instanceof WireError ? e.code : "internal"),
    createThread: none, creatingDraft: none, loadThread: none, loading: () => false, noteMessage: none, withMessage: none, untrackedDone: none, openThread: none, blockingFor: () => [],
  } as unknown as Parameters<typeof createChat>[0]);
});
afterEach(() => {
  // what a test left unanswered is the server's now: nothing carries into the next test
  chat.queueChanged(["a", "b", "c", "q1"].map(row));
  oldQueueRead([]);
  answers.clear();
  calls.length = 0;
  storage.clear();
  clearDraft("t1");
  dropDraft("t1");
  setState(initial);
});

const settle = () => new Promise((r) => setTimeout(r, 0));
const row = (id: string): QueuedMessage => ({ id, threadId: "t1", messageId: `m-${id}`, text: `words ${id}`, at: 1, waitFor: "reply" });
const adds = () => calls.filter((c) => c.method === "queue.add").map((c) => (c.params as QueuedMessage).id);

it("an Edit that comes after the server started sending the message closes at the server's answer, and says it is on its way", async () => {
  setState({ view: "thread", threadId: "t1", queued: [row("q1")] });
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
  setState({ view: "thread", threadId: "t1", queued: [row("q1")] });
  replaceDraft("t1", { text: "half a thought" });
  answers.set("reply.edit", () => Promise.resolve(answer));
  editQueued("q1");
  await settle();
  expect(getState().editingQueued).toBeNull();
  expect(getDraft("t1").text, "the words before the Edit are back").toBe("half a thought");
  expect(getState().notice).toBe(said);
});

it("an Edit that never reaches the server stays open, and the next connection asks again", async () => {
  setState({ view: "thread", threadId: "t1", queued: [row("q1")] });
  answers.set("reply.edit", () => Promise.resolve({ answer: "not-reached", why: "closed" }));
  editQueued("q1");
  await settle();
  expect(getState().editingQueued).toBe("q1");
  expect(getState().notice).toBeNull();
  answers.clear();
  chat.queueListed([row("q1")]);
  expect(calls.filter((c) => c.method === "reply.edit")).toHaveLength(2);
});

it("words typed into a late Edit before the server's answer stay in the composer as a new message", async () => {
  setState({ view: "thread", threadId: "t1", queued: [row("q1")] });
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
  setState({ view: "thread", threadId: "t1", queued: [row("q1")] });
  editQueued("q1");
  await settle();
  expect(getState().editingQueued).toBe("q1");
  expect(getDraft("t1").text).toBe("words q1");
});

it("a queue add whose answer was lost is not asked again once the server's list has it", async () => {
  // this browser's queue from before the server kept it goes once, on hold
  setState({ queued: [row("q1")] });
  answers.set("queue.add", () => new Promise(() => undefined));
  oldQueueRead([row("q1")]);
  chat.queueListed([]);
  expect(adds()).toEqual(["q1"]);
  // the add reached the server; its answer did not come back before the connection dropped
  chat.queueChanged([{ ...row("q1"), held: true }]);
  // another window removed it; this one reconnects
  chat.queueListed([]);
  expect(adds(), "not asked again").toEqual(["q1"]);
});

it("a queue add the server refuses as removed takes the row away and says nothing", async () => {
  setState({ queued: [row("q1")] });
  answers.set("queue.add", () => Promise.reject(new WireError("queue-removed", "This message was removed from the queue.")));
  oldQueueRead([row("q1")]);
  chat.queueListed([]);
  await settle();
  expect(getState().queued).toEqual([]);
  expect(getState().notice).toBeNull();
});

it("a queued message refused for memory in view shows what runs instead, and the choice taken goes to the server's entry", async () => {
  const offer = { context: { numCtx: 8192, verdict: "fits" as const }, short: { needBytes: 2, gpuBytes: 1, ramBytes: 0, shortBytes: 1 } };
  setState({ view: "thread", threadId: "t1", queued: [row("q1")] });
  chat.queueChanged([{ ...row("q1"), model: "qwen3.5:9b", numCtx: 16384, held: true, why: { code: "wont-fit", message: "too big", offer } }]);
  const s = getState();
  expect(s.notice).not.toBeNull();
  expect(s.noticeOffer).toEqual({ notice: s.notice, model: "qwen3.5:9b", numCtx: 16384, offer });
  expect(await chooseForQueued("q1", "qwen3.5:9b", 8192), "the server has the choice").toBe(true);
  expect(calls.at(-1)).toEqual({ method: "reply.change", params: { id: "q1", base: "m-q1", messageId: "m-q1", model: "qwen3.5:9b", numCtx: 8192 } });
});

it("a choice for a message another window has open is not taken, and says so", async () => {
  setState({ view: "thread", threadId: "t1", queued: [row("q1")] });
  answers.set("reply.change", () => Promise.resolve({ answer: "elsewhere", reply: record("q1", { stage: "editing", by: "2", back: { stage: "queued" } }) }));
  expect(await chooseForQueued("q1", "qwen3.5:9b", 8192)).toBe(false);
  expect(getState().notice).toBe("That message is open in another window.");
});

it("a message the server sent leaves what this window would ask again", async () => {
  setState({ queued: [row("q1")] });
  answers.set("queue.add", () => new Promise(() => undefined));
  oldQueueRead([row("q1")]);
  chat.queueListed([]);
  chat.onChatEvent({ turnId: "turn", threadId: "t1", event: { type: "start", model: "m", userMessage: { id: "m-q1", threadId: "t1", role: "user", content: "words q1", createdAt: 1 } } });
  chat.queueListed([]);
  expect(adds()).toEqual(["q1"]);
});

// A person who updates with three messages waiting still has them, whichever arrives first: the
// server's list at connect, or this browser's saved queue read back from disk.
it.each(["the server's list", "the saved queue"])("an old saved queue reaches the server once, on hold, when %s comes first", async (first) => {
  const old = [row("a"), row("b"), row("c")];
  answers.set("queue.add", () => new Promise(() => undefined));
  if (first === "the server's list") chat.queueListed([]);
  oldQueueRead(old);
  if (first === "the saved queue") chat.queueListed([]);
  expect(adds()).toEqual(["a", "b", "c"]);
  expect(calls.filter((c) => c.method === "queue.add").every((c) => (c.params as QueuedMessage).held === true)).toBe(true);
  expect(queueOnServer(), "marked moved").toBe(true);
  expect(old.every((q) => stillOwed(q.id)), "kept saved until the server answers").toBe(true);
  // the server has them now; the next connect and a second read of the save add nothing
  chat.queueListed(old.map((q) => ({ ...q, held: true })));
  oldQueueRead(old);
  expect(adds(), "never twice").toEqual(["a", "b", "c"]);
});

it("an old saved queue the server already has is not added again, and is no longer owed", async () => {
  oldQueueRead([row("q1")]);
  chat.queueListed([{ ...row("q1"), held: true }]);
  expect(adds()).toEqual([]);
  expect(stillOwed("q1")).toBe(false);
});

it("an old saved message is owed until the server answers its add", async () => {
  let answer!: () => void;
  answers.set("queue.add", () => new Promise((yes) => { answer = () => yes(undefined); }));
  oldQueueRead([row("q1")]);
  chat.queueListed([]);
  expect(stillOwed("q1")).toBe(true);
  answer();
  await settle();
  expect(stillOwed("q1")).toBe(false);
});
