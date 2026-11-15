// The kit's hooks mounted for real (react-dom on the fake DOM), each held to its one promise.
import { act, createElement, useLayoutEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame } from "../../../../test/fake-dom.ts";

const doc = new FakeDocument();
type Listener = { type: string; fn: (e: Event) => void; capture: boolean };
const docListeners: Listener[] = [];
/** The listeners this test attaches; React keeps its own on the document too. */
const mine = () => docListeners.filter((l) => l.type === "pointerdown" || l.type === "keydown");
let root: Root;
let kit: {
  now: typeof import("./now.ts");
  flash: typeof import("./flash.ts");
  frame: typeof import("./frame.ts");
  events: typeof import("./events.ts");
  popover: typeof import("./popover.ts");
  focus: typeof import("./focus.ts");
};
let store: typeof import("../../store/store.ts");
let frames: FrameRequestCallback[] = [];

beforeAll(async () => {
  const win = { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = win;
  Object.assign(doc, {
    addEventListener: (type: string, fn: (e: Event) => void, o?: boolean | AddEventListenerOptions) => { docListeners.push({ type, fn, capture: typeof o === "object" ? o.capture === true : o === true }); },
    removeEventListener: (type: string, fn: (e: Event) => void) => { const i = docListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) docListeners.splice(i, 1); },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = () => undefined; });
  const { createRoot } = await import("react-dom/client");
  kit = {
    now: await import("./now.ts"),
    flash: await import("./flash.ts"),
    frame: await import("./frame.ts"),
    events: await import("./events.ts"),
    popover: await import("./popover.ts"),
    focus: await import("./focus.ts"),
  };
  store = await import("../../store/store.ts");
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); frames = []; });
afterEach(() => { act(() => root.render(null)); vi.useRealTimers(); });
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

const runFrames = (t = 0) => { const now = frames; frames = []; for (const f of now) f(t); };

