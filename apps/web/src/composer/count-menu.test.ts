// The picture count with Image on, mounted for real on the fake DOM: the count menu's times, its keys,
// how its button reads a setup's first time before it opens, and the Image rows of the + and options menus.
import { act, createElement, Fragment } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ImageChoice, ImagePreset, ImagePresets, Settings } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

const calls = vi.hoisted(() => ({
  read: { fn: null as unknown as (choice: ImageChoice) => Promise<void> },
  reads: [] as ImageChoice[],
}));
vi.mock("../lib/session/index.ts", async (original) => ({
  ...await original<typeof import("../lib/session/index.ts")>(),
  readImageRun: (choice: ImageChoice) => { calls.reads.push(choice); return calls.read.fn(choice); },
  pickImageCount: () => Promise.resolve(null),
  openSettings: () => undefined,
}));

const doc = new FakeDocument();
const win = { document: doc, HTMLIFrameElement: FakeIFrame, innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
let root: Root;
let store: typeof import("../lib/store/store.ts");
let composer: typeof import("./Composer.tsx");

const GIB = 1024 ** 3;
const PRESET: ImagePreset = { id: "moss-image", name: "MOSS-Image", family: "moss", measured: false, sizes: [{ width: 1024, height: 1024, bytes: 10 * GIB }, { width: 1024, height: 768, bytes: 10 * GIB }] };
const PRESETS: ImagePresets = { presets: [PRESET], readAt: 1, current: { preset: PRESET, width: 1024, height: 768 } };
const SETTINGS: Settings = { ...methodSamples["settings.get"].result, imageGen: true };
const CHOSEN = `${PRESET.id}:1024x768`;
const OTHER_SIZE = `${PRESET.id}:1024x1024`;

beforeAll(async () => {
  doc.defaultView = win;
  const make = doc.createElement.bind(doc);
  Object.assign(doc, {
    addEventListener() {},
    removeEventListener() {},
    createElement: (tag: string) => tag === "textarea" ? Object.assign(make(tag), { value: "", setSelectionRange() {} }) : make(tag),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  composer = await import("./Composer.tsx");
  composer.watchComposer();
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
beforeEach(() => {
  calls.read.fn = () => Promise.resolve();
  calls.reads.length = 0;
  doc.activeElement = null;
});
afterEach(() => { act(() => root.render(null)); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const pause = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
function all(pred: (el: FakeElement) => boolean, from: FakeNode = doc.body): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (pred(c)) out.push(c); walk(c); } };
  walk(from);
  return out;
}
const byTestId = (id: string) => all((el) => el.getAttribute("data-testid") === id)[0] ?? null;
const props = (el: FakeElement | null): Record<string, unknown> => {
  if (el === null) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const fire = async (el: FakeElement | null, handler: string, event: unknown = {}) => {
  await act(async () => { (props(el)[handler] as (e: unknown) => void)(event); });
  await settle();
};
const times = () => [1, 2, 3, 4].map((n) => all((el) => el.tagName === "SMALL", byTestId(`chat.count-menu.pick-${n}`)!)[0]?.textContent ?? null);
const menuOpen = () => store.getState().pop?.id === "count";
const pick = (n: number) => byTestId(`chat.count-menu.pick-${n}`);

async function mount(element: "menu" | "composer" | "plus" | "opts", over: Partial<import("../lib/store/store.ts").State> = {}) {
  store.setState({
    conn: { kind: "open" }, view: "new", threadId: null, settings: SETTINGS, image: true, imagePresets: PRESETS, imageRuns: {}, imageStatus: undefined,
    models: [methodSamples["models.list"].result.models[0]!], model: methodSamples["models.list"].result.models[0]!.name, pop: null, ...over,
  });
  const { CountMenu, Composer, PlusMenu, OptsMenu } = composer;
  const shown = { menu: [CountMenu], composer: [Composer, CountMenu], plus: [PlusMenu], opts: [OptsMenu] }[element];
  act(() => root.render(createElement(Fragment, null, ...shown.map((c) => createElement(c)))));
  await settle();
}

it("the count menu says each send's time in seconds below 90 s, in minutes from 90 s, and never less than a second", async () => {
  await mount("menu", { imageRuns: { [CHOSEN]: 22_500 } });
  expect(times()).toEqual(["~23 s", "~45 s", "~68 s", "~2 min"]);
  await act(async () => { store.setState({ imageRuns: { [CHOSEN]: 200 } }); });
  expect(times()[0]).toBe("~1 s");
});

it("a picture time belongs to its setup and size: another size of the same setup gives the count menu no time", async () => {
  await mount("menu", { imageRuns: { [OTHER_SIZE]: 5_000 } });
  expect(times()).toEqual([null, null, null, null]);
  await act(async () => { store.setState({ imageRuns: { [OTHER_SIZE]: 5_000, [CHOSEN]: 2_000 } }); });
  expect(times()).toEqual(["~2 s", "~4 s", "~6 s", "~8 s"]);
});

it("in the open count menu Down and Up move between the counts and wrap at either end", async () => {
  await mount("menu", { pop: { id: "count", kb: false } });
  const menu = doc.getElementById("countMenu");
  const press = (key: string) => fire(menu, "onKeyDown", { key, currentTarget: menu, preventDefault() {} });
  act(() => pick(1)!.focus());
  await press("ArrowDown");
  expect(doc.activeElement).toBe(pick(2));
  await press("ArrowUp");
  expect(doc.activeElement).toBe(pick(1));
  await press("ArrowUp");
  expect(doc.activeElement, "Up from the first goes to the last").toBe(pick(4));
  await press("ArrowDown");
  expect(doc.activeElement, "Down from the last goes to the first").toBe(pick(1));
});

it("the count button reads a setup's first time before its menu opens, so the rows open with their times", async () => {
  const answer: { done?: () => void } = {};
  calls.read.fn = () => new Promise<void>((resolve) => { answer.done = resolve; });
  await mount("composer");
  await fire(byTestId("chat.composer.count"), "onClick", { detail: 1 });
  expect(calls.reads).toEqual([{ preset: PRESET.id, width: 1024, height: 768 }]);
  expect(menuOpen(), "the menu waits for the read").toBe(false);
  await act(async () => { store.setState({ imageRuns: { [CHOSEN]: 3_000 } }); answer.done?.(); });
  await settle();
  expect(menuOpen()).toBe(true);
  expect(times()).toEqual(["~3 s", "~6 s", "~9 s", "~12 s"]);
});

it("the count button opens its menu with no times once a setup's first time takes longer than 400 ms to read", async () => {
  calls.read.fn = () => new Promise<void>(() => undefined);
  await mount("composer");
  const pressed = performance.now();
  await fire(byTestId("chat.composer.count"), "onClick", { detail: 1 });
  while (!menuOpen() && performance.now() - pressed < 3_000) await pause(10);
  const waited = performance.now() - pressed;
  expect(menuOpen(), "opened without the answer").toBe(true);
  expect(waited, "it waited for the read first").toBeGreaterThanOrEqual(390);
  expect(times()).toEqual([null, null, null, null]);
});

it("turning Image off while the count menu is open closes the menu", async () => {
  await mount("menu", { pop: { id: "count", kb: false } });
  expect(menuOpen()).toBe(true);
  await act(async () => { store.setState({ image: false }); });
  await settle();
  expect(store.getState().pop).toBeNull();
});

it.each([
  ["the + menu", "plus", "chat.plus-menu.image"],
  ["the options menu", "opts", "chat.options-menu.image"],
] as const)("with nothing here that can draw, the Image row of %s opens the pop-up that says so and leaves Image off", async (_, menu, row) => {
  await mount(menu, { image: false, pop: { id: menu, kb: false }, imageStatus: { state: "missing", owner: "none" } });
  await fire(byTestId(row), "onClick");
  expect(store.getState().pop?.id).toBe("unset");
  expect(store.getState().image).toBe(false);
});
