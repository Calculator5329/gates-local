// Measure's pages in this window: a page the window or the server could not run is skipped with
// why, not failed, since that is not the model's doing; a page too big to run is the model's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { harness } from "./measure-harness.ts";
import { SANDBOX_OFF_SKIP, SANDBOX_UNKNOWN_SKIP, SERVER_REFUSED_SKIP, runPage, runPages } from "./measure-pages.ts";

const SERVER = "http://127.0.0.1:1";
const page = "<!doctype html><html><body><p id=out>1</p></body></html>";
const script = [{ do: "read" as const, target: "#out" }];
const checks = [{ id: "page-total", state: "pending", page, script }, { id: "page-counter", state: "pending", page, script }];
const answer = (r: () => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(r));

afterEach(() => vi.unstubAllGlobals());

describe("Measure's pages in this window", () => {
  it("a page the server did not take is skipped with why; one too big to run fails", async () => {
    answer(async () => new Response("", { status: 401 }));
    expect(await runPage("page-total", page, script, 100, { origin: SERVER, token: "t" })).toEqual({ id: "page-total", seen: [], skipped: SERVER_REFUSED_SKIP });
    answer(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await runPage("page-total", page, script, 100, { origin: SERVER, token: "t" })).toEqual({ id: "page-total", seen: [], skipped: SERVER_REFUSED_SKIP });
    answer(async () => new Response("", { status: 413 }));
    expect(await runPage("page-total", page, script, 100, { origin: SERVER, token: "t" })).toMatchObject({ error: expect.stringMatching(/^The page is too big to run here/) });
  });

  it("with the sandbox off every page goes back skipped, saying why", async () => {
    expect(await runPages(checks, () => Promise.resolve(true))).toEqual(checks.map((c) => ({ id: c.id, seen: [], skipped: SANDBOX_OFF_SKIP })));
  });

  it("a sandbox answer that never comes does not hold the pages for ever: they go back skipped", async () => {
    const seen = await runPages(checks, () => new Promise<boolean>(() => undefined), 20);
    expect(seen).toEqual(checks.map((c) => ({ id: c.id, seen: [], skipped: SANDBOX_UNKNOWN_SKIP })));
  });
});

/**
 * A window whose visibility the test sets, with timers held (fake). A frame put in the page "runs"
 * only while the window is shown: a hidden window gets about one timer a second and no frames, so
 * there its page never finishes. Shown, it answers with what it saw.
 */
function fakeWindow() {
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = "hidden";
  const win = new EventTarget();
  const frames: { contentWindow: object; remove: () => void; removed: boolean }[] = [];
  let token = "";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    token = /\)\("([^"]+)"/.exec(String(init?.body))![1]!;
    return Response.json({ id: "a".repeat(32) });
  }));
  const make = () => {
    const frame = Object.assign(new EventTarget(), {
      contentWindow: {}, style: {}, tabIndex: 0, removed: false,
      setAttribute: () => undefined, remove() { frame.removed = true; },
    });
    frames.push(frame);
    return frame;
  };
  const answerIfShown = (frame: ReturnType<typeof make>) => {
    if (doc.visibilityState !== "visible" || frame.removed) return;
    win.dispatchEvent(Object.assign(new Event("message"), { source: frame.contentWindow, data: { token, seen: ["1"] } }));
  };
  Object.assign(doc, {
    createElement: make,
    body: { append: (frame: ReturnType<typeof make>) => setTimeout(() => answerIfShown(frame), 100) },
  });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", function HTMLElement() {});
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("addEventListener", win.addEventListener.bind(win));
  vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win));
  const show = (state: "visible" | "hidden") => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return { frames, show, answerIfShown };
}

