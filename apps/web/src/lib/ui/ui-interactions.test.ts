// Real popover and tooltip handlers, with a small in-memory document surface.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  state: { pop: null } as { pop: { id: string; kb: boolean } | null },
  root: undefined as unknown, effects: [] as (() => unknown)[],
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useRef: () => ({ current: probe.root }),
  useEffect: (effect: () => unknown) => { probe.effects.push(effect); },
}));
vi.mock("../store/store.ts", () => ({
  getState: () => probe.state,
  setState: (update: Partial<typeof probe.state> | ((s: typeof probe.state) => Partial<typeof probe.state>)) => {
    Object.assign(probe.state, typeof update === "function" ? update(probe.state) : update);
  },
}));
const { Tip, togglePop } = await import("./ui.tsx");

beforeEach(() => {
  probe.state = { pop: { id: "picker", kb: false } }; probe.effects = [];
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => vi.unstubAllGlobals());

it("the trigger closes an open picker", () => {
  togglePop("picker");
  expect(probe.state.pop).toBeNull();
});

it("the trigger switches from the picker to another popover", () => {
  togglePop("opts");
  expect(probe.state.pop).toEqual({ id: "opts", kb: false });
});

class Target {
  isConnected = true;
  readonly container: string;
  readonly oldPop: boolean;
  constructor(container: string, oldPop: boolean) { this.container = container; this.oldPop = oldPop; }
  closest(selector: string): Target | null {
    if (selector === "[data-tip],[data-tipt]") return this;
    if (selector === ".pop") return this.oldPop ? this : null;
    return selector.split(",").some(s => s.trim() === `#${this.container}`) ? this : null;
  }
  getAttribute(name: string) { return name === "data-tip" ? "Memory for this model" : null; }
  getBoundingClientRect() { return { top: 300, bottom: 334, left: 700, right: 1000, width: 300, height: 34 }; }
}

function mountTip() {
  const classes = new Set<string>();
  const root = { classList: { add: (s: string) => classes.add(s), remove: (s: string) => classes.delete(s) }, innerHTML: "", style: {}, offsetWidth: 180, offsetHeight: 40 };
  const listeners = new Map<string, (e: { target: Target }) => void>();
  const timers: (() => void)[] = [];
  probe.root = root;
  vi.stubGlobal("Element", Target);
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("window", { innerWidth: 1440, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: vi.fn() });
  vi.stubGlobal("document", { addEventListener: (name: string, fn: (e: { target: Target }) => void) => listeners.set(name, fn), removeEventListener: vi.fn() });
  Tip();
  const cleanup = probe.effects[0]?.();
  return {
    hover: (target: Target) => { listeners.get("mouseover")?.({ target }); for (const timer of timers.splice(0)) timer(); },
    open: () => classes.has("open"),
    cleanup: () => { if (typeof cleanup === "function") cleanup(); },
  };
}

it.each(["picker", "plusMenu", "optsMenu", "threadMenu"])("a tooltip inside the active %s can open after its hover delay", container => {
  const id = container === "plusMenu" ? "plus" : container === "optsMenu" ? "opts" : container === "threadMenu" ? "thread" : "picker";
  probe.state.pop = { id, kb: false };
  const tip = mountTip();
  try {
    tip.hover(new Target(container, container !== "picker"));
    expect(tip.open()).toBe(true);
  } finally { tip.cleanup(); }
});

it.each(["background", "plusMenu"])("a tooltip in %s stays hidden behind the active picker", container => {
  const tip = mountTip();
  try {
    tip.hover(new Target(container, container === "plusMenu"));
    expect(tip.open()).toBe(false);
  } finally { tip.cleanup(); }
});

const { anchorOf, closePop, menuKeys, place, tabStops } = await import("./ui.tsx");
const { walk } = await import("./settings-ui.tsx");
const { FakeDocument, FakeElement } = await import("../../../test/fake-dom.ts");

type Doc = InstanceType<typeof FakeDocument>;
type El = InstanceType<typeof FakeElement>;
type Pop = { id: string; kb: boolean; thread?: string; at?: { x: number; y: number } };
type Box = { top: number; bottom: number; left: number; right: number };

function add(doc: Doc, parent: Doc | El, tag: string, attrs: Record<string, string> = {}): El {
  const child = parent.appendChild(doc.createElement(tag));
  for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, value);
  return child;
}

