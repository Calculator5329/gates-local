// The Pictures screen mounted for real (react-dom on the fake DOM): picks, keys, the inspector,
// the large view and where the sheet scrolls. The look and the phone sheet's place have E2E coverage.
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Picture, PictureList, PictureListParams } from "@gates-local/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

const h = vi.hoisted(() => ({
  list: vi.fn<(params: PictureListParams) => Promise<PictureList>>(),
  openThread: vi.fn(), send: vi.fn(), openSettings: vi.fn(), openDrawer: vi.fn(),
  replaceDraft: vi.fn(), focusComposer: vi.fn(), downloadBlob: vi.fn(), requestFocus: vi.fn(),
  chosen: undefined as unknown, phone: false, width: 1000, height: 600, fetchOk: true,
  observers: [] as (() => void)[],
}));
vi.mock("../lib/session/index.ts", async () => {
  const { createPictures } = await import("./pictures.ts");
  return { pictures: createPictures({ list: (params) => h.list(params) }), openThread: h.openThread, send: h.send, openSettings: h.openSettings };
});
vi.mock("../sidebar/Sidebar.tsx", () => ({ openDrawer: h.openDrawer }));
vi.mock("../lib/store/drafts.ts", async (original) => ({ ...await original<typeof import("../lib/store/drafts.ts")>(), replaceDraft: h.replaceDraft }));
vi.mock("../composer/focus.ts", async (original) => ({ ...await original<typeof import("../composer/focus.ts")>(), focusComposer: h.focusComposer }));
vi.mock("../lib/ui/kit/async.ts", async (original) => ({ ...await original<typeof import("../lib/ui/kit/async.ts")>(), downloadBlob: h.downloadBlob }));
vi.mock("../lib/ui/kit/focus.ts", async (original) => ({ ...await original<typeof import("../lib/ui/kit/focus.ts")>(), requestFocus: h.requestFocus }));
vi.mock("../lib/ui/ui.tsx", async (original) => ({ ...await original<typeof import("../lib/ui/ui.tsx")>(), useMedia: () => h.phone }));
vi.mock("../image/image-choice.ts", async (original) => ({ ...await original<typeof import("../image/image-choice.ts")>(), chosenImage: () => h.chosen }));

const doc = new FakeDocument();
/** The fake's class list is an array; the screen asks it `contains`, as a DOMTokenList answers. */
const classes = Object.getOwnPropertyDescriptor(FakeElement.prototype, "classList") ?? {};
const keyListeners: ((e: unknown) => void)[] = [];
let root: Root;
let store: typeof import("../lib/store/store.ts");
let pictures: typeof import("../lib/session/index.ts")["pictures"];

const NOW = new Date(2026, 10, 16, 12).getTime();
const TODAY = new Date(2026, 10, 16, 9, 5).getTime();
const YESTERDAY = new Date(2026, 10, 15, 21, 30).getTime();
const pic = (jobId: string, more: Partial<Picture> = {}): Picture => ({
  jobId, threadId: "t1", threadTitle: "Ships", prompt: `prompt ${jobId}`, width: 1600, height: 900,
  queuedAt: 1, doneAt: TODAY, bytes: 3, imagePath: `images/${jobId}.png`, ...more,
});
const many = (n: number, more: Partial<Picture> = {}) => Array.from({ length: n }, (_, i) => pic(`p${i}`, more));

const SELECTORS: Record<string, (el: FakeElement) => boolean> = {
  input: (el) => el.tagName === "INPUT", textarea: (el) => el.tagName === "TEXTAREA", button: (el) => el.tagName === "BUTTON",
  "[contenteditable]": (el) => el.hasAttribute("contenteditable"),
};
function up(el: FakeNode | null, tests: readonly ((el: FakeElement) => boolean)[]): FakeElement | null {
  if (!(el instanceof FakeElement)) return null;
  return tests.some((t) => t(el)) ? el : up(el.parentNode, tests);
}
function closest(this: FakeElement, selectors: string): FakeElement | null {
  return up(this, selectors.split(",").map((s) => SELECTORS[s.trim()] ?? (() => false)));
}

