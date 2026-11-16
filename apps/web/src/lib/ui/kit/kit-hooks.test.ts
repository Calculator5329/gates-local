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
  watch: typeof import("./watch.ts");
  async: typeof import("./async.ts");
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
    watch: await import("./watch.ts"),
    async: await import("./async.ts"),
  };
  store = await import("../../store/store.ts");
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); frames = []; });
afterEach(() => { act(() => root.render(null)); vi.useRealTimers(); });
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

const WindowWatch = () => { kit.events.useDocumentEvent("keydown", () => undefined, { on: "window" }); return null; };
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

it("a listener asked for on the window attaches to the window, not the document, and leaves it on unmount", () => {
  const added = vi.spyOn(window, "addEventListener");
  const removed = vi.spyOn(window, "removeEventListener");
  act(() => root.render(createElement(WindowWatch)));
  expect(added.mock.calls.map(([type]) => type)).toEqual(["keydown"]);
  expect(mine()).toHaveLength(0);
  act(() => root.render(null));
  expect(removed.mock.calls.map(([type]) => type)).toEqual(["keydown"]);
  expect(removed.mock.calls[0]?.[1]).toBe(added.mock.calls[0]?.[1]);
  vi.restoreAllMocks();
});

it("a reader that joins a running clock starts from the time it mounted, never an older one", () => {
  const seen: { name: string; at: number }[] = [];
  const Reader = ({ name }: { name: string }) => { seen.push({ name, at: kit.now.useNow(30_000) }); return null; };
  act(() => root.render(createElement("div", null, createElement(Reader, { key: "a", name: "a" }))));
  const first = seen.find((s) => s.name === "a")!.at;
  act(() => vi.advanceTimersByTime(10_000));
  const joined = Date.now();
  act(() => root.render(createElement("div", null, createElement(Reader, { key: "a", name: "a" }), createElement(Reader, { key: "b", name: "b" }))));
  expect(kit.now.clockCount()).toBe(1);
  expect(joined).toBe(first + 10_000);
  expect(seen.find((s) => s.name === "b")!.at).toBe(joined);
});

it("a pop-up with nothing to watch is placed after every commit while open, and never while closed", () => {
  const placed: number[] = [];
  const Pop = ({ open, n }: { open: boolean; n: number }) => {
    const ref = useRef<HTMLElement | null>(doc.createElement("div") as unknown as HTMLElement);
    kit.popover.usePopover(ref, open, () => placed.push(n));
    return null;
  };
  act(() => root.render(createElement(Pop, { open: false, n: 1 })));
  act(() => root.render(createElement(Pop, { open: false, n: 2 })));
  expect(placed).toEqual([]);
  act(() => root.render(createElement(Pop, { open: true, n: 3 })));
  act(() => root.render(createElement(Pop, { open: true, n: 4 })));
  act(() => root.render(createElement(Pop, { open: true, n: 5 })));
  act(() => root.render(createElement(Pop, { open: false, n: 6 })));
  expect(placed).toEqual([3, 4, 5]);
});

it("a frame loop asks for one frame at a time, stops when its step says so, and a stop drops the frame it asked for", () => {
  const times: number[] = [];
  kit.frame.frameLoop((t) => { times.push(t); return t < 2; });
  expect(frames).toHaveLength(1);
  runFrames(1);
  expect(frames).toHaveLength(1);
  runFrames(2);
  expect(frames).toHaveLength(0);
  expect(times).toEqual([1, 2]);
  const other = vi.fn(() => true);
  const stop = kit.frame.frameLoop(other);
  runFrames(3);
  expect(other).toHaveBeenCalledTimes(1);
  stop();
  runFrames(4);
  expect(other).toHaveBeenCalledTimes(1);
});

it("a watch hears each new value once with the one before it, never a write that leaves it the same, and nothing after its stop", () => {
  store.setState({ view: "new" });
  const heard: string[] = [];
  const stop = kit.watch.watch((s) => s.view, (now, before) => heard.push(`${before}>${now}`));
  store.setState({ view: "new", setList: true });
  store.setState({ view: "settings" });
  store.setState({ setList: false });
  store.setState({ view: "thread" });
  expect(heard).toEqual(["new>settings", "settings>thread"]);
  stop();
  store.setState({ view: "new" });
  expect(heard).toEqual(["new>settings", "settings>thread"]);
});

it("every puts a plain function on the shared clock, and its stop takes it off", () => {
  const ticks = vi.fn();
  const stop = kit.now.every(6_000, ticks);
  expect(kit.now.clockCount()).toBe(1);
  vi.advanceTimersByTime(12_000);
  expect(ticks).toHaveBeenCalledTimes(2);
  stop();
  expect(kit.now.clockCount()).toBe(0);
  vi.advanceTimersByTime(12_000);
  expect(ticks).toHaveBeenCalledTimes(2);
});

