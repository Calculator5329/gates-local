import { type BlockingTurn, type ImageChoice, type Message, type ModelInfo, type Params, type Reply, type ReplyOutcome, WireError } from "@gates-local/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveTurn, State, TurnClock } from "../lib/store/store.ts";
import type { SavedQueued } from "./chat.ts";

interface Wired {
  choose?: (id: string, model: string, numCtx: number) => Promise<boolean>;
  sendNow?: (id: string) => void;
}
const wired = vi.hoisted((): Wired => ({}));
vi.mock("../lib/session/index.ts", () => ({
  chooseForQueued: (id: string, model: string, numCtx: number) => wired.choose?.(id, model, numCtx) ?? Promise.resolve(false),
  sendQueuedNow: (id: string) => wired.sendNow?.(id),
  pickModel: () => undefined,
  setContext: () => undefined,
  send: () => Promise.resolve(),
  openSettings: () => undefined,
}));

vi.stubGlobal("window", {});
const storage = new Map<string, string>();
const storageStub = {
  getItem: (k: string): string | null => storage.get(k) ?? null,
  setItem: (k: string, v: string): void => void storage.set(k, v),
  removeItem: (k: string): void => void storage.delete(k),
};
vi.stubGlobal("localStorage", storageStub);
const frames: FrameRequestCallback[] = [];
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));

const { chooseForQueued, createChat, editQueued, editedElsewhere, firstPull, oldQueueOwed, oldQueueRead, sendsBeforeReady } = await import("./chat.ts");
const { getState, setState } = await import("../lib/store/store.ts");
const { clearDraft, dropDraft, getDraft, replaceDraft } = await import("../lib/store/drafts.ts");
const initial = getState();

const MODEL = "qwen3.5:9b";
const chatModel: ModelInfo = { name: MODEL, digest: "d", sizeBytes: 6_600_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["completion"] };
const embedder: ModelInfo = { name: "nomic-embed-text", digest: "e", sizeBytes: 270_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["embedding"] };
const READY: Partial<State> = { conn: { kind: "open" }, runtime: { state: "ready", owner: "external", baseUrl: "http://fake" }, models: [chatModel], model: MODEL };
const PICK: ImageChoice = { preset: "sketch", width: 512, height: 512 };

const calls: { method: string; params: { id: string } }[] = [];
const answers = new Map<string, (params: { id: string }) => Promise<ReplyOutcome>>();
const noted: Message[] = [];
const opened: string[] = [];
const creating = new Set<number>();
let blocking: () => Promise<readonly BlockingTurn[]> = () => Promise.resolve([]);
let chat: ReturnType<typeof createChat>;

type Starting = Extract<Reply, { readonly stage: "starting" }>;
type Live = Extract<Reply, { readonly stage: "loading" | "thinking" | "tool" | "writing" }>;
type Queued = Extract<Reply, { readonly stage: "queued" }>;
type Held = Extract<Reply, { readonly stage: "held" }>;
type Editing = Extract<Reply, { readonly stage: "editing" }>;

