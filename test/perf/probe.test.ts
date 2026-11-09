import { afterEach, expect, test, vi } from "vitest";
import { browserProbe } from "./probe.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const noop = () => {};
function fixture() {
  let clock = 100;
  const frames: FrameRequestCallback[] = [];
  let mutation = noop;
  let done = false;
  const element = { value: "", textContent: "", disabled: false, getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 10, bottom: 100 }) };
  const document = Object.assign(new EventTarget(), {
    activeElement: element,
    querySelector: (selector: string) => selector === "#done" ? (done ? element : null) : selector === ".composer.blocked" ? null : element,
    querySelectorAll: () => [element],
  });
  class Socket { static OPEN = 1; readyState = 1; close() { this.readyState = 3; } }
  class Observer { observe() {} disconnect() {} takeRecords() { return []; } }
  class Mutations { constructor(callback: () => void) { mutation = callback; } observe() {} disconnect() {} }
  vi.stubGlobal("window", { WebSocket: Socket }); vi.stubGlobal("document", document);
  vi.stubGlobal("localStorage", { setItem: noop, removeItem: noop });
  vi.stubGlobal("PerformanceObserver", Observer); vi.stubGlobal("MutationObserver", Mutations);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); });
  vi.stubGlobal("innerHeight", 900); vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const tick = (count = 3) => { for (let i = 0; i < count; i++) { const callback = frames.shift(); if (!callback) throw new Error("No pending paint"); clock += 16; callback(clock); } };
  const input = (type: string, delay: number) => { const event = new Event(type); Object.defineProperty(event, "timeStamp", { value: clock - delay }); document.dispatchEvent(event); };
  browserProbe(false); tick();
  return { element, document, frames, tick, input, complete: () => { done = true; mutation(); } };
}

test("completion-to-next timing waits for the begin marker and usable rendered value", async () => {
  const f = fixture();
  window.perfJourney.arm("mutation:#done", "#ta", "new value", "usable-value");
  expect(f.frames).toHaveLength(0);
  f.complete(); f.tick(1);
  let finished = false; void window.perfJourney.result.then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false);
  f.element.value = "new value"; f.tick();
  expect((await window.perfJourney.result).frames.length).toBeGreaterThan(1);
});

test("input dispatch delays include typing during an asynchronous arrival and stop collecting afterwards", async () => {
  const f = fixture(); f.element.textContent = "ready";
  window.perfJourney.arm("click", "#ta", "ready", "text");
  f.input("click", 2); f.input("keydown", 3); f.tick();
  const observed = await window.perfJourney.result;
  expect(observed.inputDelays).toEqual([2, 3]);
  f.input("keydown", 9); expect(observed.inputDelays).toEqual([2, 3]);
});

test("a cached reply from another thread cannot finish the current-text marker", async () => {
  const f = fixture(); f.element.textContent = "Reply for another thread";
  window.perfJourney.arm("click", "#ta", "Reply1fresh", "compact-text"); f.input("click", 1); f.tick(1);
  let finished = false; void window.perfJourney.result.then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false);
  f.element.textContent = "Reply 1\nfresh"; f.tick(); await window.perfJourney.result;
  expect(finished).toBe(true);
});

test("reconnect observes a replaced socket even when loss and recovery happen between frames", async () => {
  const f = fixture();
  const initial = new window.WebSocket("ws://fixture");
  window.perfJourney.arm("now", "#ta", "", "reconnect");
  let finished = false; void window.perfJourney.result.then(() => { finished = true; });
  f.tick(1); await Promise.resolve(); expect(finished).toBe(false);
  window.perfJourney.drop();
  const replacement = new window.WebSocket("ws://fixture");
  expect(initial.readyState).toBe(3); expect(replacement).not.toBe(initial);
  f.tick(); await Promise.resolve();
  expect(finished).toBe(true);
});
