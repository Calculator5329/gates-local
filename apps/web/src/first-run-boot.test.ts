// First run while the first read is late: hooks keep their state between
// renders and effects run after each render, as on a mounted screen. The
// screen leaves its placeholders at the two-second bound and never goes back
// to them, and until the runtime has answered it claims nothing about Ollama.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

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
vi.mock("./store.ts", () => ({ NA: "na", useStore: (fn: (s: unknown) => unknown) => fn(h.state) }));
vi.mock("./session.ts", () =>
  Object.fromEntries(["finishFirstRun", "firstPull", "openSettings", "pull", "cancelPull", "recheckRuntime"].map((name) => [name, () => undefined])),
);
vi.mock("./Sidebar.tsx", () => ({ focusComposer: () => undefined }));
vi.mock("./Settings.tsx", () => ({ DlDetail: () => null }));
vi.mock("./ui.tsx", () => ({ VLabel: () => null }));

const { FirstRun } = await import("./FirstRun.tsx");

/** What the screen shows, and whether it is its placeholders. */
const show = (state: object) => {
  h.state = state;
  // a set-state during render renders again, as React does
  let html = "";
  for (let pass = 0; pass < 3; pass++) {
    h.slot = 0;
    h.effect = 0;
    html = renderToStaticMarkup(createElement(FirstRun));
  }
  for (const run of h.pending.splice(0)) run();
  const words = html.replaceAll(/<[^>]*>/g, " ").replaceAll("&#x27;", "'").replaceAll(/\s+/g, " ").trim();
  return { skel: html.includes("data-skel"), words, html };
};

const boot = { conn: { kind: "open" }, runtime: undefined, hydrationSettled: false, bootWaited: false, models: undefined, catalog: undefined, gpu: undefined, numCtx: 16384, pulls: {}, unavailable: {}, fitTable: undefined, settings: {} };
/** The server's fit table holding `model` at 16k with this verdict. */
const tableWith = (model: string, verdict: string) => ({
  reading: { boot: "b", seq: 1, measuredAt: 0 },
  memory: { kind: "gpu", freeBytes: 0, usableBytes: 0 },
  rows: [{ model, numCtx: 16384, verdict, needVramBytes: 1, freeVramBytes: 2, spillRamBytes: 0, source: "estimate", stops: [] }],
});

beforeEach(() => {
  h.slots.clear(); h.deps.clear(); h.pending = [];
});

const qwen = { name: "qwen3.5:9b", label: "Qwen 3.5 9B", recommended: true, downloadBytes: 6 * 1024 ** 3, purpose: "chat", installed: false };
const installed = [{ name: "qwen3.5:9b", digest: "q", sizeBytes: 1, modifiedAt: "", capabilities: ["completion"], pick: { numCtx: 16384, verdict: "fits" } }];
const late = { ...boot, bootWaited: true, hydrationSettled: true, runtime: { state: "ready", owner: "external" } };

it("a first read at 2.5 s: placeholders at 1 s, neutral words at 2.2 s, the found screen after the read, never placeholders again", () => {
  vi.useFakeTimers();
  try {
    const at1 = show(boot);
    expect(at1.skel, "1 s: placeholders").toBe(true);

    const at22 = show({ ...boot, bootWaited: true });
    expect(at22.skel, "2.2 s: off the placeholders").toBe(false);
    expect(at22.words, "2.2 s: one neutral word").toContain("Connecting…");
    expect(at22.words, "2.2 s: no search that has not started").not.toMatch(/Ollama|Starting up/);

    // the runtime and models land; the catalog and memory check have not answered
    const after = show({ ...late, models: installed });
    expect(after.skel, "after the read: never back to placeholders").toBe(false);
    expect(after.words, "the words hold until the screen's own words are in hand").toBe("Gates Local Connecting…");
    // the whole-wait passes: the found screen, its memory check still running
    vi.advanceTimersByTime(1000);
    const found = show({ ...late, models: installed });
    expect(found.skel).toBe(false);
    expect(found.words).toContain("Ollama · 1 chat model");
    expect(found.words).toContain("Checking memory");
    expect(found.words, "no table yet: never Ready").not.toContain("Ready to chat");
    expect(found.html, "still checking: the dot runs, it is not green").toContain('class="dot run"');
    // the table lands with this model's row: the verdict, in place
    const read = show({ ...late, models: installed, fitTable: tableWith("qwen3.5:9b", "fits") });
    expect(read.words).toContain("Ready to chat");
    expect(read.words).not.toContain("Checking");
  } finally {
    vi.useRealTimers();
  }
});