const words = (id: string) => ({ messageId: `m-${id}`, text: `words ${id}`, at: 1 });
const queued = (id: string, threadId = "t1", rev = 2, waitFor: Queued["waitFor"] = { what: "reply", reply: "other" }): Queued => ({ id, threadId, rev, ...words(id), stage: "queued", waitFor });
const held = (id: string, threadId = "t1", rev = 2): Held => ({ id, threadId, rev, ...words(id), model: MODEL, stage: "held", held: { why: "refused", code: "wont-fit", message: "too big" } });
const editing = (id: string, rev: number, by: string): Editing => ({ id, threadId: "t1", rev, ...words(id), stage: "editing", by, back: { stage: "queued" } });
const starting = (id: string, threadId = "t1", rev = 1): Starting => ({ id, threadId, rev, ...words(id), model: MODEL, stage: "starting", attempt: 1, startedAt: 1 });
const live = (id: string, rev: number, over: Partial<Pick<Live, "stage" | "try" | "silent">> = {}): Live => ({
  id, threadId: "t1", rev, questionId: `m-${id}`, model: MODEL, startedAt: 1, workMs: 0, toolMs: 0, try: 1, spans: [], callsAt: {}, stage: "writing", ...over,
});
const is = (reply: Reply) => ({ kind: "is" as const, reply });
const repliesOf = (...rows: Reply[]): Map<string, Reply> => new Map(rows.map((r) => [r.id, r]));
const saved = (id: string): SavedQueued => ({ id, threadId: "t1", messageId: `m-${id}`, text: `words ${id}`, at: 1 });
const methods = () => calls.map((c) => c.method);
const sends = () => calls.filter((c) => c.method === "reply.send").map((c) => c.params as Params<"reply.send">);
const settle = () => new Promise((r) => setTimeout(r, 0));
function runFrames(): void {
  for (const f of frames.splice(0)) f(0);
}
function defaultAnswer(method: string, params: { id: string }): Promise<ReplyOutcome> {
  if (method !== "reply.send") return Promise.resolve({ answer: "done", reply: queued(params.id) });
  const p = params as Params<"reply.send">;
  return Promise.resolve({ answer: "sending", reply: { id: p.id, threadId: p.threadId, rev: 1, messageId: p.messageId, text: p.text, at: 1, stage: "starting", attempt: 1, startedAt: 1 } });
}
function ask(method: string, params: { id: string }): Promise<ReplyOutcome> {
  calls.push({ method, params });
  return answers.get(method)?.(params) ?? defaultAnswer(method, params);
}
function withMessage(s: State, threadId: string, m: Message): State["messages"] {
  return { ...s.messages, [threadId]: [...(s.messages[threadId] ?? []).filter((x) => x.id !== m.id), m] };
}
function applyServerEvent(patch: Partial<State> | ((s: State) => Partial<State> | undefined)): void {
  setState(typeof patch === "function" ? (s) => patch(s) ?? {} : patch);
}
const turnIn = (threadId: string, turnId: string, reply: TurnClock, end: LiveTurn["end"]): LiveTurn => ({ threadId, turnId, model: MODEL, startedAt: 1, thinking: "", text: "partial words", tools: [], reply, end });
const clock = (over: Partial<TurnClock> = {}): TurnClock => ({ stage: "writing", startedAt: 1, workMs: 4000, toolMs: 0, attempt: 1, spans: [], callsAt: {}, ...over });
const ignore = (): void => undefined;
const picture = (state: "error" | "cancelled" | "done"): Message => ({ id: "p1", threadId: "t1", role: "assistant", content: "", createdAt: 2, imageJob: { jobId: "j1", state } });
const offered = (): Partial<State> => ({
  notice: "refused", noticeOffer: { notice: "refused", model: MODEL, numCtx: 32768, offer: { context: { numCtx: 16384, verdict: "fits" }, short: { needBytes: 1, gpuBytes: 1, ramBytes: 1, shortBytes: 1 } } },
});

beforeEach(() => {
  chat = createChat({
    applyServerEvent, reply: ask, codeOf: (e: unknown) => (e instanceof WireError ? e.code : "internal"),
    createThread: () => Promise.resolve("t-new"), creatingDraft: (v: number) => creating.has(v),
    loadThread: () => Promise.resolve(), loading: () => false, noteMessage: (_t: string, m: Message) => void noted.push(m), rowsSaved: () => undefined,
    withMessage, untrackedDone: () => undefined, openThread: (t: string) => void opened.push(t), blockingFor: () => blocking(),
  } as unknown as Parameters<typeof createChat>[0]);
});
afterEach(() => {
  vi.restoreAllMocks();
  oldQueueRead([], false);
  answers.clear();
  calls.length = 0;
  noted.length = 0;
  opened.length = 0;
  frames.length = 0;
  creating.clear();
  blocking = () => Promise.resolve([]);
  storage.clear();
  for (const key of ["t1", "t2", "t3", "t-new", null]) { clearDraft(key); dropDraft(key); }
  setState(initial);
});

