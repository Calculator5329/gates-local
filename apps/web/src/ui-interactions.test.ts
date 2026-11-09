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
vi.mock("./store.ts", () => ({
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

it.each([false, true])("the trigger preserves a pending size choice (keyboard %s)", kb => {
  const pop = probe.state.pop;
  vi.stubGlobal("document", { getElementById: () => ({ getAttribute: () => "true" }) });
  togglePop("picker", kb);
  expect(probe.state.pop).toBe(pop);
});

it("the trigger closes normally after the size check is no longer pending", () => {
  vi.stubGlobal("document", { getElementById: () => ({ getAttribute: () => null }) });
  togglePop("picker");
  expect(probe.state.pop).toBeNull();
});

it("a pending picker does not block switching to another popover", () => {
  vi.stubGlobal("document", { getElementById: () => ({ getAttribute: () => "true" }) });
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