// A table built before the runtime was up has no rows, and one whose GPU reading failed has
// unreadable memory: neither answers whether the model runs here.
const emptyTable = { ...tableWith("qwen3.5:9b", "fits"), rows: [] };
const unreadableTable = { ...emptyTable, memory: { kind: "unreadable", detail: "nvidia-smi failed" } };
for (const [what, table] of [["an empty", emptyTable], ["an unreadable", unreadableTable]] as const) {
  it(`${what} table is no answer: Connecting holds to the bound, then the title and the card both say Checking, and the next table replaces them in place`, () => {
    vi.useFakeTimers();
    try {
      show(boot);
      show({ ...boot, bootWaited: true });
      const catalog = [{ ...qwen, installed: true }];
      const held = show({ ...late, models: installed, catalog, fitTable: table });
      expect(held.words, "such a table does not end the wait").toBe("Gates Local Connecting…");
      vi.advanceTimersByTime(1000);
      const found = show({ ...late, models: installed, catalog, fitTable: table });
      expect(found.skel).toBe(false);
      expect(found.words).toContain("Checking memory");
      expect(found.words).toContain("Checking…");
      expect(found.words, "the card never disagrees with the title").not.toContain("Couldn't check");
      expect(found.words).not.toContain("Ready to chat");
      expect(found.html, "the dot says it is still checking").toContain('class="dot run"');
      const read = show({ ...late, models: installed, catalog, fitTable: { ...tableWith("qwen3.5:9b", "fits"), reading: { boot: "b", seq: 2, measuredAt: 0 } } });
      expect(read.skel, "never back to placeholders").toBe(false);
      expect(read.words).toContain("Ready to chat");
      expect(read.words).not.toContain("Checking");
      expect(read.html).toContain('class="dot ok"');
    } finally {
      vi.useRealTimers();
    }
  });
}

it("a late first read with no models never shows the ollama pull sentence before the catalog: Connecting, then the download card", () => {
  vi.useFakeTimers();
  try {
    show(boot);
    expect(show({ ...boot, bootWaited: true }).words).toContain("Connecting…");
    // the first batch: runtime and no models, no catalog yet
    const first = show({ ...late, models: [] });
    expect(first.words).not.toContain("ollama pull");
    expect(first.words).toBe("Gates Local Connecting…");
    // the catalog lands; the memory check runs past the whole-wait
    const steps = [show({ ...late, models: [], catalog: [qwen] })];
    vi.advanceTimersByTime(1000);
    steps.push(show({ ...late, models: [], catalog: [qwen] }));
    for (const s of steps) expect(s.words).not.toContain("ollama pull");
    expect(steps.at(-1)!.words).toContain("Download your first model");
    expect(steps.at(-1)!.words).toContain("Qwen 3.5 9B");
  } finally {
    vi.useRealTimers();
  }
});

it("a late first read on the found path never shows the raw tag as the card's name first", () => {
  vi.useFakeTimers();
  try {
    show(boot);
    show({ ...boot, bootWaited: true });
    // a label the tag alone could not give, so a name made from the tag shows as a difference
    const catalog = [{ ...qwen, installed: true, label: "Qwen Chat" }];
    const seen = [show({ ...late, models: installed }), show({ ...late, models: installed, catalog })];
    vi.advanceTimersByTime(1000);
    seen.push(show({ ...late, models: installed, catalog }));
    const named = seen.filter((s) => !s.words.includes("Connecting…"));
    expect(named.length, "the found screen shows").toBeGreaterThan(0);
    for (const s of named) expect(s.words, "the catalog's name, never one made from the tag").toContain("Qwen Chat");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the Ollama sentences for a runtime that has answered starting", () => {
  const s = show({ ...boot, bootWaited: true, hydrationSettled: true, runtime: { state: "starting", owner: "external" } });
  expect(s.words).toContain("Looking for Ollama");
  expect(s.words).not.toContain("Connecting…");
});
