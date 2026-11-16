// Drive the actual tooltip listeners and observer; no browser or replacement
// tooltip implementation. The fixture supplies its DOM boundary only.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Tip, closeTip, openTip } from "./ui.tsx";
import { setState } from "../store/store.ts";

class ElementFixture {
  isConnected = true;
  text = "Whisper explanation";
  top = 100;
  innerHTML = "";
  offsetWidth = 100;
  offsetHeight = 20;
  style: Record<string, string> = {};
  classes = new Set<string>();
  classList = { add: (c: string) => void this.classes.add(c), remove: (c: string) => void this.classes.delete(c), contains: (c: string) => this.classes.has(c) };
  getAttribute(name: string) { return name === "data-tip" ? this.text : null; }
  closest(selector: string) { return selector === "[data-tip],[data-tipt]" ? this : null; }
  querySelector(_selector: string): { scrollWidth: number; clientWidth: number } | null { return null; }
  contains(target: ElementFixture) { return target === this; }
  width = 120;
  getBoundingClientRect() { return { x: 10, y: this.top, left: 10, top: this.top, right: 10 + this.width, bottom: this.top + 20, width: this.width, height: this.width === 0 ? 0 : 20 }; }
}
let listeners: Map<string, (event: { target: ElementFixture }) => void>;
let observers: Set<(records: { target: ElementFixture; attributeName?: string }[]) => void>;
let cleanups: (() => void)[];
let anchor: ElementFixture, tip: ElementFixture;
beforeEach(() => {
  vi.useFakeTimers(); listeners = new Map(); observers = new Set(); cleanups = [];
  anchor = new ElementFixture(); tip = new ElementFixture();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("innerWidth", 1440); vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("Element", ElementFixture);
  vi.stubGlobal("MutationObserver", class {
    readonly changed: (records: { target: ElementFixture; attributeName?: string }[]) => void;
    constructor(changed: (records: { target: ElementFixture; attributeName?: string }[]) => void) { this.changed = changed; }
    observe() { observers.add(this.changed); }
    disconnect() { observers.delete(this.changed); }
  });
  vi.stubGlobal("document", {
    body: new ElementFixture(),
    addEventListener: (name: string, listener: (event: { target: ElementFixture }) => void) => { listeners.set(name, listener); },
    removeEventListener: (name: string) => { listeners.delete(name); },
  });
  setState({ pop: null });
  const cleanup = (Tip().props as { ref: (el: unknown) => (() => void) | undefined }).ref(tip);
  if (cleanup) cleanups.push(cleanup);
});
afterEach(() => { for (const cleanup of cleanups) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(["move", "tip removed", "remove"])("keeps an unchanged tooltip, then closes it on anchor %s", async change => {
  listeners.get("mouseover")!({ target: anchor });
  await vi.advanceTimersByTimeAsync(400);
  expect(tip.classes.has("open")).toBe(true);
  for (const changed of observers) changed([{ target: anchor }]);
  expect(tip.classes.has("open")).toBe(true);
  if (change === "move") anchor.top += 20;
  else if (change === "tip removed") anchor.text = "";
  else anchor.isConnected = false;
  for (const changed of observers) changed([{ target: anchor }]);
  expect(tip.classes.has("open")).toBe(false);
});

// New words at the same anchor (a download's percentage) follow in the open tooltip.
it("follows a changed data-tip in place", async () => {
  listeners.get("mouseover")!({ target: anchor });
  await vi.advanceTimersByTimeAsync(400);
  expect(tip.classes.has("open")).toBe(true);
  expect(tip.style["left"]).toBe("20px");
  anchor.text = "Downloading, 42%";
  tip.offsetWidth = 160;
  for (const changed of observers) changed([{ target: anchor }]);
  expect(tip.classes.has("open")).toBe(true);
  expect(tip.innerHTML).toContain("Downloading, 42%");
  expect(tip.style["left"], "wider words keep the left edge still").toBe("20px");
  // words that would leave the screen are placed again
  anchor.text = "Downloading, 43%";
  tip.offsetWidth = 1420;
  for (const changed of observers) changed([{ target: anchor }]);
  expect(tip.style["left"]).toBe("6px");
});

// Send that turns into Stop keeps its place and may keep its words; the tooltip it showed is for the old button.
it("closes when its anchor names a new action, with the same words and box, and not for another control's", async () => {
  listeners.get("mouseover")!({ target: anchor });
  await vi.advanceTimersByTimeAsync(400);
  expect(tip.classes.has("open")).toBe(true);
  for (const changed of observers) changed([{ target: new ElementFixture(), attributeName: "data-tipkey" }]);
  expect(tip.classes.has("open"), "another control's action").toBe(true);
  for (const changed of observers) changed([{ target: anchor, attributeName: "data-tipkey" }]);
  expect(tip.classes.has("open")).toBe(false);
});

it("closes instead of moving when the anchor's new words come with no box", async () => {
  listeners.get("mouseover")!({ target: anchor });
  await vi.advanceTimersByTimeAsync(400);
  expect(tip.classes.has("open")).toBe(true);
  anchor.text = "Hidden now";
  anchor.width = 0;
  for (const changed of observers) changed([{ target: anchor }]);
  expect(tip.classes.has("open")).toBe(false);
});

it("words removed while a tooltip waits cancel the wait, even if they come back unannounced", async () => {
  listeners.get("mouseover")!({ target: anchor });
  await vi.advanceTimersByTimeAsync(100);
  anchor.text = "";
  for (const changed of observers) changed([{ target: anchor }]);
  anchor.text = "Back again";
  await vi.advanceTimersByTimeAsync(400);
  expect(tip.classes.has("open")).toBe(false);
});

/** A name in a row: data-tipt holds the full name, its `.pk-nm` (or `.t`) the text the row may cut. */
class CutName extends ElementFixture {
  name = "Qwen 3.5 <9B> Instruct";
  shown = { scrollWidth: 180, clientWidth: 180 };
  override getAttribute(name: string) { return name === "data-tipt" ? this.name : null; }
  override querySelector(selector: string) { return selector === ".t, .pk-nm" ? this.shown : null; }
}

it.each([["cut by its row", 260, true], ["shown whole", 180, false]] as const)("a name %s: the cut-name tip opens only when the row cuts it", async (_, width, opens) => {
  const name = new CutName();
  name.shown.scrollWidth = width;
  listeners.get("mouseover")!({ target: name });
  await vi.advanceTimersByTimeAsync(400);
  expect(tip.classes.has("open")).toBe(opens);
  // the full name, as text: never markup from the model's name
  if (opens) expect(tip.innerHTML).toBe("Qwen 3.5 &lt;9B&gt; Instruct");
});

class Part extends ElementFixture {
  parent: Part | null = null;
  tag: string;
  role: string | null = null;
  id = "";
  tipped = false;
  constructor(tag: string, parent: Part | null = null) {
    super();
    this.tag = tag;
    this.parent = parent;
  }
  override getAttribute(name: string) { return name === "data-tip" && this.tipped ? this.text : null; }
  matches(selector: string): boolean {
    return selector.split(",").map(part => part.trim()).some(part =>
      part === "[data-tip]" ? this.tipped
        : part.startsWith("#") ? this.id === part.slice(1)
          : part.startsWith("[role=") ? this.role === part.slice(6, -1)
            : this.tag === part);
  }
  override closest(selector: string): this | null {
    return this.matches(selector) ? this : (this.parent?.closest(selector) ?? null) as this | null;
  }
  override contains(target: ElementFixture) {
    for (let at: Part | null = target instanceof Part ? target : null; at !== null; at = at.parent) if (at === this) return true;
    return false;
  }
}

const touchScreen = (query: string) => ({ matches: query === "(hover: none)" });

function tapOn(target: Part) {
  const event = { target, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  listeners.get("mousedown")!(event);
  listeners.get("click")!(event);
  return event;
}

it("on a touch screen, hovering over explaining text opens no tooltip", async () => {
  vi.stubGlobal("matchMedia", touchScreen);
  listeners.get("mouseover")!({ target: anchor });
  await vi.advanceTimersByTimeAsync(1000);
  expect(tip.classes.has("open")).toBe(false);
});

it("on a touch screen, a tap on text that only explains opens its tooltip at once", () => {
  vi.stubGlobal("matchMedia", touchScreen);
  const legend = new Part("div");
  legend.tipped = true;
  legend.text = "Fits in memory with room to spare";
  const word = new Part("span", legend);
  tapOn(word);
  expect(tip.classes.has("open")).toBe(true);
  expect(tip.innerHTML).toBe("Fits in memory with room to spare");
});

it.each([
  ["a button", "button", null],
  ["a link", "a", null],
  ["a text box", "input", null],
  ["a text area", "textarea", null],
  ["a role=button element", "div", "button"],
  ["a switch", "div", "switch"],
  ["a menu item", "div", "menuitem"],
] as const)("on a touch screen, a tap on %s does the control's action and opens no tooltip", (_, tag, role) => {
  vi.stubGlobal("matchMedia", touchScreen);
  const control = new Part(tag);
  control.role = role;
  control.tipped = true;
  const row = new Part("div");
  row.tipped = true;
  const inner = new Part(tag, row);
  inner.role = role;
  for (const target of [control, inner]) {
    const event = tapOn(target);
    expect(tip.classes.has("open")).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  }
});

it("closeTip hides an open tooltip and one still waiting to show", async () => {
  listeners.get("mouseover")!({ target: anchor });
  await vi.advanceTimersByTimeAsync(400);
  expect(tip.classes.has("open")).toBe(true);
  closeTip();
  expect(tip.classes.has("open")).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  const other = new ElementFixture();
  listeners.get("mouseover")!({ target: other });
  await vi.advanceTimersByTimeAsync(100);
  expect(tip.classes.has("open")).toBe(false);
  closeTip();
  await vi.advanceTimersByTimeAsync(1000);
  expect(tip.classes.has("open")).toBe(false);
});

it("closeTip within a control closes only a tooltip whose anchor is inside that control", async () => {
  const picker = new Part("div");
  picker.id = "picker";
  const row = new Part("div", picker);
  row.tipped = true;
  listeners.get("mouseover")!({ target: row });
  await vi.advanceTimersByTimeAsync(400);
  expect(tip.classes.has("open")).toBe(true);
  closeTip("#plusMenu");
  expect(tip.classes.has("open")).toBe(true);
  closeTip("#picker");
  expect(tip.classes.has("open")).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  const outside = new Part("div");
  outside.tipped = true;
  listeners.get("mouseover")!({ target: outside });
  await vi.advanceTimersByTimeAsync(100);
  expect(tip.classes.has("open")).toBe(false);
  closeTip("#picker");
  await vi.advanceTimersByTimeAsync(300);
  expect(tip.classes.has("open"), "a waiting tooltip outside the control still opens").toBe(true);
  listeners.get("mouseover")!({ target: picker });
  await vi.advanceTimersByTimeAsync(1000);
  listeners.get("mouseover")!({ target: row });
  await vi.advanceTimersByTimeAsync(100);
  expect(tip.classes.has("open")).toBe(false);
  closeTip("#picker");
  await vi.advanceTimersByTimeAsync(1000);
  expect(tip.classes.has("open"), "a waiting tooltip inside the control never opens").toBe(false);
});

it("openTip shows an anchor's tooltip at once, with no hover delay, and ignores a missing anchor", () => {
  openTip(null);
  openTip(undefined);
  expect(tip.classes.has("open")).toBe(false);
  openTip(anchor as unknown as Element);
  expect(tip.classes.has("open")).toBe(true);
  expect(tip.innerHTML).toBe("Whisper explanation");
});

it("a tooltip still waiting to show opens with the anchor's newest words, after the same delay", async () => {
  listeners.get("mouseover")!({ target: anchor });
  await vi.advanceTimersByTimeAsync(100);
  anchor.text = "Downloading, 42%";
  for (const changed of observers) changed([{ target: anchor }]);
  expect(tip.classes.has("open")).toBe(false);
  await vi.advanceTimersByTimeAsync(300);
  expect(tip.classes.has("open")).toBe(true);
  expect(tip.innerHTML).toBe("Downloading, 42%");
});