it("a choice taken, an Edit opened and a Send now pressed change no message here until the server sends the change", async () => {
  const c1 = held("c1"), c2 = queued("c2"), c3 = queued("c3");
  setState({ ...READY, view: "thread", threadId: "t1", replies: repliesOf(c1, c2, c3) });
  const before = getState().replies;
  expect(await chooseForQueued("c1", "other:7b", 8192)).toBe(true);
  editQueued("c2");
  chat.sendQueuedNow("c3");
  await settle();
  expect(methods().toSorted()).toEqual(["reply.change", "reply.edit", "reply.now"]);
  expect(getState().replies, "every answer was done, and still nothing changed here").toBe(before);
  const changed: Held = { ...c1, rev: 3, model: "other:7b" };
  chat.recordChanged(is(changed));
  expect(getState().replies.get("c1")).toEqual(changed);
});

it("an edit opened in this window never reads as edited elsewhere, before the server answers or just after the edit ends here", async () => {
  setState({ ...READY, view: "thread", threadId: "t1", replies: repliesOf(queued("e1")) });
  editQueued("e1");
  const mine = editing("e1", 3, "this-window");
  expect(editedElsewhere(mine), "before the server's answer").toBe(false);
  await settle();
  chat.recordChanged(is(mine));
  expect(editedElsewhere(mine)).toBe(false);
  chat.cancelQueuedEdit();
  const late = editing("e1", 4, "this-window");
  chat.recordChanged(is(late));
  expect(editedElsewhere(late), "the record still says so a moment after the edit ended here").toBe(false);
  chat.recordChanged(is(queued("e1", "t1", 5)));
  const theirs = editing("e1", 6, "another-window");
  chat.recordChanged(is(theirs));
  expect(editedElsewhere(theirs), "opened again, by another window").toBe(true);
});

it("an edit a reload brought back is this window's, whatever the server's record says yet", () => {
  setState({ ...READY, view: "thread", threadId: "t1", editingQueued: "r1", replies: repliesOf(queued("r1")) });
  const said = editing("r1", 3, "before-the-reload");
  chat.recordChanged(is(said));
  expect(editedElsewhere(said)).toBe(false);
});

it("a saved queue is handed to the server when the browser cannot say whether it went already", () => {
  vi.spyOn(storageStub, "getItem").mockImplementation(() => { throw new Error("storage is off"); });
  answers.set("reply.send", () => new Promise(() => undefined));
  expect(oldQueueRead([saved("o1")], false).map((q) => q.id)).toEqual(["o1"]);
  chat.connected();
  chat.replyListed([]);
  expect(sends().map((p) => [p.id, p.held])).toEqual([["o1", true]]);
});

it("a saved message the server took stays the server's when the browser refuses to note the hand-over", () => {
  vi.spyOn(storageStub, "setItem").mockImplementation(() => { throw new Error("private window"); });
  answers.set("reply.send", () => new Promise(() => undefined));
  const left = vi.fn();
  oldQueueRead([saved("p1")], false);
  oldQueueOwed(left);
  chat.connected();
  chat.replyListed([]);
  expect(() => chat.recordChanged(is(held("p1"))), "a refused write breaks nothing").not.toThrow();
  expect(getState().replies.get("p1")?.stage).toBe("held");
  expect(oldQueueOwed().map((q) => q.id), "no longer owed").toEqual([]);
  expect(left).toHaveBeenCalledOnce();
  chat.connected();
  chat.replyListed([]);
  expect(sends(), "and not asked again at the next connection").toHaveLength(1);
});

