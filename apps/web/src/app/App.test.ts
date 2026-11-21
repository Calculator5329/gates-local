// The app shell mounted for real (react-dom on the fake DOM), with the composer, the tooltip layer
// and every screen's code stubbed: the setup icons, a phone's Settings list and bar, export,
// where a menu opens, what Tab, a swipe and a resize do, and what goes inert under what.
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Message, Settings, Source } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame } from "../../test/fake-dom.ts";
import { installBrowser } from "../../test/harness.ts";
import type { State } from "../lib/store/store.ts";

const fakes = vi.hoisted(() => ({
  call: (_method: string, _params: unknown): Promise<unknown> => Promise.reject(new Error("not connected")),
  saved: [] as { name: string; text: Promise<string> }[],
  kept: [] as string[],
}));
vi.mock("../composer/Composer.tsx", () => ({ Composer: () => null, CountMenu: () => null, OptsMenu: () => null, PlusMenu: () => null }));
vi.mock("../lib/ui/ui.tsx", async (original) => ({ ...await original<typeof import("../lib/ui/ui.tsx")>(), Tip: () => null }));
vi.mock("./screen-loaders.ts", () => {
  const error = { kind: "error" };
  const failed = () => ({ get: () => error, subscribe: () => () => undefined, need: () => () => undefined, load: () => Promise.resolve() });
  return { settingsScreen: failed(), firstRunScreen: failed(), pickerScreen: failed(), imagePickerScreen: failed(), threadScreen: failed(), usageScreen: failed(), picturesScreen: failed(), measureScreen: failed() };
});
vi.mock("./sheet-focus.ts", () => ({ keepSheetFocus: (sheet: HTMLElement) => { fakes.kept.push(sheet.id); return () => { fakes.kept.push(`-${sheet.id}`); }; } }));
vi.mock("../lib/ui/kit/async.ts", async (original) => ({
  ...await original<typeof import("../lib/ui/kit/async.ts")>(),
  downloadBlob: (blob: Blob, name: string) => { fakes.saved.push({ name, text: blob.text() }); },
}));
vi.mock("../lib/session/index.ts", async (original) => ({
  ...await original<typeof import("../lib/session/index.ts")>(),
  call: (method: string, params: unknown) => fakes.call(method, params),
}));

const SETTINGS: Settings = methodSamples["settings.get"].result;
const SOURCE: Source = methodSamples["sources.list"].result[0]!;
const media = { phone: false, touch: false };
let doc: FakeDocument;
let root: Root;
let store: typeof import("../lib/store/store.ts");
let App: typeof import("./App.tsx")["App"];
let listeners: Map<string, ((e: unknown) => void)[]>;
let initial: State;
let createRoot: typeof import("react-dom/client")["createRoot"];

