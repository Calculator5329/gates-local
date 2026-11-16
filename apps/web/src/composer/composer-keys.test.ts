import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";
import { repliesOf } from "../../test/queue.ts";
import type { LiveTurn, State } from "../lib/store/store.ts";

const device = vi.hoisted(() => ({ coarse: false, noHover: false, width: 1280 }));
const loads = vi.hoisted(() => ({ picker: vi.fn(), image: vi.fn(), thread: vi.fn() }));
const fit = vi.hoisted(() => ({ open: vi.fn(), tip: vi.fn() }));
const voice = vi.hoisted(() => ({ send: undefined as (() => void) | undefined }));

vi.mock("../lib/session/index.ts", () => ({
  ...Object.fromEntries(["call", "cancelQueuedEdit", "cancelStopAsk", "chooseForQueued", "confirmStopAsk", "editQueued", "openSettings", "pickModel", "pull", "readImageRun", "pickImageCount", "removeQueued", "send", "sendQueuedNow", "setContext", "stop", "recheckRuntime", "typedInComposer"].map((name) => [name, vi.fn()])),
  firstPull: () => undefined,
  sendsBeforeReady: () => false,
  editedElsewhere: () => false,
}));
vi.mock("../app/screen-loaders.ts", async (original) => ({
  ...await original<typeof import("../app/screen-loaders.ts")>(),
  pickerScreen: { load: loads.picker },
  imagePickerScreen: { load: loads.image },
  threadScreen: { load: loads.thread, get: () => undefined, need: () => { loads.thread(); return () => undefined; } },
}));
vi.mock("../fit/fit-actions.ts", () => ({ openFit: fit.open }));
vi.mock("../lib/ui/ui.tsx", async (original) => ({ ...await original<typeof import("../lib/ui/ui.tsx")>(), openTip: fit.tip }));
vi.mock("../voice/Voice.tsx", async (original) => {
  const real = await original<typeof import("../voice/Voice.tsx")>();
  const react = await import("react");
  return { ...real, Voice: (p: Parameters<typeof real.Voice>[0]) => { voice.send = p.send; return react.createElement(real.Voice, p); } };
});

function clauseHolds(clause: string): boolean {
  if (clause === "(pointer: coarse)") return device.coarse;
  if (clause === "(hover: none)") return device.noHover;
  const max = /^\(max-width: (\d+)px\)$/.exec(clause);
  return max !== null && device.width <= Number(max[1]);
}
const mediaMatches = (query: string) => query.split(" and ").every((clause) => clauseHolds(clause.trim()));
function followDefault(this: { value: string }, text: string): void { this.value = text; }
function selectRange(this: { selectionStart: number; selectionEnd: number }, start: number, end: number): void {
  this.selectionStart = start;
  this.selectionEnd = end;
}

const doc = new FakeDocument();
const windowListeners = new Map<string, Set<(e: unknown) => void>>();
const win = {
  document: doc,
  HTMLIFrameElement: FakeIFrame,
  addEventListener: (type: string, fn: (e: unknown) => void) => { windowListeners.set(type, (windowListeners.get(type) ?? new Set()).add(fn)); },
  removeEventListener: (type: string, fn: (e: unknown) => void) => { windowListeners.get(type)?.delete(fn); },
};
let root: Root;
let store: typeof import("../lib/store/store.ts");
let drafts: typeof import("../lib/store/drafts.ts");
let session: typeof import("../lib/session/index.ts");
let Composer: typeof import("./Composer.tsx")["Composer"];
let initial: State;

beforeAll(async () => {
  doc.defaultView = win;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: mediaMatches(q), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb(0), 0));
  Object.assign(FakeElement.prototype, { value: "", selectionStart: 0, selectionEnd: 0, checked: false, setSelectionRange: selectRange });
  Object.defineProperty(FakeElement.prototype, "defaultValue", { configurable: true, set: followDefault });
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  drafts = await import("../lib/store/drafts.ts");
  session = await import("../lib/session/index.ts");
  const composer = await import("./Composer.tsx");
  ({ Composer } = composer);
  composer.watchComposer();
  initial = store.getState();
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
beforeEach(() => {
  Object.assign(device, { coarse: false, noHover: false, width: 1280 });
  doc.activeElement = null;
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.render(null));
  for (const key of ["thread", "a", "b", null]) drafts.clearDraft(key);
  store.setState(initial);
});