it("a reply whose model is loaded but has sent nothing yet waits, with no work to time", () => {
  setState({ ...READY, view: "thread", threadId: "t1" });
  chat.recordChanged(is(starting("s1")));
  chat.recordChanged(is(live("s1", 2, { stage: "thinking", silent: true })));
  expect(getState().turns.t1?.reply?.stage).toBe("waiting");
  chat.recordChanged(is(live("s1", 3, { stage: "thinking" })));
  expect(getState().turns.t1?.reply?.stage, "once it sends something it thinks").toBe("thinking");
});

it("a download is the first chat model while only an embedding model is installed, and is not once a chat model is", () => {
  setState({ ...READY, models: [embedder], model: undefined, pulls: { [MODEL]: { name: MODEL, state: "downloading", completedBytes: 1, totalBytes: 10 } } });
  expect(firstPull(getState())).toBe(MODEL);
  expect(sendsBeforeReady(getState()), "so Send waits for it").toBe(true);
  setState({ models: [embedder, chatModel] });
  expect(firstPull(getState())).toBeUndefined();
});

it("a question sent apart from the composer goes as a message of its own, whatever the composer holds or is creating", async () => {
  setState({ ...READY, view: "thread", threadId: "t1" });
  replaceDraft("t1", { text: "my own words", sendId: "copy-1" });
  creating.add(getDraft("t1").version);
  await chat.send("from the library", { keepDraft: true });
  await settle();
  const sent = sends();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toBe("from the library");
  expect(sent[0]?.messageId, "not the composer's copy").not.toBe("copy-1");
  expect(sent[0]).not.toHaveProperty("images");
  expect(getDraft("t1")).toMatchObject({ text: "my own words", sendId: "copy-1" });
});

it("a Send now still waiting on the server sends nothing once its message was opened for editing meanwhile", async () => {
  let free: (b: readonly BlockingTurn[]) => void = ignore;
  blocking = () => new Promise((r) => { free = r; });
  setState({ ...READY, view: "thread", threadId: "t1", replies: repliesOf(queued("n1"), queued("n2")) });
  chat.sendQueuedNow("n1");
  editQueued("n1");
  free([]);
  await settle();
  expect(methods()).toEqual(["reply.edit"]);
  expect(getState().editingQueued).toBe("n1");
  chat.sendQueuedNow("n2");
  free([]);
  await settle();
  expect(calls.filter((c) => c.method === "reply.now").map((c) => c.params.id), "one left alone goes").toEqual(["n2"]);
});

it("a send refused says why in plain words, and says the words are back in the box only when they are", async () => {
  setState({ ...READY, view: "thread", threadId: "t1" });
  const refusedWith = async (code: string) => {
    answers.set("reply.send", () => Promise.reject(new WireError(code, "the server's own words")));
    await chat.send("hello");
    await settle();
    return getState().notice;
  };
  expect(await refusedWith("wont-fit")).toBe("Qwen 3.5 9B doesn't fit in memory at 16k. Pick a smaller model or context.");
  expect(await refusedWith("would-stop")).toBe("Another chat's reply is using the memory Qwen 3.5 9B needs. Your message is back in the box.");
  expect(await refusedWith("runtime-not-ready")).toBe("Chat starts when Ollama is ready. Your message is back in the box.");
  expect(getDraft("t1").text).toBe("hello");
  setState({ replies: repliesOf({ ...starting("rt"), retryOf: "u0" }) });
  chat.recordChanged(is({ id: "rt", threadId: "t1", rev: 5, stage: "failed", at: 2, code: "runtime-not-ready", message: "x" }));
  expect(getState().notice, "a Retry's words were never in the box").toBe("Chat starts when Ollama is ready.");
});

