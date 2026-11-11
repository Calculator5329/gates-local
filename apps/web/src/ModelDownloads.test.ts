// The Download tab's groups over one visit: hooks keep their state between
// renders and effects run after each render, as on a mounted tab. A row is
// never under Recommended while its verdict at this context says it does not
// fit, and the groups otherwise stay put while answers arrive.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const hooks = {
    state: undefined as unknown, slot: 0, slots: new Map<number, { current: unknown }>(), effect: 0, deps: new Map<number, readonly unknown[]>(), pending: [] as (() => void | (() => void))[],
    /** The next hook's kept value, by call order. */
    take: (init: () => unknown): { current: unknown } => {
      const i = hooks.slot++;
      if (!hooks.slots.has(i)) hooks.slots.set(i, { current: init() });
      return hooks.slots.get(i)!;
    },
  };
  return hooks;
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useRef: (init: unknown) => h.take(() => init),
    useState: (init: unknown) => {
      const s = h.take(() => (typeof init === "function" ? (init as () => unknown)() : init));
      return [s.current, (v: unknown) => { s.current = typeof v === "function" ? (v as (x: unknown) => unknown)(s.current) : v; }];
    },
    useEffect: (run: () => void | (() => void), deps: readonly unknown[]) => {
      const i = h.effect++;
      const old = h.deps.get(i);
      if (!old || deps.some((value, j) => !Object.is(value, old[j]))) h.pending.push(run);
      h.deps.set(i, deps);
    },
  };
});
vi.mock("./store.ts", () => ({
  NA: "na",
  useStore: (fn: (s: unknown) => unknown) => fn(h.state),
  getState: () => h.state,
  setState: () => undefined,
}));
vi.mock("./session.ts", () => Object.fromEntries(["pull", "cancelPull"].map((name) => [name, () => undefined])));
vi.mock("./FitPanel.tsx", () => ({ shortGpu: (name: string) => name }));

const { DownloadTab } = await import("./ModelDownloads.tsx");

const GIB = 1024 ** 3;
type Verdict = "fits" | "spills" | "refuse";
const fit = (model: string, verdict: Verdict, numCtx = 16384) => ({
  model, numCtx, verdict, freeVramBytes: 16 * GIB, needVramBytes: 6 * GIB, spillRamBytes: verdict === "spills" ? GIB : 0, source: "estimate", measuredAt: 0,
});
const entry = (name: string, label: string, recommended: boolean, verdict: Verdict) => ({
  name, label, purpose: "General chat", recommended, installed: false, downloadBytes: 5 * GIB, fit: fit(name, verdict),
});
const base = (over: object) => ({ gpu: { vendor: "nvidia", name: "RTX" }, models: [], pulls: {}, unavailable: {}, settings: {}, fitTable: undefined, numCtx: 16384, ...over });
let seq = 0;
/** The server's fit table holding these rows, each one newer than the last. */
const table = (...rows: ReturnType<typeof fit>[]) => ({ reading: { boot: "b", seq: ++seq, measuredAt: 0 }, memory: { kind: "gpu", freeBytes: 16 * GIB, usableBytes: 15 * GIB }, rows: rows.map(r => ({ ...r, stops: [] })) });

const render = (state: object) => {
  h.state = state;
  h.slot = 0;
  h.effect = 0;
  const html = renderToStaticMarkup(createElement(DownloadTab));
  for (const run of h.pending.splice(0)) run();
  return html;
};
/** The row names under each group title, in order. */
const groups = (html: string) => {
  const out: Record<string, string[]> = {};
  for (const part of html.split('class="grp-t"').slice(1)) {
    const title = /^>(?:<span[^>]*>)?([^<]+)/.exec(part)?.[1] ?? "?";
    // a kept, hidden header slot is not a group
    if (title.trim() === "") continue;
    out[title] = [...part.matchAll(/data-cat="([^"]+)"/g)].map((m) => m[1]!);
  }
  return out;
};

beforeEach(() => {
  h.slots.clear(); h.deps.clear(); h.pending = [];
});
afterEach(() => {
  vi.useRealTimers();
});

it("F2: a recommended download waits on placeholders for the table, never on the catalog's own estimate, and a refusal never lands under Recommended", () => {
  // The catalog estimated "fits"; the table is not in yet.
  const rec = entry("qwen3.5:9b", "Qwen 3.5 9B", true, "fits");
  const state = base({ catalog: [rec], numCtx: 65536 });
  const first = render(state);
  expect(groups(first)["Recommended"] ?? [], "no group on the first frame claims the row").not.toContain("qwen3.5:9b");
  expect(first).toContain('aria-busy="true"');
  expect(first).toContain("data-skel");
  const later = render({ ...state, fitTable: table(fit("qwen3.5:9b", "refuse", 65536)) });
  expect(groups(later)["Recommended"] ?? []).not.toContain("qwen3.5:9b");
  expect(groups(later)["Also available"]).toEqual(["qwen3.5:9b"]);
});

it("F2: at the one-second bound with no table, a row with no answer is not recommended", () => {
  vi.useFakeTimers();
  const a = entry("a:1", "A", true, "fits");
  const b = entry("b:1", "B", true, "fits");
  const state = base({ catalog: [a, b], numCtx: 65536 });
  expect(render(state)).toContain("data-skel");
  vi.advanceTimersByTime(1000);
  const shown = render(state);
  expect(shown).not.toContain("data-skel");
  expect(groups(shown)).toEqual({ "Also available": ["a:1", "b:1"], "Something else": [] });
});

