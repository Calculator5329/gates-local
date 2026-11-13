import { describe, expect, it } from "vitest";
import { type FinderFrame, type StepFrames, type Twin, detect } from "./detectors.ts";

type El = readonly [string, readonly number[]];
/** One frame every 16 ms; `els` are the tracked boxes it shows. */
const frame = (i: number, els: readonly El[], o: { arrived?: boolean; twice?: readonly Twin[]; hold?: readonly El[] } = {}): FinderFrame => ({
  at: i * 16, t: 1_000_000 + i * 16, present: true, arrived: o.arrived ?? true, text: "", loose: 0,
  els: els.map(([key, box]) => ({ key, box })), twice: o.twice ?? [],
  ...(o.hold ? { hold: o.hold.map(([sel, box]) => ({ sel, box })) } : {}),
});
const step = (frames: readonly FinderFrame[], o: Partial<StepFrames> = {}): StepFrames => ({ screen: "s", step: "a step", frames, actAt: 16, opens: false, ...o });
const kinds = (s: StepFrames) => detect(s).map((f) => f.kind);
const BOX = [10, 100, 80, 20] as const;
const at = (y: number) => [10, y, 80, 20] as const;

describe("moves", () => {
  it("reports a box that shifts after it showed: how far, which side, when", () => {
    const frames = [0, 1, 2, 3, 4, 5].map((i) => frame(i, [["Send", i < 3 ? BOX : at(140)]]));
    const [f, ...rest] = detect(step(frames));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ kind: "moves", element: "Send", px: 40, ms: 3 * 16 - 16, frames: [2, 3, 5], detail: "y 100 → 140 (40 px)" });
    expect(f!.boxes).toEqual([BOX, at(140)]);
    expect(f!.series?.map((p) => p[1])).toEqual([100, 100, 100, 140, 140, 140]);
  });

  it("says when it went and came back", () => {
    const frames = [0, 1, 2, 3, 4].map((i) => frame(i, [["Send", i === 2 || i === 3 ? at(124) : BOX]]));
    expect(detect(step(frames))[0]).toMatchObject({ kind: "moves", px: 24, detail: "y 100 → 124, then back (24 px)" });
  });

  it("leaves a pixel of slack, and a step's free boxes alone", () => {
    const wobble = [0, 1, 2, 3].map((i) => frame(i, [["Send", i < 2 ? BOX : at(101)]]));
    expect(detect(step(wobble))).toEqual([]);
    const free = [0, 1, 2, 3].map((i) => frame(i, [[".turn hello", i < 2 ? BOX : at(300)]]));
    expect(detect(step(free, { free: [".turn"] }))).toEqual([]);
    expect(kinds(step(free))).toEqual(["moves"]);
  });

  it("is not a control stepping into the square another just left", () => {
    const row = { kinds: [".cf-r > *"] };
    const swap = [0, 1, 2, 3].map((i) => frame(i, i < 2 ? [[".cf-r > * Dictate", at(50)], [".cf-r > * Stop", BOX]] : [[".cf-r > * Stop", at(50)], [".cf-r > * Update", BOX]]));
    expect(detect(step(swap, row))).toEqual([]);
    // without the selectors, two keys are not known to be siblings
    expect(kinds(step(swap))).toEqual(["moves"]);
    // and the control pushed out of its square has moved
    const pushed = [0, 1, 2, 3].map((i) => frame(i, i < 2 ? [[".cf-r > * Dictate", at(50)], [".cf-r > * Stop", BOX]] : [[".cf-r > * Dictate", at(10)], [".cf-r > * Stop", at(50)]]));
    expect(detect(step(pushed, row)).map((f) => [f.kind, f.element])).toEqual([["moves", ".cf-r > * Dictate"]]);
  });

  it("counts from the surface's arrival when the step opens one", () => {
    const frames = [0, 1, 2, 3, 4, 5].map((i) => frame(i, i < 2 ? [] : [["Close", i < 4 ? BOX : at(90)]], { arrived: i >= 2 }));
    expect(detect(step(frames, { opens: true }))[0]).toMatchObject({ kind: "moves", ms: 2 * 16, frames: [3, 4, 5] });
  });
});

describe("flicker", () => {
  it("reports shown, gone, shown again with how long it was gone", () => {
    const frames = [0, 1, 2, 3, 4, 5, 6].map((i) => frame(i, i === 3 || i === 4 ? [] : [["chip", BOX]]));
    const [f, ...rest] = detect(step(frames));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ kind: "flicker", element: "chip", ms: 32, frames: [2, 3, 5], detail: "gone for 32 ms (2 frames), then back" });
    expect(f!.series?.map((p) => p[1])).toEqual([1, 1, 1, 0, 0, 1, 1]);
  });

  it("is not a sibling standing in the square (Send becomes Stop for the reply)", () => {
    const row = [".cf-r > *", ".turn"];
    const frames = [0, 1, 2, 3, 4].map((i) => frame(i, [[i === 2 || i === 3 ? ".cf-r > * Stop" : ".cf-r > * Send", BOX]]));
    expect(detect(step(frames, { kinds: row }))).toEqual([]);
    // a box of another kind in the square does not stand in
    const other = [0, 1, 2, 3, 4].map((i) => frame(i, [[i === 2 || i === 3 ? ".turn x" : ".cf-r > * Send", BOX]]));
    expect(kinds(step(other, { kinds: row, free: [".turn"] }))).toEqual(["flicker"]);
  });

  it("counts every gap but shows the first", () => {
    const frames = [0, 1, 2, 3, 4, 5].map((i) => frame(i, i === 1 || i === 4 ? [] : [["chip", BOX]]));
    expect(detect(step(frames))[0]).toMatchObject({ frames: [0, 1, 2], detail: "gone for 16 ms (1 frames), then back; 2 times in the step" });
  });

  it("is not a box that goes and stays gone, nor a placeholder", () => {
    const gone = [0, 1, 2, 3].map((i) => frame(i, i < 2 ? [["chip", BOX]] : []));
    expect(detect(step(gone))).toEqual([]);
    const skel = [0, 1, 2, 3].map((i) => frame(i, i === 1 ? [] : [["skel row", BOX]]));
    expect(detect(step(skel))).toEqual([]);
  });
});