describe("Measure's pages and where the window is", () => {
  afterEach(() => vi.useRealTimers());

  it("a page waits for a shown window rather than failing in a hidden one", async () => {
    vi.useFakeTimers();
    const w = fakeWindow();
    let result: unknown;
    void runPage("page-total", page, script, 5000, { origin: SERVER, token: "t" }).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(60_000);
    // a minute in the background: no fail, and no frame running in a window that cannot run it
    expect(result).toBeUndefined();
    expect(w.frames).toHaveLength(0);
    w.show("visible");
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toEqual({ id: "page-total", seen: ["1"] });
  });

  it("a page the window hid while it ran starts again once shown, with its whole time", async () => {
    vi.useFakeTimers();
    const w = fakeWindow();
    w.show("visible");
    let result: unknown;
    void runPage("page-total", page, script, 5000, { origin: SERVER, token: "t" }).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.frames).toHaveLength(1);
    w.show("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(result).toBeUndefined();
    expect(w.frames[0]!.removed).toBe(true);
    w.show("visible");
    await vi.advanceTimersByTimeAsync(200);
    expect(w.frames).toHaveLength(2);
    expect(result).toEqual({ id: "page-total", seen: ["1"] });
  });

  it("a page frame that takes focus hands it back unscrolled, and a page that loads a second document fails", async () => {
    vi.useFakeTimers();
    const w = fakeWindow();
    w.show("visible");
    const before = { focus: vi.fn() };
    let result: unknown;
    void runPage("page-filter", page, script, 5000, { origin: SERVER, token: "t" }, before as never).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    const frame = w.frames[0] as unknown as EventTarget;
    frame.dispatchEvent(new Event("focus"));
    expect(before.focus).toHaveBeenCalledWith({ preventScroll: true });
    frame.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBeUndefined();
    frame.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toEqual({ id: "page-filter", seen: [], error: "The page left for another address." });
  });
});

/**
 * The harness in a page of two elements: an input and an output that shows what the page's own
 * listener wrote. Node has Event and EventTarget; the key and input events are those with their key
 * and data, as a browser's carry them.
 */
function framePage(listen: (input: EventTarget & { value: string }, out: { textContent: string }) => void) {
  class Key extends Event { constructor(type: string, init: EventInit & { key: string }) { super(type, init); this.key = init.key; } key: string; }
  class Typed extends Event { constructor(type: string, init: EventInit & { data: string }) { super(type, init); this.data = init.data; } data: string; }
  const input = Object.assign(new EventTarget(), { value: "" });
  const out = { textContent: "" };
  const frame = new EventTarget();
  const posted: unknown[] = [];
  listen(input, out);
  vi.stubGlobal("KeyboardEvent", Key);
  vi.stubGlobal("InputEvent", Typed);
  vi.stubGlobal("HTMLInputElement", function HTMLInputElement() {});
  vi.stubGlobal("HTMLTextAreaElement", function HTMLTextAreaElement() {});
  vi.stubGlobal("HTMLSelectElement", function HTMLSelectElement() {});
  vi.stubGlobal("document", { querySelector: (t: string) => (t === "#qty" ? input : t === "#out" ? out : null) });
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  vi.stubGlobal("addEventListener", frame.addEventListener.bind(frame));
  vi.stubGlobal("parent", { postMessage: (m: unknown) => posted.push(m) });
  return { load: () => frame.dispatchEvent(new Event("load")), posted };
}

describe("the page harness", () => {
  it("types into a field as a person does, so a page that listens only on keyup sees it", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const p = framePage((input, out) => {
      for (const type of ["keydown", "keypress", "beforeinput", "input", "keyup", "change"]) input.addEventListener(type, (e) => events.push(`${type}:${(e as Event & { key?: string; data?: string }).key ?? (e as Event & { data?: string }).data ?? ""}:${input.value}`));
      input.addEventListener("keyup", () => { out.textContent = `${Number(input.value) * 2}`; });
    });
    harness("t", [{ do: "fill", target: "#qty", text: "21" }, { do: "read", target: "#out" }], 10);
    p.load();
    await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();
    expect(p.posted).toEqual([{ token: "t", seen: ["42"] }]);
    // in a person's order, the value there by the input event and the keyup
    expect(events).toEqual([
      "keydown:2:", "keypress:2:", "beforeinput:2:", "input:2:2", "keyup:2:2",
      "keydown:1:2", "keypress:1:2", "beforeinput:1:2", "input:1:21", "keyup:1:21",
      "change::21",
    ]);
  });

  it("clears what a field holds as a person does, so a page that listens on input sees it emptied", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const p = framePage((input, out) => {
      for (const type of ["keydown", "keypress", "beforeinput", "input", "keyup", "change"]) input.addEventListener(type, (e) => events.push(`${type}:${(e as Event & { key?: string }).key ?? ""}:${input.value}`));
      input.addEventListener("input", () => { out.textContent = `[${input.value}]`; });
    });
    harness("t", [{ do: "fill", target: "#qty", text: "ER" }, { do: "read", target: "#out" }, { do: "fill", target: "#qty", text: "" }, { do: "read", target: "#out" }], 10);
    p.load();
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    expect(p.posted).toEqual([{ token: "t", seen: ["[ER]", "[]"] }]);
    // the second fill: Backspace over what was there, then change
    expect(events.slice(-5)).toEqual(["keydown:Backspace:ER", "beforeinput::ER", "input::", "keyup:Backspace:", "change::"]);
  });

  it("a key the page cancels is not typed, as for a person", async () => {
    vi.useFakeTimers();
    const p = framePage((input, out) => {
      input.addEventListener("keydown", (e) => { if ((e as Event & { key: string }).key === "x") e.preventDefault(); });
      input.addEventListener("keyup", () => { out.textContent = input.value; });
    });
    harness("t", [{ do: "fill", target: "#qty", text: "1x2" }, { do: "read", target: "#out" }], 10);
    p.load();
    await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();
    expect(p.posted).toEqual([{ token: "t", seen: ["12"] }]);
  });
});