function fakeDom(phone = false) {
  const doc = new FakeDocument();
  const frames: (() => void)[] = [];
  vi.stubGlobal("document", doc);
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  vi.stubGlobal("matchMedia", () => ({ matches: phone }));
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
  return { doc, frame: () => { for (const fn of frames.splice(0)) fn(); } };
}

function openPop(pop: Pop): void {
  const state = { pop, afterCommit: [] as unknown[] };
  probe.state = state;
}

function threadRows(doc: Doc) {
  const nav = add(doc, doc.body, "nav", { class: "sb" });
  return ["t1", "t2", "t3"].map((thread) => {
    const row = add(doc, nav, "div", { class: "sb-row", "data-thread": thread });
    return { thread: add(doc, row, "button", { class: "sb-thread" }), menu: add(doc, row, "button", { class: "ibtn xs sb-menu" }) };
  });
}

const keyOn = (key: string, currentTarget?: El) => ({ key, currentTarget, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} });
const asMenuKey = (e: ReturnType<typeof keyOn>) => e as unknown as Parameters<typeof menuKeys>[0];
const asWalkKey = (e: ReturnType<typeof keyOn>) => e as unknown as Parameters<typeof walk>[0];
const boxed = (el: El, box: Box) => Object.assign(el, { getBoundingClientRect: () => ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }) });

it("on a phone, a press outside an open sheet closes it and gives the focus back to the control it opened from", () => {
  const { doc, frame } = fakeDom(true);
  for (const [id, popEl, anchor] of [["picker", "picker", "modelBtn"], ["plus", "plusMenu", "plusBtn"], ["opts", "optsMenu", "optBtn"], ["count", "countMenu", "countBtn"]] as const) {
    const control = add(doc, doc.body, "button", { id: anchor });
    add(doc, doc.body, "div", { id: popEl });
    openPop({ id, kb: false });
    doc.activeElement = doc.body;
    closePop();
    frame();
    expect(probe.state.pop, id).toBeNull();
    expect(doc.activeElement, id).toBe(control);
  }
});

it("a dialog's tab ring passes over controls that are hidden or disabled", () => {
  const { doc } = fakeDom();
  const dialog = add(doc, doc.body, "div", { role: "dialog" });
  const first = add(doc, dialog, "button");
  const hidden = add(doc, dialog, "button");
  Object.assign(hidden, { getClientRects: () => [] });
  add(doc, dialog, "button", { disabled: "" });
  add(doc, dialog, "input", { disabled: "" });
  const field = add(doc, dialog, "input");
  const link = add(doc, dialog, "a", { href: "#x" });
  expect(tabStops(dialog as unknown as HTMLElement)).toEqual([first, field, link]);
});

it("a thread's menu opened from its row's menu button belongs to that button and gives the focus back to it on close", () => {
  const { doc } = fakeDom();
  const rows = threadRows(doc);
  add(doc, doc.body, "div", { id: "threadMenu" });
  openPop({ id: "thread", kb: false, thread: "t2" });
  expect(anchorOf("thread")).toBe(rows[1]?.menu);
  closePop(true);
  expect(doc.activeElement).toBe(rows[1]?.menu);
});

it("when the window resizes, a popover that held the focus gives it back to its control, and one that did not leaves the focus where it was", () => {
  const { doc, frame } = fakeDom();
  const control = add(doc, doc.body, "button", { id: "modelBtn" });
  const picker = add(doc, doc.body, "div", { id: "picker" });
  const row = add(doc, picker, "button");
  const elsewhere = add(doc, doc.body, "textarea");

  openPop({ id: "picker", kb: false });
  row.focus();
  closePop("if-inside");
  frame();
  expect(probe.state.pop).toBeNull();
  expect(doc.activeElement).toBe(control);

  for (const before of [doc.body, elsewhere]) {
    openPop({ id: "picker", kb: false });
    doc.activeElement = before;
    closePop("if-inside");
    frame();
    expect(probe.state.pop).toBeNull();
    expect(doc.activeElement).toBe(before);
  }
});

it("a thread menu opened by the context-menu key gives the focus back to the thread, and one opened by its button gives it back to the button", () => {
  const { doc } = fakeDom();
  const rows = threadRows(doc);
  add(doc, doc.body, "div", { id: "threadMenu" });
  openPop({ id: "thread", kb: true, thread: "t2", at: { x: 12, y: 40 } });
  closePop(true);
  expect(doc.activeElement).toBe(rows[1]?.thread);
  openPop({ id: "thread", kb: false, thread: "t3" });
  closePop(true);
  expect(doc.activeElement).toBe(rows[2]?.menu);
});