const live: LiveTurn = { threadId: "thread", turnId: "turn", model: "qwen3.5:9b", startedAt: 0, thinking: "", text: "Reply", tools: [] };
const ready = (): Partial<State> => ({
  conn: { kind: "open" },
  runtime: { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:5288", version: "test" },
  models: [{ name: "qwen3.5:9b", digest: "test", sizeBytes: 1, modifiedAt: "", capabilities: ["completion", "thinking"] }],
  model: "qwen3.5:9b",
  view: "thread",
  threadId: "thread",
});
const refusing: State["fitTable"] = {
  reading: { boot: "b", seq: 1, measuredAt: 0 }, memory: { kind: "gpu", freeBytes: 0, usableBytes: 0 },
  rows: [{ model: "qwen3.5:9b", numCtx: 16384, freeVramBytes: 0, needVramBytes: 2 ** 30, spillRamBytes: 0, shortfallBytes: 2 ** 30, verdict: "refuse", source: "estimate", stops: [] }],
};
const VOICE_HELD = "Dictate comes back when this reply ends or you finish editing the queued message.";

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
function all(pred: (el: FakeElement) => boolean, from: FakeNode = doc.body): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (pred(c)) out.push(c); walk(c); } };
  walk(from);
  return out;
}
const byTestId = (id: string) => all((el) => el.getAttribute("data-testid") === id)[0] ?? null;
function props(el: FakeElement | null): Record<string, unknown> {
  if (el === null) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
}
async function fire(el: FakeElement | null, handler: string, event: unknown = {}): Promise<void> {
  await act(async () => { (props(el)[handler] as (e: unknown) => void)(event); });
  await settle();
}
async function mount(state: Partial<State> & { draft?: string }, key = "composer"): Promise<void> {
  const { draft, ...patch } = state;
  store.setState({ ...initial, ...patch });
  if (draft !== undefined) drafts.replaceDraft(store.getState().threadId, { text: draft });
  act(() => root.render(createElement(Composer, { key })));
  await settle();
}
async function update(run: () => void): Promise<void> {
  await act(async () => { run(); });
  await settle();
}
const enter = () => ({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn() });
const box = () => byTestId("chat.composer.message");
const sendButton = () => byTestId("chat.composer.send");
const notice = () => byTestId("chat.composer.notice")?.textContent ?? null;
async function dictateShortcut(): Promise<void> {
  const event = { key: " ", code: "Space", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false, preventDefault() {}, stopImmediatePropagation() {} };
  await update(() => { for (const fn of windowListeners.get("keydown") ?? []) fn(event); });
}

it("Enter sends on a large screen that reports a coarse pointer or no hover, as a remote desktop does; only a phone-sized touch screen takes it as a new line", async () => {
  for (const screen of [{ coarse: true, noHover: true, width: 1280 }, { coarse: true, noHover: false, width: 1024 }, { coarse: false, noHover: true, width: 1920 }]) {
    Object.assign(device, screen);
    await mount({ ...ready(), draft: "hello" });
    const key = enter();
    await fire(box(), "onKeyDown", key);
    expect(session.send, JSON.stringify(screen)).toHaveBeenCalledWith("hello");
    expect(key.preventDefault).toHaveBeenCalled();
    vi.mocked(session.send).mockClear();
    act(() => root.render(null));
  }
  Object.assign(device, { coarse: true, noHover: true, width: 390 });
  await mount({ ...ready(), draft: "hello" });
  const key = enter();
  await fire(box(), "onKeyDown", key);
  expect(session.send).not.toHaveBeenCalled();
  expect(key.preventDefault, "the browser types the new line").not.toHaveBeenCalled();
});

it("the first send hands Send's focus to the thread's composer that takes the new chat's place", async () => {
  await mount({ ...ready(), view: "new", threadId: null, draft: "hello" }, "new chat");
  const first = sendButton();
  first?.focus();
  await update(() => {
    store.setState({ view: "thread", threadId: "thread" });
    root.render(createElement(Composer, { key: "thread" }));
  });
  const second = sendButton();
  expect(second).not.toBe(first);
  expect(doc.activeElement).toBe(second);
});

it("a composer that mounts later, not in the same step, does not take Send's focus", async () => {
  await mount(ready(), "first");
  sendButton()?.focus();
  await update(() => root.render(null));
  doc.activeElement = null;
  await mount(ready(), "later");
  expect(doc.activeElement).toBeNull();
});