beforeAll(async () => {
  const win = {
    document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: number) => clearTimeout(id),
  };
  doc.defaultView = win;
  Object.assign(doc, {
    addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === "keydown") keyListeners.push(fn); },
    removeEventListener: (type: string, fn: (e: unknown) => void) => { const i = keyListeners.indexOf(fn); if (type === "keydown" && i >= 0) keyListeners.splice(i, 1); },
  });
  Object.assign(FakeElement.prototype, { closest });
  // The sheet listens for its own scroll, as a browser element does; scrollTo fires it.
  Object.assign(FakeElement.prototype, {
    addEventListener(this: FakeElement, type: string, fn: () => void) { if (type === "scroll") scrollers.set(this, fn); },
    removeEventListener(this: FakeElement, type: string) { if (type === "scroll") scrollers.delete(this); },
  });
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag: string) => Object.assign(create(tag), { clientHeight: h.height });
  Object.defineProperty(FakeElement.prototype, "clientWidth", { configurable: true, get: () => h.width });
  Object.defineProperty(FakeElement.prototype, "classList", { configurable: true, get(this: FakeElement) {
    const list = classes.get?.call(this) as string[];
    return Object.assign(list, { contains: (c: string) => list.includes(c) });
  } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  vi.stubGlobal("ResizeObserver", class { constructor(measure: () => void) { h.observers.push(measure); } observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url: string) => ({ ok: h.fetchOk, status: 500, blob: async () => ({ type: "image/png", url }) }));
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  ({ pictures } = await import("../lib/session/index.ts"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => {
  act(() => root.unmount());
  delete (FakeElement.prototype as Partial<{ closest: unknown }>).closest;
  delete (FakeElement.prototype as Partial<{ addEventListener: unknown }>).addEventListener;
  delete (FakeElement.prototype as Partial<{ removeEventListener: unknown }>).removeEventListener;
  delete (FakeElement.prototype as Partial<{ clientWidth: unknown }>).clientWidth;
  Object.defineProperty(FakeElement.prototype, "classList", classes);
  vi.unstubAllGlobals();
});

const scrollers = new Map<FakeElement, () => void>();
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
/** Opens the screen on these pictures, the newest picked. */
async function open(list: readonly Picture[], more: Partial<PictureList> = {}) {
  h.list.mockImplementation(async () => ({ pictures: list, count: list.length, ...more }));
  await act(async () => { pictures.select([]); await pictures.enter(); });
  const { Pictures } = await import("./Pictures.tsx");
  act(() => root.render(createElement(Pictures)));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.phone = false; h.width = 1000; h.height = 600; h.fetchOk = true; h.chosen = undefined; h.observers.length = 0;
  store.setState({ settings: undefined, image: false, pop: null, panel: null, drawer: false });
});
afterEach(() => { act(() => root.render(null)); vi.useRealTimers(); });

function all(pred: (el: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (pred(c)) out.push(c); walk(c); } };
  walk(doc.body);
  return out;
}
const byTestId = (id: string) => all((el) => el.getAttribute("data-testid") === id)[0] ?? null;
const byClass = (cls: string) => all((el) => el.classList.includes(cls));
const tile = (id: string) => all((el) => el.getAttribute("data-job") === id)[0] ?? null;
const props = (el: FakeElement | null): Record<string, unknown> => {
  if (el === null) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const click = async (el: FakeElement | null, e: Record<string, unknown> = {}) => {
  await act(async () => { (props(el)["onClick"] as (e: unknown) => void)({ ctrlKey: false, metaKey: false, shiftKey: false, ...e }); });
  await settle();
};
const key = async (k: string, target: FakeElement | null = doc.body) => {
  await act(async () => { for (const l of keyListeners) l({ key: k, target, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} }); });
  await settle();
};
const sel = () => pictures.get().sel;
const icon = (el: FakeElement | null) => el === null ? undefined : all((x) => x.tagName === "use" && el.contains(x))[0]?.getAttribute("href");
/** The facts list as "term: value" pairs. */
const facts = () => {
  const dl = byClass("pics-facts")[0];
  if (dl === undefined) return {};
  const cells = dl.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  return Object.fromEntries(cells.flatMap((c, i) => c.tagName === "DT" ? [[c.textContent, cells[i + 1]?.textContent]] : []));
};
const save = () => byTestId("pictures.actions.download");
const scroller = () => byClass("pics-sheet")[0] ?? null;
/** The sheet's window: its height, then a measure as the resize observer would. */
const sized = async (height: number) => {
  const el = scroller();
  if (el === null) throw new Error("no sheet");
  el.clientHeight = height;
  await act(async () => { for (const measure of h.observers) measure(); });
  await settle();
};
const scrollTo = async (top: number) => {
  const el = scroller();
  if (el === null) throw new Error("no sheet");
  el.scrollTop = top;
  await act(async () => { scrollers.get(el)?.(); });
  await settle();
};
const topOf = (el: FakeElement | null) => Number.parseFloat(String(el?.style["top"]));
const heightOf = (el: FakeElement | null) => Number.parseFloat(String(el?.style["height"]));

describe("one picture in the inspector", () => {
  it("says when it was made: the clock today, else its day and the clock", async () => {
    await open([pic("a"), pic("b", { doneAt: YESTERDAY })]);
    expect(facts()["Made"]).toBe("9:05 AM");
    await act(async () => { pictures.select(["b"]); });
    expect(facts()["Made"]).toBe("Yesterday · 9:30 PM");
  });

  it("says how long it took in whole seconds, with one decimal under ten", async () => {
    await open([pic("a", { runMs: 19_400 }), pic("b", { runMs: 4_200 })]);
    expect(facts()["Took"]).toBe("19 s");
    await act(async () => { pictures.select(["b"]); });
    expect(facts()["Took"]).toBe("4.2 s");
  });

  it("Again sends the same prompt in its thread with the picture's own setup, else the setup an image send runs now, else none", async () => {
    await open([pic("a", { preset: "photo" }), pic("b"), pic("c")]);
    await click(byTestId("pictures.actions.again"));
    expect(h.openThread).toHaveBeenCalledWith("t1");
    expect(h.send).toHaveBeenLastCalledWith("prompt a", { reuseThread: true, keepDraft: true, draw: { preset: "photo", width: 1600, height: 900 } });
    h.chosen = { preset: { id: "art" }, width: 1024, height: 768 };
    await act(async () => { pictures.select(["b"]); });
    await click(byTestId("pictures.actions.again"));
    expect(h.send).toHaveBeenLastCalledWith("prompt b", { reuseThread: true, keepDraft: true, draw: { preset: "art", width: 1024, height: 768 } });
    h.chosen = undefined;
    await act(async () => { pictures.select(["c"]); });
    await click(byTestId("pictures.actions.again"));
    expect(h.send).toHaveBeenLastCalledWith("prompt c", { reuseThread: true, keepDraft: true });
  });

  it("Edit prompt opens its thread with the prompt in the message box and Image on", async () => {
    await open([pic("a", { threadId: "t9" })]);
    await click(byTestId("pictures.actions.edit-prompt"));
    expect(h.openThread).toHaveBeenCalledWith("t9");
    expect(h.replaceDraft).toHaveBeenCalledWith("t9", { text: "prompt a" });
    expect(store.getState().image).toBe(true);
    expect(h.focusComposer).toHaveBeenCalledWith(true);
  });

  it("Save names the file from the prompt's first words and the seed, else the job's first characters", async () => {
    const long = "abcdefg ".repeat(10);
    await open([pic("a", { prompt: "A red fox, on snow!", seed: 42 }), pic("b", { prompt: long, seed: 7 }), pic("abcdefghij", { prompt: "!!!" })]);
    await click(byTestId("pictures.actions.download"));
    expect(h.downloadBlob).toHaveBeenLastCalledWith({ type: "image/png", url: "/files/images/a.png" }, "a-red-fox-on-snow-42.png");
    await act(async () => { pictures.select(["b"]); });
    await click(byTestId("pictures.actions.download"));
    const name = String(h.downloadBlob.mock.lastCall?.[1]);
    expect(name).toBe(`${"abcdefg-".repeat(5)}abcdefg-7.png`);
    await act(async () => { pictures.select(["abcdefghij"]); });
    await click(byTestId("pictures.actions.download"));
    expect(h.downloadBlob.mock.lastCall?.[1]).toBe("picture-abcdefgh.png");
  });

  it("Save shows a check when it worked and the alert when it did not, then its own icon again", async () => {
    await open([pic("a")]);
    await click(save());
    expect(icon(save())).toBe("#i-check");
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(icon(save())).toBe("#i-download");
    h.fetchOk = false;
    await click(save());
    expect(icon(save())).toBe("#i-alert");
    expect(save()?.getAttribute("class")).toBe("ibtn red");
    expect(save()?.getAttribute("aria-label")).toBe("Couldn't save");
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(icon(save())).toBe("#i-download");
    expect(save()?.getAttribute("aria-label")).toBe("Save");
  });

  it("on a phone shows one line of facts and puts its thread on a button; the desktop has the facts list instead", async () => {
    await open([pic("a", { preset: "photo" })]);
    expect(byTestId("pictures.actions.open-thread")).toBeNull();
    expect(facts()["Thread"]).toBe("Ships");
    act(() => root.render(null));
    h.phone = true;
    await open([pic("a", { preset: "photo" })]);
    expect(byClass("pics-facts")).toEqual([]);
    expect(byClass("pics-line").map((el) => el.textContent)).toEqual(["photo · 1600×900 · 9:05 AM"]);
    await click(byTestId("pictures.actions.open-thread"));
    expect(h.openThread).toHaveBeenCalledWith("t1");
  });
});

describe("several pictures in the inspector", () => {
  it("says how many, shows their prompt only when they share one, and Clear keeps the last picked", async () => {
    await open([pic("a"), pic("b"), pic("c", { prompt: "prompt a" })]);
    await act(async () => { pictures.select(["a", "b"]); });
    expect(byClass("pics-n")[0]?.textContent).toBe("2 selectedClear");
    expect(byClass("pics-prompt")).toEqual([]);
    await act(async () => { pictures.select(["a", "c"]); });
    expect(byClass("pics-prompt").map((el) => el.textContent)).toEqual(["prompt a"]);
    await click(byTestId("pictures.selection.clear"));
    expect(sel()).toEqual(["c"]);
  });
});

describe("the large view", () => {
  it("shows the original file, with Newer and Older only where there is one", async () => {
    await open(many(3));
    await act(async () => { pictures.setLarge(true); });
    const dialog = byTestId("pictures.large.dialog");
    expect(all((el) => el.tagName === "IMG" && dialog?.contains(el) === true).map((el) => el.getAttribute("src"))).toEqual(["/files/images/p0.png"]);
    expect(byTestId("pictures.large.newer")).toBeNull();
    await click(byTestId("pictures.large.older"));
    await click(byTestId("pictures.large.older"));
    expect(sel()).toEqual(["p2"]);
    expect(byTestId("pictures.large.older")).toBeNull();
    expect(byTestId("pictures.large.newer")).not.toBeNull();
  });
});

describe("keys", () => {
  it("the arrows pick the next or previous picture, stop at the ends, and move focus to its tile unless it is shown large", async () => {
    await open(many(3));
    await key("ArrowLeft");
    expect(sel()).toEqual(["p0"]);
    await key("ArrowRight");
    expect(sel()).toEqual(["p1"]);
    expect(h.requestFocus).toHaveBeenLastCalledWith('.pics-tile[data-job="p1"]', { preventScroll: true });
    await key("ArrowRight");
    await key("ArrowRight");
    expect(sel()).toEqual(["p2"]);
    h.requestFocus.mockClear();
    await act(async () => { pictures.setLarge(true); });
    await key("ArrowLeft");
    expect(sel()).toEqual(["p1"]);
    expect(pictures.get().large).toBe(true);
    expect(h.requestFocus).not.toHaveBeenCalled();
  });

  it("Enter shows the pick large from the page or a tile, never from a field or another button", async () => {
    await open(many(2));
    await key("Enter", byTestId("pictures.search.input"));
    await key("Enter", byTestId("pictures.actions.again"));
    expect(pictures.get().large).toBe(false);
    await key("Enter", tile("p0"));
    expect(pictures.get().large).toBe(true);
    await act(async () => { pictures.setLarge(false); });
    await key("Enter");
    expect(pictures.get().large).toBe(true);
  });
});

describe("picking tiles", () => {
  it("a click picks one; Ctrl or Cmd adds or takes away, in the order picked; Shift picks the run from the last pick", async () => {
    await open(many(5));
    await click(tile("p1"));
    expect(sel()).toEqual(["p1"]);
    await click(tile("p3"), { shiftKey: true });
    expect(sel()).toEqual(["p1", "p2", "p3"]);
    await click(tile("p0"), { shiftKey: true });
    expect(sel()).toEqual(["p0", "p1"]);
    await click(tile("p4"), { ctrlKey: true });
    await click(tile("p2"), { metaKey: true });
    expect(sel()).toEqual(["p0", "p1", "p4", "p2"]);
    await click(tile("p0"), { ctrlKey: true });
    expect(sel()).toEqual(["p1", "p4", "p2"]);
  });

  it("on a phone Ctrl and Shift pick one", async () => {
    h.phone = true;
    await open(many(5));
    await click(tile("p1"));
    await click(tile("p3"), { ctrlKey: true });
    expect(sel()).toEqual(["p3"]);
    await click(tile("p0"), { shiftKey: true });
    expect(sel()).toEqual(["p0"]);
  });

  it("Ctrl on the only pick keeps it, so the inspector always shows one", async () => {
    await open(many(3));
    await click(tile("p1"));
    await click(tile("p1"), { ctrlKey: true });
    expect(sel()).toEqual(["p1"]);
  });
});

it("the pictures list hears the screen is on show while it is drawn, and not once it goes", async () => {
  const shown = vi.spyOn(pictures, "shown");
  await open(many(3));
  expect(shown.mock.calls).toEqual([[true]]);
  act(() => root.render(null));
  expect(shown.mock.calls).toEqual([[true], [false]]);
});

describe("where the sheet scrolls", () => {
  it("a picture joining the top keeps the rows on screen where they were", async () => {
    const old = many(40, { doneAt: YESTERDAY });
    await open(old);
    await scrollTo(500);
    const kept = all((el) => el.classList.includes("pics-tile") && topOf(el) >= 500)[0] ?? null;
    const id = kept?.getAttribute("data-job") ?? "";
    await act(async () => { pictures.select([id]); });
    const onScreen = topOf(tile(id)) - (scroller()?.scrollTop ?? 0);
    h.list.mockImplementation(async () => ({ pictures: [pic("new"), ...old].slice(0, 24), count: 41 }));
    await act(async () => { await pictures.finished(); });
    await settle();
    expect(pictures.get().pictures[0]?.jobId).toBe("new");
    expect(topOf(tile(id))).toBeGreaterThan(topOf(kept));
    expect(topOf(tile(id)) - (scroller()?.scrollTop ?? 0)).toBe(onScreen);
  });

  it("asks for the next page once the window nears the end, and not before", async () => {
    await open(many(200), { next: "n1", count: 400 });
    expect(h.list).toHaveBeenCalledTimes(1);
    const height = heightOf(byClass("pics-rows")[0] ?? null);
    await scrollTo(height - 600 - 1700);
    expect(h.list).toHaveBeenCalledTimes(1);
    await scrollTo(height - 600 - 1500);
    expect(h.list).toHaveBeenLastCalledWith({ limit: 200, before: "n1" });
  });

  it("asks for the next page when the first one does not fill the window", async () => {
    await open(many(5), { next: "n1", count: 400 });
    expect(h.list).toHaveBeenLastCalledWith({ limit: 200, before: "n1" });
  });

  it("keeps the pick in view: a pick below the window scrolls down to its row's bottom, a pick above scrolls up to its row", async () => {
    await open(many(40));
    await sized(400);
    await act(async () => { pictures.select(["p24"]); });
    const below = tile("p24");
    expect(scroller()?.scrollTop).toBe(topOf(below) + heightOf(below) - 400 + 6);
    await act(async () => { pictures.select(["p0"]); });
    expect(scroller()?.scrollTop).toBe(0);
  });
});

describe("an empty sheet", () => {
  it("points at the setup row while images are not set up, else at the Image control", async () => {
    store.setState({ settings: { imageGen: false } as never });
    await open([]);
    expect(byClass("pics-empty")[0]?.textContent).toBe("No pictures yet. Set up images");
    await click(byTestId("pictures.empty.set-up"));
    expect(h.openSettings).toHaveBeenCalledWith("images");
    act(() => root.render(null));
    store.setState({ settings: { imageGen: true } as never });
    await open([]);
    expect(byClass("pics-empty")[0]?.textContent).toBe("No pictures yet. Turn on Image in a chat and send what you want to see.");
  });
});