describe("late", () => {
  const frames = [0, 1, 2, 3, 4, 5, 6].map((i) => frame(i, i < 2 ? [] : i < 5 ? [["title", BOX]] : [["title", BOX], ["Close", at(10)]], { arrived: i >= 2 }));

  it("reports what showed after the surface's first frame", () => {
    expect(detect(step(frames, { opens: true }))).toEqual([
      expect.objectContaining({ kind: "late", element: "Close", ms: 48, frames: [2, 5], detail: "arrived 48 ms and 3 frames after the surface showed" }),
    ]);
  });

  it("only on a step that opens a surface", () => {
    expect(detect(step(frames))).toEqual([]);
  });

  it("not when a placeholder held its place", () => {
    const held = [0, 1, 2, 3].map((i) => frame(i, i < 2 ? [["skel row", [0, 0, 200, 50]]] : [["row", [10, 10, 100, 20]]]));
    expect(detect(step(held, { opens: true }))).toEqual([]);
  });
});

describe("says it twice", () => {
  it("reports each phrase once, from the first frame it showed in", () => {
    const twin: Twin = { phrase: "new thread", els: [{ key: "button \"New thread\"", box: BOX, tip: false }, { key: "span.sb-h", box: at(300), tip: true }] };
    const frames = [0, 1, 2, 3].map((i) => frame(i, [], { twice: i >= 2 ? [twin] : [] }));
    const found = detect(step(frames));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "twice", element: "\"new thread\"", frames: [2], ms: 16, detail: "button \"New thread\" · tooltip of span.sb-h" });
    expect(found[0]!.boxes).toEqual([BOX, at(300)]);
  });
});

describe("cut off and errors", () => {
  it("carries what the page measured at the end of the step", () => {
    const frames = [frame(0, []), frame(1, [])];
    const found = detect(step(frames, {
      cut: [{ key: "span.name", box: BOX, how: "text", px: 31.6 }, { key: "div.menu", box: at(880), how: "edge", px: 12 }],
      errors: ["boom"],
    }));
    expect(found.map((f) => [f.kind, f.px, f.detail])).toEqual([
      ["cut", 32, "its words are 32 px wider than its box"],
      ["cut", 12, "12 px past the window's edge"],
      ["error", undefined, "boom"],
    ]);
    expect(found.every((f) => f.frames[0] === 1)).toBe(true);
  });
});

const dlg = (h: number) => [100, 50, 900, h] as const;
describe("resized", () => {
  it("reports a held frame whose size changes after the action: how much, when, first and last size", () => {
    // Settings at 640 tall, the next section makes it 700 and then 812
    const frames = [frame(0, [], { hold: [[".dlg", dlg(640)]] }), frame(1, [], { hold: [[".dlg", dlg(640)]] }),
      frame(2, [], { hold: [[".dlg", dlg(700)]] }), frame(3, [], { hold: [[".dlg", dlg(812)]] })];
    const found = detect(step(frames));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "resized", element: ".dlg", px: 172, ms: 16, frames: [0, 2, 3], detail: "h 640 → 812 (172 px at most)" });
    expect(found[0]!.boxes).toEqual([dlg(640), dlg(812)]);
  });
  it("leaves a pixel of slack, and a frame that was not there before the action alone", () => {
    const slack = [0, 1, 2].map((i) => frame(i, [], { hold: [[".dlg", dlg(i === 2 ? 641 : 640)]] }));
    expect(kinds(step(slack))).toEqual([]);
    const opened = [frame(0, []), frame(1, [], { hold: [["#picker", dlg(300)]] }), frame(2, [], { hold: [["#picker", dlg(500)]] })];
    expect(kinds(step(opened))).toEqual([]);
  });
});

describe("at the end of the step", () => {
  it("turns what the page found at the end into findings on the last frame", () => {
    const found = detect(step([frame(0, []), frame(1, []), frame(2, [])], {
      ends: [{ key: "div.think-body", box: BOX, kind: "through", detail: "painted inside main.stage, which is hidden" },
        { key: "div.dlg \"Usage\"", box: at(40), kind: "noclose", detail: "no Close, Back or Cancel button" }],
    }));
    expect(found.map((f) => [f.kind, f.element, f.frames])).toEqual([["through", "div.think-body", [2]], ["noclose", "div.dlg \"Usage\"", [2]]]);
    expect(found[1]!.boxes).toEqual([at(40)]);
  });
});

it("finds nothing when the surface never showed", () => {
  expect(detect(step([0, 1, 2].map((i) => frame(i, [["x", BOX]], { arrived: false }))))).toEqual([]);
});