it("hovering, pressing or arrowing down on the model button loads the picker's code for the mode it opens, and asks the server for nothing", async () => {
  const arrow = { key: "ArrowDown", preventDefault() {} };
  await mount(ready());
  for (const [handler, event] of [["onPointerEnter", {}], ["onPointerDown", {}], ["onKeyDown", arrow]] as const) {
    loads.picker.mockClear();
    await fire(byTestId("chat.composer.model"), handler, event);
    expect(loads.picker, handler).toHaveBeenCalledTimes(1);
  }
  expect(loads.image).not.toHaveBeenCalled();
  act(() => root.render(null));
  await mount({ ...ready(), image: true, settings: { imageGen: true } as never });
  loads.picker.mockClear();
  await fire(byTestId("chat.composer.model"), "onPointerEnter");
  expect(loads.image).toHaveBeenCalledTimes(1);
  expect(loads.picker).not.toHaveBeenCalled();
  expect(session.call).not.toHaveBeenCalled();
});

const focusFrom = (keyboard: boolean) => ({ currentTarget: { matches: (s: string) => s === ":focus" || (keyboard && s === ":focus-visible") } });
it("keyboard focus on the model button loads the picker's code; focus a sheet hands back by script does not", async () => {
  await mount(ready());
  await fire(byTestId("chat.composer.model"), "onFocus", focusFrom(false));
  expect(loads.picker).not.toHaveBeenCalled();
  await fire(byTestId("chat.composer.model"), "onFocus", focusFrom(true));
  expect(loads.picker).toHaveBeenCalledTimes(1);
});

it("the thread screen's code starts loading once the draft holds anything: typed words or an image alone", async () => {
  await mount(ready());
  expect(loads.thread).not.toHaveBeenCalled();
  await fire(box(), "onChange", { target: { value: "h" } });
  expect(loads.thread).toHaveBeenCalled();
  act(() => root.render(null));
  drafts.clearDraft("thread");
  loads.thread.mockClear();
  await mount(ready());
  expect(loads.thread).not.toHaveBeenCalled();
  await update(() => drafts.replaceDraft("thread", { images: ["data:image/png;base64,AAAA"] }));
  expect(loads.thread).toHaveBeenCalled();
});

it("the note that Dictate comes back goes once Dictate is back, whether the reply ended or the edit did", async () => {
  const editing = { ...ready(), turns: { thread: live }, editingQueued: "q1", replies: repliesOf([{ id: "q1", threadId: "thread", text: "queued", waitFor: "reply" }]) };
  await mount(editing);
  await update(() => store.setState({ notice: VOICE_HELD }));
  await update(() => store.setState({ turns: { thread: { ...live, end: { kind: "stopped", secs: 1 } } } }));
  expect(store.getState().notice, "the reply ended").toBeNull();
  act(() => root.render(null));
  await mount(editing);
  await update(() => store.setState({ notice: VOICE_HELD }));
  await update(() => store.setState({ editingQueued: null }));
  expect(store.getState().notice, "the edit ended").toBeNull();
});

it("Enter with words typed and Send off opens the memory panel on a memory refusal, and otherwise shows Send's reason at Send", async () => {
  await mount({ ...ready(), fitTable: refusing, draft: "Too big" });
  await fire(box(), "onKeyDown", enter());
  expect(fit.open).toHaveBeenCalledTimes(1);
  expect(session.send).not.toHaveBeenCalled();
  act(() => root.render(null));
  await mount({ ...ready(), conn: { kind: "down", since: 0 }, draft: "hello" });
  await fire(box(), "onKeyDown", enter());
  expect(fit.tip).toHaveBeenCalledWith(sendButton());
  expect(session.send).not.toHaveBeenCalled();
});

it("while Stop holds Send's place, Enter puts Send's reason in the note over the box, and the next edit clears it", async () => {
  await mount({ ...ready(), turns: { thread: live }, pasting: 1, draft: "next" });
  expect(notice()).toBeNull();
  await fire(box(), "onKeyDown", enter());
  expect(notice()).toBe("Attaching…");
  await fire(box(), "onChange", { target: { value: "next words" } });
  expect(notice()).toBeNull();
});

