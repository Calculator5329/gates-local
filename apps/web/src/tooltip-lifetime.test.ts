// Drive the actual tooltip listeners and observer; no browser or replacement
// tooltip implementation. The fixture supplies its DOM boundary only.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const p = vi.hoisted(() => ({ tip: undefined as unknown, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useRef: () => ({ current: p.tip }),
  useEffect: (effect: () => void | (() => void)) => { p.effects.push(effect); },
}));
import { Tip } from "./ui.tsx";
import { setState } from "./store.ts";

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
let observers: Set<(records: { target: ElementFixture }[]) => void>;
let cleanups: (() => void)[];
let anchor: ElementFixture, tip: ElementFixture;
beforeEach(() => {
  vi.useFakeTimers(); listeners = new Map(); observers = new Set(); cleanups = [];
  anchor = new ElementFixture(); tip = new ElementFixture(); p.tip = tip; p.effects.length = 0;
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("innerWidth", 1440); vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("Element", ElementFixture);
  vi.stubGlobal("MutationObserver", class {
    readonly changed: (records: { target: ElementFixture }[]) => void;
    constructor(changed: (records: { target: ElementFixture }[]) => void) { this.changed = changed; }
    observe() { observers.add(this.changed); }
    disconnect() { observers.delete(this.changed); }
  });
  vi.stubGlobal("document", {
    body: new ElementFixture(),
    addEventListener: (name: string, listener: (event: { target: ElementFixture }) => void) => { listeners.set(name, listener); },
    removeEventListener: (name: string) => { listeners.delete(name); },
  });
  setState({ pop: null }); Tip();
  for (const effect of p.effects.splice(0)) {
    const cleanup = effect(); if (cleanup) cleanups.push(cleanup);
  }
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
