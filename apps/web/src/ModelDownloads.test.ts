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
vi.mock("./session.ts", () => Object.fromEntries(["pull", "cancelPull", "estimateModel"].map((name) => [name, () => undefined])));
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
  expect(groups(later)["Too big for this computer"]).toEqual(["qwen3.5:9b"]);
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
    // a row with no reading states no verdict
    expect(shown).toContain('data-cat="b:1">');
  });
}

it("F2: a table that has no reading for a row answers it: grouped at once, that row not recommended and with no verdict", () => {
  const a = entry("a:1", "A", true, "fits");
  const b = entry("b:1", "B", true, "fits");
  const shown = render(base({ catalog: [a, b], numCtx: 65536, fitTable: table(fit("a:1", "fits", 65536)) }));
  expect(shown).not.toContain("data-skel");
  expect(groups(shown)).toEqual({ Recommended: ["a:1"], "Also available": ["b:1"], "Something else": [] });
  expect(shown).toContain('data-cat="b:1">');
  // with one row unanswered, no verdict is said for all of them
  expect(shown).toContain('<p class="dl-once" data-wait=""></p>');
});

it("F2: once grouped, the groups stay put, except that a row whose verdict becomes does-not-fit leaves Recommended once and never comes back", () => {
  const a = entry("a:1", "A", true, "fits");
  const b = entry("b:1", "B", true, "fits");
  const c = entry("c:1", "C", false, "spills");
  const state = base({ catalog: [a, b, c], fitTable: table(fit("a:1", "fits"), fit("b:1", "fits"), fit("c:1", "spills")) });
  const first = render(state);
  expect(groups(first)).toEqual({ Recommended: ["a:1", "b:1"], "Also available": ["c:1"], "Something else": [] });
  // a spill reading does not move a row
  const spills = render({ ...state, fitTable: table(fit("a:1", "spills"), fit("b:1", "fits"), fit("c:1", "spills")) });
  expect(groups(spills)["Recommended"]).toEqual(["a:1", "b:1"]);
  // a refusal moves it to the last group, closed, with what it needs and no button
  const refused = render({ ...state, fitTable: table(fit("a:1", "fits"), fit("b:1", "refuse"), fit("c:1", "spills")) });
  expect(groups(refused)).toEqual({ Recommended: ["a:1"], "Also available": ["c:1"], "Something else": [], "Too big for this computer": ["b:1"] });
  expect(refused).toMatch(/<details class="grp dl-bigs">/);
  // what it needs is its memory mark (row 28)
  expect(refused).toMatch(/data-cat="b:1" data-verdict="refuse">(?:(?!data-cat)[\s\S])*aria-label="Too big for this computer: 6\.0 (?:of \d+ )?GB"/);
  expect(refused).not.toMatch(/needs 6\.0 GB of memory/);
  expect(refused).not.toMatch(/data-cat="b:1" data-verdict="refuse">(?:(?!data-cat)[\s\S])*<button/);
  // it runs again: it never goes back to Recommended this visit, it is with the rest
  const back = render({ ...state, fitTable: table(fit("a:1", "fits"), fit("b:1", "fits"), fit("c:1", "spills")) });
  expect(groups(back)).toEqual({ Recommended: ["a:1"], "Also available": ["b:1", "c:1"], "Something else": [] });
});

it("the download's size is its button, and a running download fills that button with an × beside it (row 18)", () => {
  const a = entry("a:1", "A", true, "fits");
  const idle = render(base({ catalog: [a], fitTable: table(fit("a:1", "fits")) }));
  expect(idle).toMatch(/<button type="button" class="dl-btn" data-testid="models.download.start" aria-label="Download 5\.0 GB">/);
  // the × box is there, hidden, before any download
  expect(idle).toContain('<span class="dl-x off" aria-hidden="true"></span>');
  const p = { name: "a:1", state: "downloading", completedBytes: 2 * GIB, totalBytes: 5 * GIB, bytesPerSecond: 50e6 };
  const running = render(base({ catalog: [a], fitTable: table(fit("a:1", "fits")), pulls: { "a:1": p } }));
  expect(running).toMatch(/class="dl-btn dl-run" role="progressbar"[^>]*aria-valuenow="40"><i style="width:40%"><\/i><span>40%<\/span>/);
  expect(running).toContain('aria-label="Cancel download"');
  // bytes and time left on the row's second line; no speed, no full-row bar
  expect(running).toMatch(/2\.0 of 5\.0 GB · about [^<]+ left/);
  expect(running).not.toContain("MB/s");
  expect(running).not.toContain('class="prog"');
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

it("a verdict every row shares is said once above the list, a row carries only an exception, and the rows stay where they are (row 18)", () => {
  const a = entry("a:1", "A", true, "fits");
  const b = entry("b:1", "B", false, "spills");
  const state = base({ catalog: [a, b], fitTable: table(fit("a:1", "fits"), fit("b:1", "spills")) });
  const mixed = render(state);
  expect(groups(mixed)).toEqual({ Recommended: ["a:1"], "Also available": ["b:1"], "Something else": [] });
  // mixed: the line above says what most rows do and points at the exception, which only its row says
  expect(mixed).toMatch(/<p class="dl-once" data-wait=""><span class="vd gpu"><\/span>These run on your RTX, except the ones marked slower\.<\/p>/);
  expect(mixed.match(/class="vl /g)).toHaveLength(1);
  expect(mixed).toMatch(/data-cat="b:1"[\s\S]*?class="vl spill"/);
  // the next table says b now fits too: said once, and no row repeats it
  const fits = render({ ...state, fitTable: table(fit("a:1", "fits"), fit("b:1", "fits")) });
  expect(groups(fits)).toEqual({ Recommended: ["a:1"], "Also available": ["b:1"], "Something else": [] });
  expect(fits).toMatch(/<p class="dl-once" data-wait=""><span class="vd gpu"><\/span>These run on your RTX\.<\/p>/);
  expect(fits).not.toContain('class="vl ');
  // every row spills: said once, the slower words
  const spills = render({ ...state, fitTable: table(fit("a:1", "spills"), fit("b:1", "spills")) });
  expect(groups(spills)).toEqual({ Recommended: ["a:1"], "Also available": ["b:1"], "Something else": [] });
  expect(spills).toContain("These are bigger than your GPU&#x27;s memory, so replies are slower.");
  expect(spills).not.toContain('class="vl ');
});