it("talk mode's send, made after the transcript is drawn, follows Send's latest judgement of the draft", async () => {
  await mount(ready());
  const talkSend = voice.send;
  await update(() => drafts.replaceDraft("thread", { text: "spoken words" }));
  await update(() => talkSend?.());
  expect(session.send).toHaveBeenCalledWith("spoken words");
  vi.mocked(session.send).mockClear();
  await update(() => store.setState({ conn: { kind: "down", since: 0 } }));
  await update(() => talkSend?.());
  expect(session.send, "Send went off").not.toHaveBeenCalled();
});

const editingDuringReply = () => ({ ...ready(), turns: { thread: live }, editingQueued: "q1", replies: repliesOf([{ id: "q1", threadId: "thread", text: "queued", waitFor: "reply" }]) });
it("while Stop holds Dictate's square during a queued edit, Dictate's shortcut still answers", async () => {
  await mount(editingDuringReply());
  expect(byTestId("chat.composer.stop-square")).not.toBeNull();
  expect(byTestId("chat.composer.dictate")).toBeNull();
  await dictateShortcut();
  expect(notice()).toBe(VOICE_HELD);
});

it("Ctrl+Shift+Space while Stop holds Dictate's square says Dictate comes back when the reply ends or the edit is finished, and only then", async () => {
  await mount(editingDuringReply());
  await dictateShortcut();
  expect(notice()).toBe(VOICE_HELD);
  act(() => root.render(null));
  await mount({ ...editingDuringReply(), turns: {} });
  await dictateShortcut();
  expect(notice()).not.toBe(VOICE_HELD);
});

it("a draft opens with the caret at the end of its words", async () => {
  drafts.replaceDraft("b", { text: "Restored words" });
  await mount({ ...ready(), threadId: "a" });
  await update(() => store.setState({ threadId: "b" }));
  const ta = box() as unknown as { value: string; selectionStart: number; selectionEnd: number };
  expect(ta.value).toBe("Restored words");
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([14, 14]);
});

it("Send now, Edit, Remove and Cancel editing on a queued row leave the typing cursor in the message box", async () => {
  const rows = repliesOf([{ id: "q1", threadId: "thread", text: "first", waitFor: "reply" }, { id: "q2", threadId: "thread", text: "second", waitFor: "reply" }]);
  for (const [id, editingQueued] of [["chat.queue.send-now-1", null], ["chat.queue.edit-1", null], ["chat.queue.remove-1", null], ["chat.queue.cancel-edit-2", "q2"]] as const) {
    await mount({ ...ready(), turns: { thread: live }, replies: rows, editingQueued });
    const button = byTestId(id);
    button?.focus();
    await fire(button, "onClick", { detail: 1, preventDefault() {} });
    expect(doc.activeElement, id).toBe(box());
    act(() => root.render(null));
  }
});

const stopAsk = (): NonNullable<State["stopAsk"]> => ({ blocking: [{ threadId: "other", title: "Trip plans", model: "qwen3.5:9b" }], content: "hello", model: "qwen3.5:9b", threadId: "thread", keepDraft: true });
it("a new stop warning starts with Don't show this again unticked, even after the last one was ticked", async () => {
  await mount({ ...ready(), stopAsk: stopAsk(), draft: "hello" });
  await fire(byTestId("chat.stop-warning.never"), "onChange", { target: { checked: true } });
  expect(props(byTestId("chat.stop-warning.never"))["checked"]).toBe(true);
  await update(() => store.setState({ stopAsk: stopAsk() }));
  expect(props(byTestId("chat.stop-warning.never"))["checked"]).toBe(false);
  await fire(byTestId("chat.stop-warning.confirm"), "onClick", { detail: 1 });
  expect(session.confirmStopAsk).toHaveBeenCalledWith(false);
});

it("a held Enter carried over from the message box does not answer the stop warning; a fresh Enter still can", async () => {
  await mount({ ...ready(), stopAsk: stopAsk(), draft: "hello" });
  const held = { key: "Enter", repeat: true, preventDefault: vi.fn() };
  await fire(byTestId("chat.stop-warning.dialog"), "onKeyDown", held);
  expect(held.preventDefault).toHaveBeenCalled();
  const fresh = { key: "Enter", repeat: false, preventDefault: vi.fn() };
  await fire(byTestId("chat.stop-warning.dialog"), "onKeyDown", fresh);
  expect(fresh.preventDefault).not.toHaveBeenCalled();
});
