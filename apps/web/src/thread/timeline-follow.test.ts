import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Message } from "@gates-local/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LiveTurn } from "../lib/store/store.ts";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

const session = vi.hoisted(() => ({
  unloaded: {} as Record<string, number>,
  loadEarlier: (async () => false) as (threadId: string) => Promise<boolean>,
}));
vi.mock("../lib/session/index.ts", () => ({
  cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: () => "/f",
  loadEarlier: (threadId: string) => session.loadEarlier(threadId),
  earlierOf: (threadId: string) => session.unloaded[threadId] ?? 0,
  onEarlier: () => () => undefined,
}));

type Listener = (event: unknown) => void;
const handlers = new WeakMap<object, Map<string, Set<Listener>>>();
function addListener(this: FakeElement, type: string, fn: unknown): void {
  if (typeof fn !== "function") return;
  let byType = handlers.get(this);
  if (byType === undefined) {
    byType = new Map();
    handlers.set(this, byType);
  }
  let set = byType.get(type);
  if (set === undefined) {
    set = new Set();
    byType.set(type, set);
  }
  set.add(fn as Listener);
}
function removeListener(this: FakeElement, type: string, fn: unknown): void {
  handlers.get(this)?.get(type)?.delete(fn as Listener);
}
const fire = (target: FakeElement, type: string, event: object = {}) => act(() => {
  for (const fn of handlers.get(target)?.get(type) ?? []) fn({ type, ...event });
});

const NOT = /:not\(\.([\w-]+)\)/g;
function nearest(node: FakeNode | null, selector: string): FakeElement | null {
  if (!(node instanceof FakeElement)) return null;
  const negated = [...selector.matchAll(NOT)].map((m) => m[1] ?? "");
  const classes = node.classList;
  return node.matches(selector.replace(NOT, "")) && negated.every((c) => !classes.includes(c)) ? node : nearest(node.parentNode, selector);
}
function closestWithNot(this: FakeElement, selector: string): FakeElement | null {
  return nearest(this, selector);
}
function previousElement(this: FakeElement): FakeNode | null {
  let n = this.previousSibling;
  while (n !== null && !(n instanceof FakeElement)) n = n.previousSibling;
  return n;
}

