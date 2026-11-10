// Real composer handlers, the real picker's opening checks and fit-cache dedupe
// over the in-memory protocol. Warming happens on intent only, never at idle.
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser, tick, until, type Browser } from "./harness.ts";

const hooks = vi.hoisted(() => ({ effects: [] as (() => unknown)[], layout: [] as (() => unknown)[] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (run: () => unknown) => { hooks.effects.push(run); },
  useLayoutEffect: (run: () => unknown) => { hooks.layout.push(run); },
  useRef: (current: unknown) => ({ current }),
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => undefined],
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../src/ui.tsx", async original => ({
  ...await original<typeof import("../src/ui.tsx")>(), useMedia: () => false, isTouch: () => false, place: () => undefined,
}));

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let Composer: typeof import("../src/Composer.tsx")["Composer"];
let Picker: typeof import("../src/Picker.tsx")["Picker"];
let disconnect: (() => void) | undefined;
let selected: string;
const other = "capped-chat:8k";
const idle = new Map<number, IdleRequestCallback>();
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  b = installBrowser(); vi.resetModules(); hooks.effects.length = 0; hooks.layout.length = 0; idle.clear();
  vi.stubGlobal("requestIdleCallback", (run: IdleRequestCallback) => { const id = idle.size + 1; idle.set(id, run); return id; });
  vi.stubGlobal("cancelIdleCallback", (id: number) => { idle.delete(id); });
  b.server.answer("fit.check", params => ({ ...methodSamples["fit.check"].result, ...params }));
  session = await import("../src/session.ts"); store = await import("../src/store.ts");
  Composer = (await import("../src/Composer.tsx")).Composer;
  Picker = (await import("../src/Picker.tsx")).Picker;
  disconnect = session.connect();
  await until(() => store.getState().hydrationSettled);
  await tick();
  const tag = store.getState().model;
  if (!tag) throw new Error("The ready fixture needs its selected model");
  selected = tag;
  const info = methodSamples["models.list"].result[0];
  if (!info) throw new Error("Missing installed-model fixture");
  store.setState({ view: "new", numCtx: 16384, models: [
    { ...info, name: selected, capabilities: ["completion"], maxContext: 32768 },
    { ...info, name: other, capabilities: ["completion"], maxContext: 8192 },
    { ...info, name: "embed-only", capabilities: ["embedding"] },
  ] });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  disconnect?.(); b.server.accepting = false;
  for (const socket of b.server.sockets) socket.close();
  await tick(); vi.unstubAllGlobals();
});

function render() { hooks.effects.length = 0; hooks.layout.length = 0; return Composer(); }
function runAll(list: (() => unknown)[]) { for (const step of list.splice(0)) { const cleanup = step(); if (typeof cleanup === "function") cleanups.push(() => { cleanup(); }); } }
function effects() { hooks.layout.length = 0; runAll(hooks.effects); }
function idleWork() { const work = [...idle.values()]; idle.clear(); for (const step of work) step({ didTimeout: false, timeRemaining: () => 20 }); }
/** Every chance a background warm-up would take: effects, two frames and idle. */
async function settle() { render(); effects(); b.frame(); b.frame(); idleWork(); await tick(); }
function nodes(tree: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...nodes(tree.props.children)];
}
type Intent = "onPointerEnter" | "onFocus" | "onPointerDown";
/** `keyboard` says whether the browser shows a focus ring: true for Tab, false for script focus after a tap. */
function intent(event: Intent, keyboard = true) {
  const button = nodes(render()).find(n => n.props.id === "modelBtn");
  const handler = button?.props[event];
  if (typeof handler !== "function") throw new Error(`Missing ${event} on the model button`);
  handler({ pointerType: "mouse", button: 0, currentTarget: { matches: (query: string) => keyboard && query === ":focus-visible" } });
}
const checked = () => b.server.calls("fit.check").map(r => {
  const params = r.params;
  if (typeof params !== "object" || params === null || !("model" in params) || !("numCtx" in params)) throw new Error("Malformed fit request");
  return `${String(params.model)}@${String(params.numCtx)}`;
});
const needed = () => [`${selected}@8192`, `${selected}@16384`, `${selected}@32768`, `${other}@8192`];
/** A finished reply leaves the GPU reading changed, so every report is stale. */
async function afterReply() { b.server.push("gpu.changed", methodSamples["gpu.status"].result); await tick(); }
/** Open the real picker the way a click does and run its first-view effects. */
async function openPicker() {
  store.setState({ pop: { id: "picker", kb: false } });
  hooks.effects.length = 0; hooks.layout.length = 0; Picker(); runAll(hooks.effects); await tick();
}

it("a ready composer checks only the selected pair, even after two frames and idle", async () => {
  await settle();
  expect(checked().filter(key => key !== `${selected}@16384`)).toEqual([]);
});

it("a finished reply refreshes only the selected pair; idle warms nothing else", async () => {
  await settle(); const before = checked();
  await afterReply(); await settle();
  expect(checked().slice(before.length)).toEqual([`${selected}@16384`]);
});