// Council climb-025 Q16: a failure said what was wrong and left nothing to press.
it("a send refused because another chat's reply holds the memory offers Stop the other reply and Wait; each sends the words once", async () => {
  setState({ ...READY, view: "thread", threadId: "t1" });
  const other: BlockingTurn = { threadId: "t2", title: "Trip", model: MODEL, turnId: "r9" };
  const refuse = async () => {
    answers.set("reply.send", () => Promise.reject(new WireError("would-stop", "the server's own words", [other])));
    await chat.send("hello");
    await settle();
    answers.delete("reply.send");
    calls.length = 0;
  };
  await refuse();
  expect(getState().noticeAct).toEqual({ notice: getState().notice, acts: ["stop-other", "wait"] });
  chat.noticeDo("wait");
  await settle();
  expect(sends()).toHaveLength(1);
  expect(sends()[0]?.text).toBe("hello");
  expect(sends()[0], "Wait queues behind the other reply: it neither asks first nor stops anything").not.toHaveProperty("askFirst");
  expect(sends()[0]).not.toHaveProperty("consent");
  await refuse();
  chat.noticeDo("stop-other");
  await settle();
  expect(sends()).toHaveLength(1);
  expect(sends()[0]?.consent).toEqual({ kind: "named", replies: ["r9"] });
  expect(getState().noticeAct).toBeNull();
});

it("Gates Local stopped answering offers Retry, which sends the words in the box again", async () => {
  setState({ ...READY, view: "thread", threadId: "t1" });
  answers.set("reply.send", () => Promise.resolve({ answer: "not-reached", why: "closed" }));
  await chat.send("hello");
  await settle();
  expect(getState().notice).toBe("Gates Local stopped answering. Your message is back in the box.");
  expect(getState().noticeAct).toEqual({ notice: getState().notice, acts: ["retry"] });
  answers.delete("reply.send");
  calls.length = 0;
  chat.noticeDo("retry");
  await settle();
  expect(sends().map((p) => p.text)).toEqual(["hello"]);
});

it.each([
  ["the server already said it has it is not", true, null, ""],
  ["the server never said it has it is", false, "back", "hello"],
] as const)("a send whose answer timed out when %s called unsent", async (_what, heard, said, box) => {
  setState({ ...READY, view: "thread", threadId: "t1" });
  answers.set("reply.send", (params) => {
    // why: the server's record of the send, as it arrives while the send waits for the card
    if (heard) chat.recordChanged(is(starting(params.id)));
    return Promise.resolve({ answer: "not-reached", why: "timeout" });
  });
  await chat.send("hello");
  await settle();
  const id = sends()[0]?.id ?? "";
  expect(getState().notice === null ? null : "back").toBe(said);
  expect(getDraft("t1").text).toBe(box);
  expect(getState().replies.has(id)).toBe(heard);
});

it("words kept from a reply whose record never said how it ended carry no times and are marked unfinished", () => {
  const failed = { kind: "error" as const, code: "internal", message: "boom" };
  setState({ ...READY, view: "thread", threadId: "t2", turns: {
    t1: turnIn("t1", "old", clock(), failed),
    t3: turnIn("t3", "said", clock({ ended: { reason: "failed", at: 9 } }), failed),
  } });
  chat.recordChanged(is(starting("next1", "t1")));
  chat.recordChanged(is(starting("next3", "t3")));
  const unsaid = getState().messages.t1?.find((m) => m.id === "stopped-old");
  expect(unsaid).toMatchObject({ content: "partial words", interrupted: true });
  expect(unsaid).not.toHaveProperty("times");
  const said = getState().messages.t3?.find((m) => m.id === "stopped-said");
  expect(said?.times, "the record said how it ended").toMatchObject({ startedAt: 1, workMs: 4000, ended: { reason: "failed", at: 9 } });
  expect(said).not.toHaveProperty("interrupted");
});

it("Retry replaces a picture that failed or was cancelled, and after a finished picture it is a new question", async () => {
  const question: Message = { id: "u1", threadId: "t1", role: "user", content: "a red barn", createdAt: 1 };
  const retriedAfter = async (state: "error" | "cancelled" | "done") => {
    setState({ ...READY, view: "thread", threadId: "t1", turns: {}, replies: new Map(), messages: { t1: [question, picture(state)] } });
    calls.length = 0;
    chat.retry();
    await settle();
    return sends().map((p) => p.retryOf ?? "new question");
  };
  expect(await retriedAfter("error")).toEqual(["u1"]);
  expect(await retriedAfter("cancelled")).toEqual(["u1"]);
  expect(await retriedAfter("done")).toEqual(["new question"]);
});