const observers = new Set<() => void>();
class FakeResizeObserver {
  readonly #fn: () => void;
  constructor(fn: () => void) { this.#fn = fn; }
  observe() { observers.add(this.#fn); }
  unobserve() {}
  disconnect() { observers.delete(this.#fn); }
}
class FakeKeyboardEvent { readonly key: string = ""; }

let clock = 0;
let frames: FrameRequestCallback[] = [];
const requestAnimationFrame = (fn: FrameRequestCallback) => frames.push(fn);
const idle: { run: IdleRequestCallback; timeout: number | undefined }[] = [];
const requestIdleCallback = (fn: IdleRequestCallback, options?: IdleRequestOptions) => idle.push({ run: fn, timeout: options?.timeout });
const matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

const doc = new FakeDocument();
let root: Root;
let store: typeof import("../lib/store/store.ts");
let Timeline: typeof import("./Thread.tsx")["Timeline"];
const closestWas = Object.getOwnPropertyDescriptor(FakeElement.prototype, "closest");

beforeAll(async () => {
  const win = { document: doc, HTMLIFrameElement: FakeIFrame, matchMedia, requestIdleCallback, cancelIdleCallback() {}, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = win;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("matchMedia", matchMedia);
  vi.stubGlobal("requestIdleCallback", requestIdleCallback);
  vi.stubGlobal("cancelIdleCallback", () => {});
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  Object.defineProperty(FakeElement.prototype, "addEventListener", { configurable: true, value: addListener });
  Object.defineProperty(FakeElement.prototype, "removeEventListener", { configurable: true, value: removeListener });
  Object.defineProperty(FakeElement.prototype, "closest", { configurable: true, value: closestWithNot });
  Object.defineProperty(FakeElement.prototype, "previousElementSibling", { configurable: true, get: previousElement });
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  ({ Timeline } = await import("./Thread.tsx"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(FakeElement.prototype, "addEventListener");
  Reflect.deleteProperty(FakeElement.prototype, "removeEventListener");
  Reflect.deleteProperty(FakeElement.prototype, "previousElementSibling");
  if (closestWas !== undefined) Object.defineProperty(FakeElement.prototype, "closest", closestWas);
});
afterEach(() => {
  act(() => root.render(null));
  FakeElement.topOf = null;
  frames = [];
  idle.length = 0;
  clock = 0;
  session.unloaded = {};
  session.loadEarlier = async () => false;
});

const said = (prefix: string, threadId: string, n: number): Message[] => Array.from({ length: n }, (_, i): Message => i % 2 === 0
  ? { id: `${prefix}${i}`, threadId, role: "user", createdAt: i, content: `Question ${prefix}${i}` }
  : { id: `${prefix}${i}`, threadId, role: "assistant", createdAt: i, content: `Answer ${prefix}${i}`, model: "m" });
const finished = (threadId: string): Message[] =>
  [...said("q", threadId, 5), { id: "last", threadId, role: "assistant", createdAt: 9, content: "The full answer.", thinking: "Weighing it", model: "m" }];
const writing = (threadId: string): LiveTurn =>
  ({ threadId, turnId: "turn", userMessageId: "q4", model: "m", startedAt: 1, thinking: "Weighing it", text: "So far", tools: [] });

function open(threadId: string, messages: Message[], live?: LiveTurn) {
  act(() => store.setState({ messages: { [threadId]: messages }, turns: live === undefined ? {} : { [threadId]: live }, catalog: [] }));
  act(() => root.render(createElement(Timeline, { threadId })));
}
const turns = () => doc.body.querySelectorAll(".turn");
const one = (selector: string): FakeElement => {
  const el = doc.body.querySelectorAll(selector).at(-1);
  if (el === undefined) throw new Error(`no ${selector}`);
  return el;
};

const placed = new Map<FakeElement, number>();
function view(height: number, content: number): FakeElement {
  const tl = one(".tl");
  let top = 0;
  Object.defineProperty(tl, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, tl.scrollHeight - tl.clientHeight)); } });
  tl.clientHeight = height;
  tl.scrollHeight = content;
  placed.clear();
  FakeElement.topOf = (el) => {
    const at = placed.get(el);
    return at === undefined ? 0 : at - tl.scrollTop;
  };
  return tl;
}
const fromEnd = (tl: FakeElement) => tl.scrollHeight - tl.scrollTop - tl.clientHeight;
const readerAt = (tl: FakeElement, distance: number) => {
  tl.scrollTop = tl.scrollHeight - tl.clientHeight - distance;
  fire(tl, "scroll");
};
const grows = (tl: FakeElement, by: number) => {
  tl.scrollHeight += by;
  act(() => { for (const fn of observers) fn(); });
};
const frame = () => act(() => {
  const now = frames;
  frames = [];
  for (const fn of now) fn(clock);
});
const toggle = (disclosure: FakeElement, at: number) => {
  placed.set(disclosure, at);
  fire(one(".col"), "click", { target: disclosure });
};
const viewTop = (el: FakeElement) => el.getBoundingClientRect().top;

describe("following the end", () => {
  it("follows new content while the reader is less than 120 px from the end, and stays put from 120 px up", () => {
    open("near", finished("near"));
    const tl = view(1000, 5000);
    readerAt(tl, 119);
    grows(tl, 300);
    expect(fromEnd(tl), "119 px from the end: the page follows").toBe(0);
    readerAt(tl, 120);
    const top = tl.scrollTop;
    grows(tl, 300);
    expect(tl.scrollTop, "120 px from the end: the page stays where the reader is").toBe(top);
  });

  it("after the reader opens or closes something in a finished reply, the page follows the end only from exactly the end", () => {
    open("done-toggle", finished("done-toggle"));
    const tl = view(1000, 5000);
    const fold = one('[data-testid="chat.fold.toggle"]');
    readerAt(tl, 50);
    toggle(fold, 4400);
    clock = 401;
    frame();
    grows(tl, 300);
    expect(fromEnd(tl), "50 px from the end, near enough before the toggle, is not the end").toBe(350);
    readerAt(tl, 0);
    clock = 500;
    toggle(fold, 4700);
    clock = 901;
    frame();
    grows(tl, 300);
    expect(fromEnd(tl), "at the end itself the page follows").toBe(0);
  });

  it("a disclosure opened in a reply still being written keeps the page following near the end", () => {
    open("live-toggle", said("q", "live-toggle", 5), writing("live-toggle"));
    const tl = view(1000, 5000);
    const fold = one('[data-testid="chat.fold.toggle"]');
    expect(fold.closest(".turn")?.classList, "the fold is in the reply being written").not.toContain("done");
    readerAt(tl, 50);
    toggle(fold, 4400);
    clock = 401;
    frame();
    grows(tl, 300);
    expect(fromEnd(tl)).toBe(0);
  });
});

describe("a disclosure's hold", () => {
  it("a disclosure the reader opens or closes in a finished reply stays where it was through its ease: the page neither follows nor shifts under it", () => {
    open("hold", finished("hold"));
    const tl = view(1000, 5000);
    const fold = one('[data-testid="chat.fold.toggle"]');
    readerAt(tl, 0);
    toggle(fold, 4500);
    const top = viewTop(fold);
    grows(tl, 300);
    expect(viewTop(fold), "opened at the end: its body grows below it and the page does not follow").toBe(top);
    placed.set(fold, 4530);
    tl.scrollHeight += 30;
    frame();
    expect(viewTop(fold), "what grows above it during the ease does not move it").toBe(top);
    clock = 100;
    toggle(fold, 4530);
    grows(tl, -300);
    frame();
    expect(viewTop(fold), "closed again: it stays where it was").toBe(top);
  });

  it("a scroll the timeline made itself during a hold is not the reader's: the hold goes on", () => {
    open("own", finished("own"));
    const tl = view(1000, 5000);
    const fold = one('[data-testid="chat.fold.toggle"]');
    readerAt(tl, 0);
    toggle(fold, 4500);
    const top = viewTop(fold);
    placed.set(fold, 4560);
    tl.scrollHeight += 60;
    frame();
    expect(viewTop(fold)).toBe(top);
    fire(tl, "scroll");
    placed.set(fold, 4600);
    tl.scrollHeight += 40;
    frame();
    expect(viewTop(fold), "the hold still keeps the disclosure still after its own scroll").toBe(top);
  });

  it("a scroll the reader makes during a hold lets go of it, and following near the end resumes", () => {
    open("let-go", finished("let-go"));
    const tl = view(1000, 5000);
    const fold = one('[data-testid="chat.fold.toggle"]');
    readerAt(tl, 0);
    toggle(fold, 4500);
    readerAt(tl, 50);
    const top = tl.scrollTop;
    placed.set(fold, 4560);
    tl.scrollHeight += 60;
    frame();
    expect(tl.scrollTop, "the hold no longer moves the page").toBe(top);
    grows(tl, 0);
    expect(fromEnd(tl), "50 px from the end follows again").toBe(0);
  });

  it("when a disclosure's ease ends, the page follows again only if it is still at the end", () => {
    open("ease-end", finished("ease-end"));
    const tl = view(1000, 5000);
    const fold = one('[data-testid="chat.fold.toggle"]');
    readerAt(tl, 0);
    toggle(fold, 4500);
    grows(tl, 300);
    clock = 401;
    frame();
    const top = tl.scrollTop;
    grows(tl, 300);
    expect(tl.scrollTop, "the opened body pushed the end away: no following").toBe(top);
    readerAt(tl, 0);
    clock = 500;
    toggle(fold, 4800);
    clock = 901;
    frame();
    grows(tl, 300);
    expect(fromEnd(tl), "still at the end when the ease ends: following").toBe(0);
  });

  it("a disclosure that leaves the page ends its hold at once, and the page at the end follows again", () => {
    const messages = finished("gone");
    open("gone", messages);
    const tl = view(1000, 5000);
    const fold = one('[data-testid="chat.fold.toggle"]');
    readerAt(tl, 0);
    toggle(fold, 4500);
    act(() => store.setState({ messages: { gone: messages.slice(0, -1) } }));
    expect(fold.isConnected).toBe(false);
    clock = 100;
    frame();
    grows(tl, 300);
    expect(fromEnd(tl)).toBe(0);
  });
});

function deferred() {
  let resolved: ((came: boolean) => void) | undefined;
  const promise = new Promise<boolean>((resolve) => { resolved = resolve; });
  return { promise, settle: (came: boolean) => resolved?.(came) };
}
const press = (button: FakeElement) => {
  const key = Object.keys(button).find((k) => k.startsWith("__reactProps$"));
  const props = key === undefined ? undefined : (button as unknown as Record<string, { onClick?: () => void }>)[key];
  act(() => props?.onClick?.());
};
async function loadPageWith(threadId: string, second: Message): Promise<void> {
  const loaded = said("m", threadId, 200);
  const page = said("e", threadId, 201).map((m, i) => (i === 1 ? second : m));
  session.unloaded[threadId] = 201;
  const gate = deferred();
  session.loadEarlier = () => gate.promise;
  open(threadId, loaded);
  press(one('[data-testid="chat.thread.earlier"]'));
  await act(async () => {
    store.setState({ messages: { [threadId]: [...page, ...loaded] } });
    session.unloaded[threadId] = 0;
    gate.settle(true);
    await gate.promise;
  });
}

describe("the window", () => {
  it("a slice of a long thread waits at most 100 ms for an idle moment", () => {
    open("idle", said("m", "idle", 2000));
    act(() => idle.at(-1)?.run({ didTimeout: true, timeRemaining: () => 0 }));
    expect(idle.length, "a slice was asked for after the first").toBeGreaterThan(1);
    expect(idle.map((i) => i.timeout)).toEqual(idle.map(() => 100));
  });

  it("an earlier page steps the window back to a reply, keyed by the question it answers", async () => {
    await loadPageWith("reply-key", { id: "e1", threadId: "reply-key", role: "assistant", createdAt: 1, content: "Answer to the first question", model: "m" });
    expect(turns().length, "the window starts 200 before the turn that was first").toBe(400);
    expect(turns()[0]?.textContent).toContain("Answer to the first question");
  });

  it("an earlier page steps the window back to an image card, keyed by its own id", async () => {
    await loadPageWith("image-key", { id: "e1", threadId: "image-key", role: "assistant", createdAt: 1, content: "a lighthouse", imageJob: { jobId: "e1", threadId: "image-key", state: "queued" } });
    expect(turns().length, "the window starts 200 before the turn that was first").toBe(400);
  });

  it("an earlier page that arrives after the reader went to another thread steps nothing in the thread they are reading", async () => {
    const away = said("m", "away", 200);
    const other = said("o", "other", 2000);
    session.unloaded.away = 201;
    const gate = deferred();
    session.loadEarlier = () => gate.promise;
    act(() => store.setState({ messages: { away, other }, turns: {}, catalog: [] }));
    act(() => root.render(createElement(Timeline, { threadId: "away" })));
    press(one('[data-testid="chat.thread.earlier"]'));
    act(() => root.render(createElement(Timeline, { threadId: "other" })));
    const reading = [...turns()];
    expect(reading.length).toBe(40);
    await act(async () => {
      store.setState({ messages: { away: [...said("e", "away", 201), ...away], other } });
      session.unloaded.away = 0;
      gate.settle(true);
      await gate.promise;
    });
    expect(turns().length, "the thread being read keeps the turns it had").toBe(40);
    expect(turns().every((el, i) => el === reading[i]), "the same turns, the same elements").toBe(true);
  });
});