it("two readers of the same interval share one timer, and it stops when the last unmounts", () => {
  const seen: number[] = [];
  const Reader = ({ ms }: { ms: number }) => { seen.push(kit.now.useNow(ms)); return null; };
  act(() => root.render(createElement("div", null, createElement(Reader, { ms: 30_000 }), createElement(Reader, { ms: 30_000 }))));
  expect(kit.now.clockCount()).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  seen.length = 0;
  act(() => vi.advanceTimersByTime(30_000));
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(seen[1]);
  act(() => root.render(null));
  expect(kit.now.clockCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("a reader that is off leaves the clock and keeps the last time it read; on again, it rejoins", () => {
  const seen: number[] = [];
  const Reader = ({ on }: { on: boolean }) => { seen.push(kit.now.useNow(250, on)); return null; };
  act(() => root.render(createElement(Reader, { on: true })));
  act(() => vi.advanceTimersByTime(250));
  const last = seen.at(-1)!;
  act(() => root.render(createElement(Reader, { on: false })));
  expect(kit.now.clockCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  seen.length = 0;
  act(() => vi.advanceTimersByTime(1000));
  expect(seen).toEqual([]);
  act(() => root.render(createElement(Reader, { on: false })));
  expect(seen).toEqual([last]);
  act(() => root.render(createElement(Reader, { on: true })));
  expect(kit.now.clockCount()).toBe(1);
  act(() => vi.advanceTimersByTime(250));
  expect(seen.at(-1)).toBe(last + 1250);
});

it("a flash clears itself, a value that stays does not, and an unmounted flash never fires", () => {
  let set: ((v: string | null) => void) | undefined;
  const shown: (string | null)[] = [];
  const Flash = () => { const [v, s] = kit.flash.useFlash<string>(1500, (x) => x === "failed"); set = s; shown.push(v); return null; };
  act(() => root.render(createElement(Flash)));
  expect(set).toBeDefined();
  act(() => set?.("ok"));
  expect(shown.at(-1)).toBe("ok");
  act(() => vi.advanceTimersByTime(1499));
  expect(shown.at(-1)).toBe("ok");
  act(() => vi.advanceTimersByTime(1));
  expect(shown.at(-1)).toBeNull();
  act(() => set?.("failed"));
  act(() => vi.advanceTimersByTime(10_000));
  expect(shown.at(-1)).toBe("failed");
  act(() => set?.("ok"));
  act(() => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
});

it("a frame loop ticks while active and stops when its tick says so or it turns off", () => {
  const ticks: number[] = [];
  let limit = 3;
  const Loop = ({ on }: { on: boolean }) => { kit.frame.useAnimationFrame((t) => { ticks.push(t); return ticks.length < limit; }, on); return null; };
  act(() => root.render(createElement(Loop, { on: true })));
  for (let i = 1; i <= 5; i++) runFrames(i);
  expect(ticks).toEqual([1, 2, 3]);
  limit = 99;
  act(() => root.render(createElement(Loop, { on: false })));
  act(() => root.render(createElement(Loop, { on: true })));
  runFrames(10);
  act(() => root.render(createElement(Loop, { on: false })));
  runFrames(11);
  expect(ticks).toEqual([1, 2, 3, 10]);
});

it("a document listener follows the newest handler, attaches only while wanted, and a press outside dismisses", () => {
  const calls: string[] = [];
  const box = doc.createElement("div");
  const Menu = ({ open, name }: { open: boolean; name: string }) => {
    const ref = useRef<HTMLElement | null>(box as unknown as HTMLElement);
    kit.events.useDismiss(ref, open, () => calls.push(`close ${name}`));
    kit.events.useDocumentEvent("keydown", () => calls.push(`key ${name}`), { capture: true, when: open });
    return null;
  };
  act(() => root.render(createElement(Menu, { open: false, name: "a" })));
  expect(mine()).toHaveLength(0);
  act(() => root.render(createElement(Menu, { open: true, name: "a" })));
  expect(mine().map((l) => `${l.type}:${l.capture}`).toSorted()).toEqual(["keydown:true", "pointerdown:false"]);
  act(() => root.render(createElement(Menu, { open: true, name: "b" })));
  expect(mine()).toHaveLength(2);
  const fire = (type: string, target: unknown) => { for (const l of mine().filter((x) => x.type === type)) l.fn({ target } as unknown as Event); };
  fire("pointerdown", box);
  fire("pointerdown", doc.body);
  fire("keydown", box);
  expect(calls).toEqual(["close b", "key b"]);
  act(() => root.render(createElement(Menu, { open: false, name: "b" })));
  expect(mine()).toHaveLength(0);
});

it("a pop-up is placed before paint while open, only when a dependency changes", () => {
  const placed: string[] = [];
  const Pop = ({ open, at }: { open: boolean; at: number }) => {
    const ref = useRef<HTMLElement | null>(doc.createElement("div") as unknown as HTMLElement);
    kit.popover.usePopover(ref, open, () => placed.push(`at ${at}`), [at]);
    return null;
  };
  act(() => root.render(createElement(Pop, { open: false, at: 1 })));
  act(() => root.render(createElement(Pop, { open: true, at: 1 })));
  act(() => root.render(createElement(Pop, { open: true, at: 1 })));
  act(() => root.render(createElement(Pop, { open: true, at: 2 })));
  expect(placed).toEqual(["at 1", "at 2"]);
});

it("state reset on a change happens in the same render, never on the first", () => {
  const commits: string[] = [];
  const Ask = ({ drawer }: { drawer: boolean }) => {
    const [asking, setAsking] = useState(true);
    kit.popover.useChange(drawer, (now) => { if (!now) setAsking(false); });
    useLayoutEffect(() => { commits.push(`${drawer}/${asking}`); });
    return null;
  };
  act(() => root.render(createElement(Ask, { drawer: false })));
  act(() => root.render(createElement(Ask, { drawer: true })));
  act(() => root.render(createElement(Ask, { drawer: false })));
  // the render that saw drawer false again is redone with asking false before anything commits
  expect(commits).toEqual(["false/true", "true/true", "false/false"]);
});

it("a focus request runs after the commit that draws its node, in order, and once more a frame later when the node is missing", () => {
  const focused: string[] = [];
  const node = (name: string) => ({ focus: () => focused.push(name) }) as unknown as HTMLElement;
  let drawn: HTMLElement | null = null;
  const Target = () => { const show = store.useStore((s) => s.drawer); drawn = show ? node("search") : null; return null; };
  act(() => root.render(createElement("div", null, createElement(Target), createElement(kit.focus.CommitJobs))));
  act(() => {
    store.setState({ drawer: true });
    kit.focus.requestFocus(() => drawn);
    kit.focus.requestFocus(() => node("second"));
  });
  expect(focused).toEqual(["search", "second"]);
  expect(store.getState().afterCommit).toHaveLength(0);
  let later: HTMLElement | null = null;
  act(() => kit.focus.requestFocus(() => later));
  expect(focused).toEqual(["search", "second"]);
  later = node("late");
  runFrames();
  expect(focused).toEqual(["search", "second", "late"]);
  runFrames();
  expect(focused).toHaveLength(3);
  act(() => store.setState({ drawer: false }));
});

it("a focus-on-draw ref focuses its node once as it is drawn, never again on a later render", () => {
  const focused: string[] = [];
  vi.spyOn(FakeElement.prototype, "focus").mockImplementation(function (this: FakeElement) { focused.push(this.getAttribute("class") ?? ""); });
  const menu = kit.focus.focusFirstOf(".chosen", ".item");
  const Menu = ({ chosen, n }: { chosen: boolean; n: number }) =>
    createElement("div", { ref: menu, "data-n": n }, createElement("span", { className: "item" }), createElement("span", { className: chosen ? "chosen" : "other" }));
  const Button = ({ n }: { n: number }) => createElement("button", { ref: kit.focus.focusOnDraw, className: "close", "data-n": n });
  act(() => root.render(createElement(Menu, { chosen: true, n: 1 })));
  act(() => root.render(createElement(Menu, { chosen: true, n: 2 })));
  expect(focused).toEqual(["chosen"]);
  act(() => root.render(null));
  act(() => root.render(createElement(Menu, { chosen: false, n: 1 })));
  expect(focused).toEqual(["chosen", "item"]);
  act(() => root.render(createElement(Button, { n: 1 })));
  act(() => root.render(createElement(Button, { n: 2 })));
  expect(focused).toEqual(["chosen", "item", "close"]);
  vi.restoreAllMocks();
});

it("a focus request with nothing drawing still runs a frame later, once, and leaves the queue empty", () => {
  const focused: string[] = [];
  kit.focus.requestFocus(() => ({ focus: () => focused.push("alone") }) as unknown as HTMLElement);
  expect(focused).toEqual([]);
  runFrames();
  expect(focused).toEqual(["alone"]);
  expect(store.getState().afterCommit).toHaveLength(0);
  runFrames();
  expect(focused).toEqual(["alone"]);
});