it("taking the offer for a held message sends it once the server says it has the choice, and not when it was refused", async () => {
  wired.choose = chooseForQueued;
  wired.sendNow = (id) => chat.sendQueuedNow(id);
  const { takeOffer } = await import("./RefusalNote.tsx");
  setState({ ...READY, view: "thread", threadId: "t1", replies: repliesOf(held("h1")), ...offered() });
  takeOffer("context");
  await settle();
  expect(methods()).toEqual(["reply.change", "reply.now"]);
  expect(calls.map((c) => c.params.id)).toEqual(["h1", "h1"]);
  calls.length = 0;
  answers.set("reply.change", () => Promise.resolve({ answer: "elsewhere", reply: editing("h1", 3, "another-window") }));
  setState(offered());
  takeOffer("context");
  await settle();
  expect(methods()).toEqual(["reply.change"]);
});

it("an old saved message the server takes from this browser puts up the restored-on-hold words, and one it already had puts up nothing", async () => {
  answers.set("reply.send", (p) => Promise.resolve({ answer: "done", reply: held(p.id) }));
  oldQueueRead([saved("o2")], false);
  chat.connected();
  chat.replyListed([]);
  await settle();
  expect(getState().notice).toBe("Your queued messages were restored on hold. Use Send now when you are ready.");
  setState({ notice: null });
  chat.connected();
  oldQueueRead([saved("o3")], true);
  chat.replyListed([{ reply: held("o3", "t1", 4) }]);
  await settle();
  expect(sends().map((p) => p.id)).toEqual(["o2"]);
  expect(getState().notice).toBeNull();
});

it("a new chat's first send for three pictures leaves the chat set to three once the server saved its question", async () => {
  answers.set("reply.send", (params) => {
    const p = params as Params<"reply.send">;
    return Promise.resolve({ answer: "sending", reply: { id: p.id, threadId: p.threadId, rev: 1, stage: "drawing", questionId: p.messageId, preset: PICK.preset, startedAt: 1, jobs: [] } });
  });
  setState({ conn: { kind: "open" }, view: "new", threadId: null, imagePick: PICK, imageCountNew: 3, threads: [{ id: "t-new", title: "barn", createdAt: 1, updatedAt: 1 }] });
  await chat.send("a red barn", { draw: PICK });
  await settle();
  expect(sends()).toEqual([expect.objectContaining({ draw: PICK, drawCount: 3 })]);
  expect(getState().threads.find((t) => t.id === "t-new")?.imageCount).toBe(3);
  expect(getState().imageCountNew).toBe(1);
  expect(getState().imagePick).toBeUndefined();
});

it("a new chat's first picture send the server holds leaves the pick and the count for the next try", async () => {
  answers.set("reply.send", (p) => Promise.resolve({ answer: "done", reply: held(p.id, "t-new") }));
  setState({ conn: { kind: "open" }, view: "new", threadId: null, imagePick: PICK, imageCountNew: 3, threads: [{ id: "t-new", title: "barn", createdAt: 1, updatedAt: 1 }] });
  await chat.send("a red barn", { draw: PICK });
  await settle();
  expect(sends()).toHaveLength(1);
  expect(getState().imagePick).toEqual(PICK);
  expect(getState().imageCountNew).toBe(3);
  expect(getState().threads.find((t) => t.id === "t-new")?.imageCount).toBeUndefined();
});

it("a message that waited for setup opens its chat when it goes, and one that waited for a reply does not", () => {
  setState({ ...READY, view: "thread", threadId: "t2", replies: repliesOf(queued("w1", "t1", 2, { what: "setup" }), queued("w3", "t3", 2)) });
  chat.recordChanged(is(starting("w1", "t1", 3)));
  chat.recordChanged(is(starting("w3", "t3", 4)));
  expect(opened).toEqual(["t1"]);
});