it("after a key arrives or changes, the wait is on for ms, then off; no key is never past, and a key at mount waits too", () => {
  const seen: boolean[] = [];
  const After = ({ k }: { k: number | null }) => { seen.push(kit.flash.useAfter(1000, k)); return null; };
  act(() => root.render(createElement(After, { k: 1 })));
  expect(seen.at(-1), "a key at mount waits").toBe(false);
  act(() => vi.advanceTimersByTime(999));
  expect(seen.at(-1)).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(seen.at(-1)).toBe(true);
  act(() => root.render(createElement(After, { k: 2 })));
  expect(seen.at(-1), "a change starts the wait again").toBe(false);
  act(() => vi.advanceTimersByTime(600));
  act(() => root.render(createElement(After, { k: 3 })));
  act(() => vi.advanceTimersByTime(600));
  expect(seen.at(-1), "the newest change sets when it ends").toBe(false);
  act(() => vi.advanceTimersByTime(400));
  expect(seen.at(-1)).toBe(true);
  act(() => root.render(createElement(After, { k: null })));
  expect(seen.at(-1)).toBe(false);
  act(() => vi.advanceTimersByTime(5000));
  expect(seen.at(-1), "no key is never past").toBe(false);
  act(() => root.render(createElement(After, { k: 4 })));
  act(() => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
});

it("no render reads a wait as past before its time, not even the one where the key arrives or changes", () => {
  const seen: boolean[] = [];
  const After = ({ k }: { k: number | null }) => { seen.push(kit.flash.useAfter(1000, k)); return null; };
  act(() => root.render(createElement(After, { k: null })));
  act(() => root.render(createElement(After, { k: 1 })));
  expect(seen, "the key's arrival").not.toContain(true);
  act(() => vi.advanceTimersByTime(1000));
  expect(seen.at(-1)).toBe(true);
  const past = seen.length;
  act(() => root.render(createElement(After, { k: 2 })));
  expect(seen.slice(past), "a change while past").not.toContain(true);
  act(() => root.render(null));
});

it("no render shows a load's result under another key, not even the one where the key changes", async () => {
  const seen: (string | undefined)[] = [];
  const Load = ({ k }: { k: string | null }) => { seen.push(kit.async.useLoad(k, async (key) => `for ${key}`)); return null; };
  await act(async () => root.render(createElement(Load, { k: "a" })));
  expect(seen.at(-1)).toBe("for a");
  const before = seen.length;
  await act(async () => root.render(createElement(Load, { k: null })));
  expect(seen.slice(before), "no key reads nothing").toEqual(seen.slice(before).map(() => undefined));
  await act(async () => root.render(createElement(Load, { k: "b" })));
  expect(seen.slice(before)).not.toContain("for a");
  expect(seen.at(-1)).toBe("for b");
  act(() => root.render(null));
});

it("a load keeps only the current key's result, reads nothing while a new key loads, and drops one that lands after unmount", async () => {
  const pending: { key: string; resolve: (v: string) => void }[] = [];
  const load = (key: string) => new Promise<string>((resolve) => { pending.push({ key, resolve }); });
  const seen: (string | undefined)[] = [];
  const Load = ({ k }: { k: string | null }) => { seen.push(kit.async.useLoad(k, load)); return null; };
  const land = async (n: number, value: string) => { await act(async () => { pending[n]?.resolve(value); await Promise.resolve(); }); };
  act(() => root.render(createElement(Load, { k: "a" })));
  expect(seen.at(-1)).toBeUndefined();
  await land(0, "A");
  expect(seen.at(-1)).toBe("A");
  act(() => root.render(createElement(Load, { k: "b" })));
  expect(seen.at(-1), "nothing while a new key loads").toBeUndefined();
  act(() => root.render(createElement(Load, { k: "a" })));
  expect(pending.map((p) => p.key)).toEqual(["a", "b", "a"]);
  await land(1, "B");
  await land(0, "old A");
  expect(seen.at(-1), "a read that was left behind is dropped, even for the same key").toBeUndefined();
  await land(2, "new A");
  expect(seen.at(-1)).toBe("new A");
  act(() => root.render(createElement(Load, { k: null })));
  expect(seen.at(-1), "no key reads nothing").toBeUndefined();
  act(() => root.render(createElement(Load, { k: "c" })));
  act(() => root.render(null));
  const after = seen.length;
  await land(3, "C");
  expect(seen.length, "a result after unmount draws nothing").toBe(after);
});