for (const [what, memory] of [["an empty", { kind: "gpu", freeBytes: 16 * GIB, usableBytes: 15 * GIB }], ["an unreadable", { kind: "unreadable", detail: "nvidia-smi failed" }]] as const) {
  it(`F2: ${what} table is no answer: the groups wait for the one-second bound, then a row with no reading is a dash and not recommended`, () => {
    vi.useFakeTimers();
    const a = entry("a:1", "A", true, "fits");
    const b = entry("b:1", "B", true, "fits");
    const state = base({ catalog: [a, b], numCtx: 65536, fitTable: { ...table(), memory } });
    expect(render(state), "such a table does not settle the groups").toContain("data-skel");
    vi.advanceTimersByTime(1000);
    const shown = render(state);
    expect(shown).not.toContain("data-skel");
    expect(groups(shown)).toEqual({ "Also available": ["a:1", "b:1"], "Something else": [] });
    expect(shown).toMatch(/data-cat="b:1"[\s\S]*?<div class="dl-v" data-wait=""><small>–<\/small>/);
  });
}

it("F2: a table that has no reading for a row answers it: grouped at once, that row not recommended and shown as a dash", () => {
  const a = entry("a:1", "A", true, "fits");
  const b = entry("b:1", "B", true, "fits");
  const shown = render(base({ catalog: [a, b], numCtx: 65536, fitTable: table(fit("a:1", "fits", 65536)) }));
  expect(shown).not.toContain("data-skel");
  expect(groups(shown)).toEqual({ Recommended: ["a:1"], "Also available": ["b:1"], "Something else": [] });
  expect(shown).toMatch(/data-cat="b:1"[\s\S]*?<div class="dl-v" data-wait=""><small>–<\/small>/);
});

it("F2: once grouped, the groups stay put, except that a row whose verdict becomes does-not-fit leaves Recommended once and never comes back", () => {
  const a = entry("a:1", "A", true, "fits");
  const b = entry("b:1", "B", true, "fits");
  const c = entry("c:1", "C", false, "spills");
  const state = base({ catalog: [a, b, c], fitTable: table(fit("a:1", "fits"), fit("b:1", "fits"), fit("c:1", "spills")) });
  const first = render(state);
  expect(groups(first)).toEqual({ Recommended: ["a:1", "b:1"], "Also available · uses system memory": ["c:1"], "Something else": [] });
  // a spill reading does not move a row
  const spills = render({ ...state, fitTable: table(fit("a:1", "spills"), fit("b:1", "fits"), fit("c:1", "spills")) });
  expect(groups(spills)["Recommended"]).toEqual(["a:1", "b:1"]);
  // a refusal moves it, and the other group no longer only spills
  const refused = render({ ...state, fitTable: table(fit("a:1", "fits"), fit("b:1", "refuse"), fit("c:1", "spills")) });
  expect(groups(refused)).toEqual({ Recommended: ["a:1"], "Also available": ["b:1", "c:1"], "Something else": [] });
  // it fits again: it stays where it went for this visit
  const back = render({ ...state, fitTable: table(fit("a:1", "fits"), fit("b:1", "fits"), fit("c:1", "spills")) });
  expect(groups(back)).toEqual({ Recommended: ["a:1"], "Also available": ["b:1", "c:1"], "Something else": [] });
});

it("an empty Recommended keeps its header slot for the visit when the placeholder drew one, so what is below stays put", () => {
  vi.useFakeTimers();
  const a = entry("a:1", "A", true, "fits");
  const b = entry("b:1", "B", false, "fits");
  // at 64k nothing has answered: the placeholder draws two headers, as the server recommends a
  const state = base({ catalog: [a, b], numCtx: 65536 });
  const held = render(state);
  expect(held.match(/class="grp-t"/g)?.length, "two placeholder headers, then Something else").toBe(3);
  vi.advanceTimersByTime(1000);
  const shown = render(state);
  expect(groups(shown)).toEqual({ "Also available": ["a:1", "b:1"], "Something else": [] });
  expect(shown, "the Recommended header's place is kept, hidden").toMatch(/<div class="grp grp-keep" aria-hidden="true"><div class="grp-h">/);
});

it("no slot is kept where the placeholder drew one header", () => {
  vi.useFakeTimers();
  const b = entry("b:1", "B", false, "fits");
  const state = base({ catalog: [b], numCtx: 65536 });
  render(state);
  vi.advanceTimersByTime(1000);
  expect(render(state)).not.toContain("grp-keep");
});

it("the uses-system-memory title follows the rows' live verdicts, and its rows stay where they are", () => {
  const a = entry("a:1", "A", true, "fits");
  const b = entry("b:1", "B", false, "spills");
  const state = base({ catalog: [a, b], fitTable: table(fit("a:1", "fits"), fit("b:1", "spills")) });
  expect(groups(render(state))).toEqual({ Recommended: ["a:1"], "Also available · uses system memory": ["b:1"], "Something else": [] });
  // the next table says b now fits: the title no longer says it uses system memory
  const fits = render({ ...state, fitTable: table(fit("a:1", "fits"), fit("b:1", "fits")) });
  expect(groups(fits)).toEqual({ Recommended: ["a:1"], "Also available": ["b:1"], "Something else": [] });
  // and back to spilling: the words come back
  const spills = render({ ...state, fitTable: table(fit("a:1", "fits"), fit("b:1", "spills")) });
  expect(groups(spills)).toEqual({ Recommended: ["a:1"], "Also available · uses system memory": ["b:1"], "Something else": [] });
});
