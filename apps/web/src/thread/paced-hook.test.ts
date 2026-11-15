import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Exercise the hook's effect lifecycle, including StrictMode's setup/cleanup
// replay, with a deterministic animation clock and no browser dependency.
const hooks = vi.hoisted(() => {
  let cursor = 0;
  const slots: unknown[] = [];
  const effects: { setup: () => void | (() => void); deps: unknown[]; cleanup?: (() => void) | undefined; pending: boolean }[] = [];
  return {
    reset() { cursor = 0; slots.length = 0; effects.length = 0; },
    render() { cursor = 0; },
    flush() { for (const e of effects) if (e?.pending) { e.cleanup?.(); e.cleanup = e.setup() ?? undefined; e.pending = false; } },
    replay() { for (const e of effects) if (e) { e.cleanup?.(); e.cleanup = undefined; e.pending = true; } },
    useRef(value: unknown) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value: unknown) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof value === "function" ? value() : value;
      return [slots[i], (v: unknown) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }];
    },
    useSyncExternalStore(subscribe: (change: () => void) => () => void, snapshot: () => unknown) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = subscribe(() => {});
      return snapshot();
    },
    useEffect(setup: () => void | (() => void), deps: unknown[]) {
      const i = cursor++;
      const old = effects[i];
      if (!old || deps.some((v, j) => v !== old.deps[j])) effects[i] = { setup, deps, cleanup: old?.cleanup, pending: true };
    },
  };
});
vi.mock("react", () => hooks);
import { usePacedText } from "./paced.ts";

let frames: Map<number, FrameRequestCallback>;
let id: number;
let reduced: boolean;
let motionChange: (() => void) | undefined;
const render = (text: string, streaming = true) => { hooks.render(); const value = usePacedText(text, streaming); hooks.flush(); return value; };
const frame = (now: number) => { const jobs = [...frames.values()]; frames.clear(); for (const job of jobs) job(now); };

beforeEach(() => {
  hooks.reset(); frames = new Map(); id = 0; reduced = false; motionChange = undefined;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.set(++id, fn); return id; });
  vi.stubGlobal("cancelAnimationFrame", (n: number) => frames.delete(n));
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; }, addEventListener: (_: string, fn: () => void) => { motionChange = fn; }, removeEventListener: () => { motionChange = undefined; } }));
  vi.spyOn(performance, "now").mockReturnValue(0);
});
afterEach(() => { hooks.replay(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("resumes frames after StrictMode replays mount effects", () => {
  const text = "Returning to a streaming reply";
  expect(render("")).toBe("");
  expect(render(text)).toBe("");
  expect(frames.size).toBe(1);
  hooks.replay(); hooks.flush();
  expect(frames.size).toBe(1);
  frame(30);
  const shown = render(text);
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(text.length);
  expect(frames.size).toBe(1);
  render(text, false); frame(200); frame(340);
  expect(render(text, false)).toBe(text);
  expect(frames.size).toBe(0);
});

it.each([
  "A😀B e\u0301 👩🏽‍💻 🇺🇸🇨🇦 क्‍ष end",
  "Prefix. ".repeat(20) + "🇺" + "🇺🇸🇨🇦".repeat(20) + "e" + "\u0301".repeat(100) + "👩🏽‍💻".repeat(5),
])("never reveals half a grapheme, including clusters crossing the local window (%#)", (text) => {
  const boundaries = new Set([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.index));
  boundaries.add(text.length);
  expect(render("")).toBe("");
  expect(render(text)).toBe("");
  expect(frames.size).toBe(1);
  const intermediate = new Set<number>();
  let shown = "";
  for (let time = 10; time < 10000; time += 10) {
    frame(time);
    shown = render(text);
    expect(boundaries.has(shown.length), `cut at ${shown.length}`).toBe(true);
    if (shown.length > 0 && shown.length < text.length) intermediate.add(shown.length);
    if (shown === text) break;
  }
  expect(intermediate.size).toBeGreaterThan(2);
  expect(shown).toBe(text);
  expect(frames.size).toBe(0);
});

it("segments near the reveal boundary rather than scanning the reply", () => {
  const prefix = "Historical text. ".repeat(10000);
  render(prefix, false);
  const spy = vi.spyOn(Intl.Segmenter.prototype, "segment");
  render(prefix + "👩🏽‍💻 next"); frame(25);
  expect(spy).toHaveBeenCalled();
  expect(Math.max(...spy.mock.calls.map(([s]) => s.length))).toBeLessThan(100);
});

it("asks for reduced motion once for the module, however many replies pace", async () => {
  vi.resetModules();
  const fresh = await import("./paced.ts");
  const listen = vi.fn();
  const ask = vi.fn(() => ({ matches: false, addEventListener: listen, removeEventListener() {} }));
  vi.stubGlobal("matchMedia", ask);
  for (const reply of ["First reply", "Second reply", "Third reply"]) {
    hooks.reset(); hooks.render(); fresh.usePacedText(reply, true); hooks.flush();
  }
  expect(ask).toHaveBeenCalledTimes(1);
  expect(listen, "one change listener on the query, not one per reply").toHaveBeenCalledTimes(1);
});

it("shows arrivals immediately with reduced motion and cancels pacing on preference changes", () => {
  reduced = true;
  expect(render("Immediate arrival")).toBe("Immediate arrival");
  expect(frames.size).toBe(0);
  expect(render("Immediate arrival, with more")).toBe("Immediate arrival, with more");
  reduced = false; motionChange?.(); render("Paced again");
  expect(frames.size).toBeGreaterThan(0);
  reduced = true; motionChange?.();
  expect(render("Paced again, now immediate")).toBe("Paced again, now immediate");
  expect(frames.size).toBe(0);
});