it.each(["onPointerEnter", "onFocus", "onPointerDown"] as const)("%s after a reply warms each needed pair once", async event => {
  await settle(); await afterReply(); await settle(); const before = checked();
  intent(event); await tick();
  const warmed = checked().slice(before.length);
  for (const pair of needed().filter(key => key !== `${selected}@16384`)) expect(warmed.filter(value => value === pair)).toHaveLength(1);
  expect(warmed.some(key => key.startsWith("embed-only@") || key === `${selected}@65536`)).toBe(false);
});

// On phone a closing sheet hands focus back to the button by script: nobody is
// reaching for the picker, and a pick at a new size would warm every model there.
it("focus without a focus ring starts no picker checks", async () => {
  await settle(); await afterReply(); await settle(); const before = checked();
  intent("onFocus", false); await tick();
  expect(checked()).toEqual(before);
});

it("a second intent while the first warm is still in flight starts nothing", async () => {
  await settle(); await afterReply(); await settle(); const before = checked().length;
  const missing = needed().length - 1;
  const held = Array.from({ length: missing }, () => b.server.hold("fit.check"));
  intent("onPointerEnter");
  await until(() => checked().length - before >= missing, 500, "the warm's checks");
  const answers = await Promise.all(held); await tick();
  expect(checked().length - before).toBe(missing);
  intent("onPointerDown"); intent("onFocus"); intent("onPointerEnter"); await tick();
  expect(checked().length - before, "in-flight checks are reused").toBe(missing);
  for (const answer of answers) answer.respond({ ...methodSamples["fit.check"].result, ...answer.params });
  await tick();
  intent("onPointerDown"); await tick();
  expect(checked().length - before, "fresh answers are reused").toBe(missing);
});

it("an opening right after a warm makes no further check and shows a complete first view", async () => {
  await settle(); await afterReply(); await settle();
  intent("onPointerEnter"); intent("onPointerDown"); await tick(); const warmed = checked();
  await openPicker();
  expect(checked()).toEqual(warmed);
  // The layout effects mark the first view ready, then place it by its anchor.
  Object.assign(document, { getElementById: () => null });
  runAll(hooks.layout);
  expect(store.getState().pop).toMatchObject({ id: "picker", ready: true });
});

// With nothing selected the first row is the active one, ordered by label (not
// tag) across installed models and downloads alike. The download's label puts
// it first in one case and last in the other.
it.each([["first", "Aardvark New 3B"], ["last", "Zebra New 3B"]] as const)("with no model selected and a download sorting %s, the opening adds no check to the warm", async (_where, downloadLabel) => {
  const info = methodSamples["models.list"].result[0];
  if (!info) throw new Error("Missing installed-model fixture");
  const entry = { purpose: "Test", downloadBytes: 1, recommended: false };
  store.setState({
    model: undefined,
    models: [{ ...info, name: "aa-chat:7b", capabilities: ["completion"], maxContext: 32768 }, { ...info, name: "zz-chat:7b", capabilities: ["completion"], maxContext: 16384 }],
    catalog: [{ ...entry, name: "aa-chat:7b", label: "Yak Chat 7B", installed: true }, { ...entry, name: "zz-chat:7b", label: "Alpha Chat 7B", installed: true }, { ...entry, name: "ab-new:3b", label: downloadLabel, installed: false }],
    pulls: { "ab-new:3b": { name: "ab-new:3b", state: "downloading", completedBytes: 10, totalBytes: 100 } },
  });
  await settle(); await afterReply(); await settle();
  intent("onPointerEnter"); intent("onPointerDown"); await tick(); const warmed = checked();
  await openPicker();
  expect(checked()).toEqual(warmed);
});

it("intent before hydration settles starts no picker checks", async () => {
  await settle(); await afterReply();
  store.setState({ hydrationSettled: false }); await settle(); const before = checked();
  intent("onPointerEnter"); intent("onPointerDown"); intent("onFocus"); await tick();
  expect(checked()).toEqual(before);
});

it("without intent the opening itself makes the same checks a warm would have made", async () => {
  await settle(); await afterReply(); await settle(); const before = checked().length;
  await openPicker();
  expect(checked().length - before).toBe(needed().length - 1);
});

// A reply or a model load is about to invalidate every report, so a warm now
// would be thrown away and the opening would check again.
it.each([
  ["a reply runs", () => store.setState({ turns: { live: { gen: 1, threadId: "live", turnId: "turn", model: selected, startedAt: 1, thinking: "", text: "", tools: [], pendingUser: null } } })],
  ["a model loads", () => store.setState({ loads: { [selected]: { model: selected, numCtx: 16384, state: "loading" } } })],
] as const)("intent while %s starts no picker checks", async (_case, busy) => {
  await settle(); await afterReply(); await settle();
  busy(); await settle(); const before = checked();
  intent("onPointerEnter"); intent("onPointerDown"); intent("onFocus"); await tick();
  expect(checked()).toEqual(before);
});

it.each(["firstrun", "settings"] as const)("intent under %s starts no picker checks", async view => {
  store.setState({ view }); await settle(); const before = checked();
  intent("onPointerEnter"); intent("onPointerDown"); intent("onFocus"); await tick();
  expect(checked()).toEqual(before);
});