it("Up, Down, Home and End move between a menu's items", () => {
  const { doc } = fakeDom();
  const menu = add(doc, doc.body, "div", { role: "menu" });
  const items = ["Rename", "Pin", "Delete"].map((name) => add(doc, menu, "button", { role: "menuitem", "aria-label": name }));
  const press = (key: string) => { menuKeys(asMenuKey(keyOn(key, menu))); return doc.activeElement; };
  items[0]?.focus();
  expect(press("ArrowDown")).toBe(items[1]);
  expect(press("ArrowDown")).toBe(items[2]);
  expect(press("ArrowUp")).toBe(items[1]);
  expect(press("Home")).toBe(items[0]);
  expect(press("ArrowUp")).toBe(items[2]);
  expect(press("End")).toBe(items[2]);
  expect(press("ArrowDown")).toBe(items[0]);
});

it("letters typed less than 800 ms apart build one name to find, and a letter 800 ms after the last starts a new one", () => {
  const { doc } = fakeDom();
  const list = add(doc, doc.body, "div");
  const items = ["Llama", "Echo", "Gemma", "Mistral"].map((name) => add(doc, list, "button", { "aria-label": name }));
  const clock = vi.spyOn(Date, "now");
  const type = (key: string, at: number) => { clock.mockReturnValue(at); walk(asWalkKey(keyOn(key)), list as unknown as HTMLElement, "button", () => undefined); return doc.activeElement; };
  try {
    items[0]?.focus();
    expect(type("g", 5_000_000)).toBe(items[2]);
    expect(type("e", 5_000_799)).toBe(items[2]);
    expect(type("g", 5_001_599)).toBe(items[2]);
    expect(type("e", 5_002_399)).toBe(items[1]);
  } finally { clock.mockRestore(); }
});

it("arrow keys in a menu or list pass over items marked unavailable, Home and End reach the first and last that are not, and Tab closes it", () => {
  const { doc } = fakeDom();
  const list = add(doc, doc.body, "div");
  const [off, alpha, bravo, charlie, delta] = ["Off", "Alpha", "Bravo", "Charlie", "Delta"].map((name, i) => add(doc, list, "button", i % 2 === 0 ? { "aria-label": name, "aria-disabled": "true" } : { "aria-label": name }));
  const close = vi.fn();
  const press = (key: string) => { walk(asWalkKey(keyOn(key)), list as unknown as HTMLElement, "button", close); return doc.activeElement; };
  alpha?.focus();
  expect(press("ArrowDown")).toBe(charlie);
  expect(press("ArrowDown")).toBe(alpha);
  expect(press("ArrowUp")).toBe(charlie);
  expect(press("End")).toBe(charlie);
  expect(press("Home")).toBe(alpha);
  expect([off, bravo, delta]).not.toContain(doc.activeElement);
  expect(close).not.toHaveBeenCalled();
  press("Tab");
  expect(close).toHaveBeenCalledTimes(1);
});

function placed(anchorBox: Box, align: "start" | "end", dir?: "below", composerBox?: Box) {
  const { doc } = fakeDom();
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
  const holder = composerBox === undefined ? doc.body : boxed(add(doc, doc.body, "div", { class: "composer" }), composerBox);
  const anchor = boxed(add(doc, holder, "button"), anchorBox);
  const pop = Object.assign(add(doc, doc.body, "div", { class: "pop" }), { offsetWidth: 300, offsetHeight: 200 });
  place(pop as unknown as HTMLElement, anchor as unknown as HTMLElement, align, dir);
  return { top: pop.style["top"], left: pop.style["left"] };
}

it("a composer popover opens above the whole composer, not just above its button", () => {
  expect(placed({ top: 800, bottom: 830, left: 400, right: 430 }, "start", undefined, { top: 760, bottom: 880, left: 300, right: 1100 })).toEqual({ top: "552px", left: "400px" });
});

it("a popover asked to open below its anchor opens under it", () => {
  expect(placed({ top: 300, bottom: 330, left: 400, right: 430 }, "start", "below")).toEqual({ top: "336px", left: "400px" });
});

it("a popover aligned to the end lines its right edge up with its anchor's", () => {
  expect(placed({ top: 500, bottom: 530, left: 640, right: 700 }, "end")).toEqual({ top: "292px", left: "400px" });
});