it("a reply's second attempt starts over without the first attempt's words still waiting for a frame", () => {
  setState({ ...READY, view: "thread", threadId: "t1" });
  // why: words are taken as they come only once this connection's list is read
  chat.replyListed([]);
  chat.recordChanged(is(starting("a1")));
  chat.recordChanged(is(live("a1", 2)));
  chat.onWords({ id: "a1", part: { type: "text", from: 0, text: "first try" } });
  chat.recordChanged(is(live("a1", 3, { try: 2 })));
  runFrames();
  expect(getState().turns.t1?.text).toBe("");
  chat.onWords({ id: "a1", part: { type: "text", from: 0, text: "second try" } });
  runFrames();
  expect(getState().turns.t1?.text).toBe("second try");
});

it("words that land before a reconnect's list is read follow its words so far, and the reply keeps growing", () => {
  setState({ ...READY, view: "thread", threadId: "t1" });
  chat.connected();
  chat.onWords({ id: "a1", part: { type: "text", from: 4, text: "two " } });
  chat.replyListed([{ reply: live("a1", 2), soFar: { text: "one ", thinking: "", steps: [] } }]);
  runFrames();
  chat.onWords({ id: "a1", part: { type: "text", from: 8, text: "three " } });
  runFrames();
  expect(getState().turns.t1?.text).toBe("one two three ");
});

it("a list read before a retry the window already took does not bring back the first try's words", () => {
  setState({ ...READY, view: "thread", threadId: "t1" });
  chat.connected();
  chat.recordChanged(is(live("a1", 3, { try: 2 })));
  chat.onWords({ id: "a1", part: { type: "text", from: 0, text: "New answer" } });
  runFrames();
  chat.replyListed([{ reply: live("a1", 2), soFar: { text: "Discarded words from attempt one", thinking: "", steps: [] } }]);
  runFrames();
  chat.onWords({ id: "a1", part: { type: "text", from: 10, text: " goes on" } });
  runFrames();
  expect(getState().turns.t1?.text).toBe("New answer goes on");
});

it("a retry the server took while this window was away replaces the old try's words, and words before the list follow the new try's", () => {
  setState({ ...READY, view: "thread", threadId: "t1" });
  chat.recordChanged(is(live("a1", 2)));
  chat.onWords({ id: "a1", part: { type: "text", from: 0, text: "Discarded words from attempt one" } });
  runFrames();
  chat.connected();
  chat.onWords({ id: "a1", part: { type: "text", from: 10, text: " goes on" } });
  chat.replyListed([{ reply: live("a1", 3, { try: 2 }), soFar: { text: "New answer", thinking: "", steps: [] } }]);
  runFrames();
  chat.onWords({ id: "a1", part: { type: "text", from: 18, text: " and on" } });
  runFrames();
  expect(getState().turns.t1?.text).toBe("New answer goes on and on");
});

it("a reply that ends in the change that first brings its saved question shows the question before the reply", () => {
  const question: Message = { id: "m-d1", threadId: "t1", role: "user", content: "words d1", createdAt: 1 };
  const answer: Message = { id: "r-d1", threadId: "t1", role: "assistant", content: "the answer", createdAt: 2 };
  setState({ ...READY, view: "thread", threadId: "t1", messages: { t1: [] } });
  chat.recordChanged(is(starting("d1")));
  chat.recordChanged({ kind: "is", reply: { id: "d1", threadId: "t1", rev: 2, stage: "done", at: 2, questionId: "m-d1", replyId: "r-d1" }, saved: [question, answer] });
  expect(getState().messages.t1?.map((m) => m.id)).toEqual(["m-d1", "r-d1"]);
  expect(noted.map((m) => m.id)).toEqual(["m-d1", "r-d1"]);
  expect(getState().turns.t1).toBeUndefined();
});