beforeEach(async () => {
  installBrowser();
  Object.assign(media, { phone: false, touch: false });
  Object.assign(fakes, { call: () => Promise.reject(new Error("not connected")), saved: [], kept: [] });
  listeners = new Map();
  const listen = (t: string, l: (e: unknown) => void) => { listeners.set(t, [...listeners.get(t) ?? [], l]); };
  doc = new FakeDocument();
  Object.assign(doc, { addEventListener: listen, removeEventListener() {} });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("Node", FakeElement);
  vi.stubGlobal("HTMLIFrameElement", FakeIFrame);
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 900);
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("addEventListener", listen);
  vi.stubGlobal("removeEventListener", () => undefined);
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q === "(max-width: 640px)" ? media.phone : q === "(hover: none)" ? media.touch : false,
    addEventListener() {},
    removeEventListener() {},
  }));
  // one import for the file: the partial mocks above keep the modules of their first import
  if (store === undefined) {
    ({ createRoot } = await import("react-dom/client"));
    store = await import("../lib/store/store.ts");
    const shell = await import("./App.tsx");
    App = shell.App;
    // why: the entry starts the shell's store followers once; this file keeps them for all its tests
    shell.watchApp();
    initial = store.getState();
  }
  store.setState(initial);
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(state: Partial<State> = {}) {
  store.setState(state);
  await act(async () => { root.render(createElement(App)); });
  await settle();
}
const set = async (state: Partial<State>) => { await act(async () => { store.setState(state); }); await settle(); };
const all = (selector: string) => doc.querySelectorAll(selector);
const one = (selector: string) => doc.querySelector(selector);
const inert = (selector: string) => one(selector)?.getAttribute("inert") ?? null;
const props = (el: FakeElement | null): Record<string, unknown> => {
  if (el === null) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const click = async (selector: string) => { await act(async () => { (props(one(selector))["onClick"] as () => void)(); }); await settle(); };
const fire = async (type: string, event: Record<string, unknown>) => {
  await act(async () => { for (const l of listeners.get(type) ?? []) l({ preventDefault: () => undefined, ...event }); });
  await settle();
};
const thread = (id: string, title: string) => ({ id, title, createdAt: 1, updatedAt: 1 }) as State["threads"][number];
const msg = (id: string, content: string): Message => ({ id, threadId: "t1", role: "user", content, createdAt: 1 });
const OPEN: Partial<State> = { view: "thread", threadId: "t1", threads: [thread("t1", "Plan")] };

/** What a phone's Settings list row shows at its end. */
const sectionValue = (id: string) => one(`[data-testid="settings.sections.open-${id}"] .val`)?.textContent ?? null;
/** Press Tab; whether the app kept it from the browser. */
async function tab(shiftKey = false) {
  let stopped = false;
  await fire("keydown", { key: "Tab", shiftKey, preventDefault: () => { stopped = true; } });
  return stopped;
}
const inside = (box: string) => doc.activeElement !== null && one(box)?.contains(doc.activeElement) === true;
async function swipe(target: FakeElement | null, from: number, to: number) {
  await fire("touchstart", { target, touches: [{ clientY: from }] });
  await fire("touchend", { changedTouches: [{ clientY: to }] });
}

it("a phone's Settings Back goes to the section list from any section, the Models download page too, at the top", async () => {
  media.phone = true;
  const scrolled = vi.spyOn(FakeElement.prototype, "scrollTo");
  await mount({ ...OPEN, view: "settings", section: "models", addPage: true, setList: false });
  expect(one(".set-bar h2")?.textContent).toBe("Models");
  expect(one("[data-testid=\"settings.shell.back\"]")?.getAttribute("aria-label")).toBe("Back to Settings");
  expect(one("[data-testid=\"settings.shell.done\"]")).toBeNull();
  await click("[data-testid=\"settings.shell.back\"]");
  expect(store.getState().setList).toBe(true);
  expect(scrolled.mock.contexts.map((el) => (el as FakeElement).classList.includes("set"))).toEqual([true]);
  expect(one(".set-bar h2")?.textContent).toBe("Settings");
  expect(one("[data-testid=\"settings.shell.done\"]")).not.toBeNull();
});

it("a phone's Settings list ends each row with what its section is set to", async () => {
  media.phone = true;
  await mount({
    ...OPEN, view: "settings", section: "general", setList: true, conn: { kind: "open" },
    runtime: methodSamples["runtime.status"].result, settings: { ...SETTINGS, theme: "dark", tools: true, imageGen: false }, sources: [SOURCE, { ...SOURCE, id: "s2" }],
  });
  expect([sectionValue("general"), sectionValue("runtime"), sectionValue("tools"), sectionValue("images"), sectionValue("library"), sectionValue("shortcuts")]).toEqual(["Dark", "Running", "On", "Off", "2 sources", null]);
  await set({ sources: [SOURCE] });
  expect(sectionValue("library")).toBe("1 source");
});

it("a phone's Settings list says the runtime's install step and failure in the words the banner uses", async () => {
  media.phone = true;
  const runtime = methodSamples["runtime.status"].result;
  await mount({ ...OPEN, view: "settings", setList: true, conn: { kind: "open" }, runtime: { ...runtime, state: "installing", install: { receivedBytes: 5, totalBytes: 5 } } });
  expect(sectionValue("runtime")).toBe("Unpacking Ollama");
  await set({ runtime: { ...runtime, state: "error", failure: "checksum" } });
  expect(sectionValue("runtime")).toBe("Couldn't verify download");
  await set({ runtime: { ...runtime, state: "error" } });
  expect(sectionValue("runtime")).toBe("Didn't start");
});

it("Export as Markdown gives up on a load after eight seconds and says the thread took too long", async () => {
  fakes.call = () => new Promise(() => undefined);
  await mount({ ...OPEN, pop: { id: "thread", kb: false, thread: "t1" } });
  vi.useFakeTimers();
  await act(async () => { (props(one("[data-testid=\"sidebar.thread-menu.export\"]"))["onClick"] as () => void)(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(7_999); });
  expect(store.getState().notice).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(store.getState().notice).toBe("Couldn't export “Plan”: it took too long to load. Try again.");
  expect(fakes.saved).toEqual([]);
});

it("an export whose load fails says it didn't load, and makes no file", async () => {
  await mount({ ...OPEN, pop: { id: "thread", kb: false, thread: "t1" } });
  await click("[data-testid=\"sidebar.thread-menu.export\"]");
  expect(store.getState().notice).toBe("Couldn't export “Plan”: it didn't load. Try again.");
  expect(fakes.saved).toEqual([]);
});

it("an export makes its file from its own load of the thread, not the copy already in hand", async () => {
  const asked: unknown[] = [];
  fakes.call = (method, params) => { asked.push([method, params]); return Promise.resolve({ messages: [msg("m1", "kept in hand"), msg("m2", "added in another window")] }); };
  await mount({ ...OPEN, messages: { t1: [msg("m1", "kept in hand")] }, pop: { id: "thread", kb: false, thread: "t1" } });
  await click("[data-testid=\"sidebar.thread-menu.export\"]");
  expect(asked).toEqual([["threads.get", { threadId: "t1" }]]);
  expect(fakes.saved.map((f) => f.name)).toEqual(["Plan.md"]);
  expect(await fakes.saved[0]?.text).toContain("added in another window");
});

it("a menu opened at a point opens below it, above it where it would leave the window, and never past an edge", async () => {
  vi.stubGlobal("innerWidth", 1280);
  await mount(OPEN);
  const menu = one("#threadMenu");
  if (menu === null) throw new Error("no thread menu");
  Object.assign(menu, { offsetWidth: 180, offsetHeight: 200 });
  await set({ pop: { id: "thread", kb: false, thread: "t1", at: { x: 40, y: 100 } } });
  expect([menu.style["top"], menu.style["left"]]).toEqual(["100px", "40px"]);
  await set({ pop: { id: "thread", kb: false, thread: "t1", at: { x: 1250, y: 700 } } });
  expect([menu.style["top"], menu.style["left"]]).toEqual(["500px", "1092px"]);
  await set({ pop: { id: "thread", kb: false, thread: "t1", at: { x: 2, y: 150 } } });
  expect(menu.style["left"]).toBe("8px");
});

it("Tab stays inside the Usage pop-up, Settings, Models and the open drawer, and goes where it likes otherwise", async () => {
  await mount(OPEN);
  expect(await tab()).toBe(false);
  for (const [state, box] of [[{ panel: "usage" }, ".dlg"], [{ view: "settings", section: "general" }, ".dlg"], [{ view: "settings", section: "models" }, ".dlg"], [{ view: "thread", drawer: true }, ".sb"]] as const) {
    await set({ ...OPEN, panel: null, drawer: false, ...state });
    doc.activeElement = null;
    expect(await tab(), box).toBe(true);
    expect(inside(box), JSON.stringify(state)).toBe(true);
    await tab(true);
    expect(inside(box), JSON.stringify(state)).toBe(true);
  }
});

it("on a phone a swipe of 48 px down a sheet's title row closes the sheet; a shorter one, or one from its button, does not", async () => {
  media.phone = true;
  await mount({ ...OPEN, pop: { id: "thread", kb: false, thread: "t1" } });
  const row = one("#threadMenu .sh-h");
  const close = one("#threadMenu .sh-h button");
  await swipe(row, 100, 147);
  expect(store.getState().pop).not.toBeNull();
  await swipe(close, 100, 200);
  expect(store.getState().pop).not.toBeNull();
  await swipe(one("#threadMenu .mi"), 100, 200);
  expect(store.getState().pop).not.toBeNull();
  await swipe(row, 100, 148);
  expect(store.getState().pop).toBeNull();
});

it("a resize closes an open menu and, from 1024 px wide, the drawer; a touch keyboard, which changes only the height, closes nothing", async () => {
  media.touch = true;
  await mount({ ...OPEN, drawer: true, pop: { id: "thread", kb: false, thread: "t1" } });
  vi.stubGlobal("innerHeight", 400);
  await fire("resize", {});
  expect([store.getState().pop?.id, store.getState().drawer]).toEqual(["thread", true]);
  vi.stubGlobal("innerWidth", 1000);
  await fire("resize", {});
  expect([store.getState().pop, store.getState().drawer]).toEqual([null, true]);
  vi.stubGlobal("innerWidth", 1024);
  await fire("resize", {});
  expect(store.getState().drawer).toBe(false);
});

it("on a phone an open sheet keeps the focus inside it for as long as it is drawn", async () => {
  await mount({ ...OPEN, pop: { id: "thread", kb: false, thread: "t1" } });
  expect(fakes.kept).toEqual([]);
  await set({ pop: null });
  media.phone = true;
  await set({ pop: { id: "thread", kb: false, thread: "t1" } });
  expect(fakes.kept).toEqual(["threadMenu"]);
  await set({ pop: null });
  expect(fakes.kept).toEqual(["threadMenu", "-threadMenu"]);
});

it("leaving Settings forgets the phone's section list, so Settings opens next on a section", async () => {
  media.phone = true;
  await mount({ ...OPEN, view: "settings", setList: true });
  await set({ view: "settings", section: "tools" });
  expect(store.getState().setList).toBe(true);
  await set({ view: "thread" });
  expect(store.getState().setList).toBe(false);
});

it("first run and No Server cover the app: the sidebar and the chat under them take no focus or clicks", async () => {
  await mount(OPEN);
  expect([inert("main.main"), inert(".first")]).toEqual([null, null]);
  await set({ view: "firstrun" });
  expect(one(".first")).not.toBeNull();
  expect(inert("main.main")).not.toBeNull();
  expect(one(".sb")?.closest("[inert]")).not.toBeNull();
  await set({ view: "thread", conn: { kind: "no-server" } });
  expect(inert("main.main")).not.toBeNull();
  expect(one(".sb")?.closest("[inert]")).not.toBeNull();
});

it("under the Usage pop-up, Models, Settings or a phone's open sheet the whole window takes nothing", async () => {
  await mount(OPEN);
  expect(inert("#app")).toBeNull();
  for (const state of [{ panel: "usage" }, { view: "settings", section: "models" }, { view: "settings", section: "general" }] as const) {
    await set({ ...OPEN, panel: null, ...state });
    expect(inert("#app"), JSON.stringify(state)).not.toBeNull();
  }
  await set({ ...OPEN, panel: null, pop: { id: "thread", kb: false, thread: "t1" } });
  expect(inert("#app")).toBeNull();
  media.phone = true;
  await set({ pop: null });
  await set({ pop: { id: "thread", kb: false, thread: "t1" } });
  expect(inert("#app")).not.toBeNull();
});

it("Pictures draws no app header or Settings bar of its own", async () => {
  await mount(OPEN);
  expect(all(".hdr").length).toBe(1);
  await set({ view: "pictures" });
  expect(all(".hdr")).toHaveLength(0);
  expect(one(".pics")).not.toBeNull();
});

it("on a phone Settings and Pictures lie over the chat, which stays mounted under them and takes nothing", async () => {
  media.phone = true;
  await mount(OPEN);
  for (const view of ["settings", "pictures"] as const) {
    await set({ view });
    const stage = one(".stage");
    expect(stage?.classList, view).toContain("under");
    expect(stage?.getAttribute("inert"), view).not.toBeNull();
    expect(stage?.querySelector(".cw"), view).not.toBeNull();
    await set({ view: "thread" });
    expect(one(".stage")?.getAttribute("inert")).toBeNull();
  }
});

it("an open sheet sits over a scrim that closes it", async () => {
  media.phone = true;
  await mount(OPEN);
  expect(one("[data-testid=\"ui.pop.scrim\"]")).toBeNull();
  await set({ pop: { id: "thread", kb: false, thread: "t1" } });
  await click("[data-testid=\"ui.pop.scrim\"]");
  expect(store.getState().pop).toBeNull();
});

it("under the Usage pop-up the chat stays mounted: the same timeline and composer nodes as before it opened", async () => {
  await mount(OPEN);
  const timeline = one(".stage .tl");
  const composer = one(".stage .cw");
  expect([timeline, composer]).not.toContain(null);
  await set({ panel: "usage" });
  expect(one(".dlg")).not.toBeNull();
  expect(one(".stage .tl")).toBe(timeline);
  expect(one(".stage .cw")).toBe(composer);
});

interface Fiber { readonly type: unknown; readonly child: Fiber | null; readonly sibling: Fiber | null; readonly stateNode: { readonly current?: Fiber } | null }
const children = (fiber: Fiber): Fiber[] => {
  const out: Fiber[] = [];
  for (let c = fiber.child; c !== null; c = c.sibling) out.push(c);
  return out;
};
const everyFiber = (fiber: Fiber): Fiber[] => [fiber, ...children(fiber).flatMap(everyFiber)];

it("the app's after-commit work is drawn once, as the last thing the app draws", async () => {
  const { CommitJobs } = await import("../lib/ui/kit/focus.ts");
  await mount(OPEN);
  const container = doc.body.childNodes[0] as unknown as Record<string, Fiber>;
  const key = Object.keys(container).find((k) => k.startsWith("__reactContainer$"));
  const app = key === undefined ? undefined : container[key]?.stateNode?.current?.child;
  if (app === undefined || app === null) throw new Error("no app drawn");
  expect(app.type).toBe(App);
  expect(children(app).at(-1)?.type).toBe(CommitJobs);
  expect(everyFiber(app).filter((f) => f.type === CommitJobs)).toHaveLength(1);
});