class FakeElement {
  textContent: string;
  shown: boolean;
  visibility: string;
  constructor(textContent: string, shown = true, visibility = "visible") {
    this.textContent = textContent;
    this.shown = shown;
    this.visibility = visibility;
  }
  getClientRects() { return this.shown ? [{}] : []; }
}
class FakeInput extends FakeElement { value = ""; }
class FakeTextArea extends FakeElement { value = ""; }
class FakeSelect extends FakeElement { value = ""; }

async function seenOn(elements: Record<string, FakeElement[]>, steps: Parameters<typeof harness>[1]): Promise<unknown[]> {
  vi.useFakeTimers();
  const frame = new EventTarget();
  const posted: unknown[] = [];
  vi.stubGlobal("HTMLInputElement", FakeInput);
  vi.stubGlobal("HTMLTextAreaElement", FakeTextArea);
  vi.stubGlobal("HTMLSelectElement", FakeSelect);
  vi.stubGlobal("document", { querySelector: (t: string) => elements[t]?.[0] ?? null, querySelectorAll: (t: string) => elements[t] ?? [] });
  vi.stubGlobal("getComputedStyle", (el: FakeElement) => ({ visibility: el.visibility }));
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  vi.stubGlobal("addEventListener", frame.addEventListener.bind(frame));
  vi.stubGlobal("parent", { postMessage: (m: unknown) => posted.push(m) });
  harness("t", steps, 10);
  frame.dispatchEvent(new Event("load"));
  await vi.advanceTimersByTimeAsync(200);
  vi.useRealTimers();
  return posted;
}

describe("what the page harness notes", () => {
  it("a read of a field notes what the field holds, not its text; any other element, its text", async () => {
    const qty = Object.assign(new FakeInput(""), { value: " 21 " });
    const note = Object.assign(new FakeTextArea("default words"), { value: "typed words" });
    const size = Object.assign(new FakeSelect("Small Large"), { value: "large" });
    const posted = await seenOn({ "#qty": [qty], "#note": [note], "#size": [size], "#out": [new FakeElement(" 42 ")] },
      [{ do: "read", target: "#qty" }, { do: "read", target: "#note" }, { do: "read", target: "#size" }, { do: "read", target: "#out" }, { do: "read", target: "#gone" }]);
    expect(posted).toEqual([{ token: "t", seen: ["21", "typed words", "large", "42", ""] }]);
  });

  it("visible notes only the matches on screen, their text joined by a bar", async () => {
    const rows = [new FakeElement(" Milk "), new FakeElement("Folded away", false), new FakeElement("Hidden", true, "hidden"), new FakeElement("Eggs")];
    const posted = await seenOn({ ".item": rows, ".none": [] }, [{ do: "visible", target: ".item" }, { do: "visible", target: ".none" }]);
    expect(posted).toEqual([{ token: "t", seen: ["Milk|Eggs", ""] }]);
  });
});
