// The finder's detectors: pure functions over one step's frames. Moves and
// late arrivals come from the probe's own rule (wholeFindings in
// test/e2e/flicker-probe.ts); flicker, words said twice and cut-off text are
// the finder's. Each finding carries numbers (px, ms), the frame indexes it
// shows in, and the boxes to outline on the sheet.
import { type WholeFrame, wholeFindings } from "../e2e/flicker-probe.ts";

/** One element in a phrase said twice: a visible label, or the tooltip of an element that has words of its own. */
export interface TwinEl { readonly key: string; readonly box: readonly number[]; readonly tip: boolean }
export interface Twin { readonly phrase: string; readonly els: readonly TwinEl[] }
/** A probe frame plus what the finder samples on the same animation frame. */
export interface FinderFrame extends WholeFrame {
  /** Wall-clock ms (the page's), to line frames up with the screencast. */
  readonly t: number;
  readonly twice: readonly Twin[];
}
/** Text wider than its box, or a box past the viewport's edge, at the end of the step. */
export interface CutEl { readonly key: string; readonly box: readonly number[]; readonly how: "text" | "edge"; readonly px: number }

export type Kind = "moves" | "flicker" | "late" | "twice" | "cut" | "error";
export interface Finding {
  readonly screen: string;
  readonly step: string;
  readonly kind: Kind;
  /** What it is about: a tracked box's key, a phrase, or an element. */
  readonly element: string;
  readonly px?: number;
  readonly ms?: number;
  /** Frame indexes it shows in: before and after for a move, shown/gone/back for a flicker. */
  readonly frames: readonly number[];
  readonly detail: string;
  /** Boxes to outline, x,y,w,h in page pixels (before, after for a move). */
  readonly boxes: readonly (readonly number[])[];
  /** [ms, value] points for the sheet's small timeline (px for a move, 1/0 shown for a flicker). */
  readonly series?: readonly (readonly [number, number])[];
}

export interface StepFrames {
  readonly screen: string;
  readonly step: string;
  readonly frames: readonly FinderFrame[];
  /** When the action started, on the frames' `at` clock. */
  readonly actAt: number;
  /** The step opens a surface: late arrivals count from its first frame. */
  readonly opens: boolean;
  /** Tracked kinds (selectors) that may move, come and go on this step. */
  readonly free?: readonly string[];
  readonly cut?: readonly CutEl[];
  readonly errors?: readonly string[];
  /** The followed selectors: a key is "<selector> <label>", so two keys of one selector are siblings. */
  readonly kinds?: readonly string[];
}

/** Within this many px a box has not moved (sub-pixel layout, the probe's rounding). */
export const SLACK = 1;
/** A flicker shorter than this is under one frame at 60 Hz rounding and never seen. */
export const MIN_GONE_MS = 0;

const isFree = (key: string, free: readonly string[]) => key.startsWith("skel ") || key.startsWith("wait ") || free.some((sel) => key === sel || key.startsWith(`${sel} `));
const boxOf = (f: WholeFrame, key: string) => f.els.find((e) => e.key === key)?.box;
const r = (n: number) => Math.round(n);
const AXES = ["x", "y", "w", "h"] as const;

/** Every finding on one step, most telling first within each kind. */
export function detect(s: StepFrames): Finding[] {
  const out: Finding[] = [];
  const from = s.frames.findIndex((f) => f.arrived);
  if (from < 0) return out;
  const free = s.free ?? [];
  const base = s.opens ? s.frames[from]!.at : s.actAt;
  const whole = wholeFindings(s.step, s.frames);
  out.push(...moves(s, from, base, free, whole.filter((w) => w.kind === "moved").map((w) => w.what)));
  if (s.opens) out.push(...late(s, from, free, whole.filter((w) => w.kind === "late").map((w) => w.what)));
  out.push(...flicker(s, from, base, free));
  out.push(...twice(s, from, base));
  for (const c of s.cut ?? []) {
    out.push({ screen: s.screen, step: s.step, kind: "cut", element: c.key, px: r(c.px), frames: [s.frames.length - 1], boxes: [c.box],
      detail: c.how === "text" ? `its words are ${r(c.px)} px wider than its box` : `${r(c.px)} px past the window's edge` });
  }
  for (const e of s.errors ?? []) out.push({ screen: s.screen, step: s.step, kind: "error", element: "console", frames: [s.frames.length - 1], boxes: [], detail: e.slice(0, 300) });
  return out;
}

const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= SLACK);

/** The followed selector a key belongs to (the longest that starts it), or the whole key. */
export function kindOf(key: string, kinds: readonly string[]): string {
  let best = "";
  for (const k of kinds) if ((key === k || key.startsWith(`${k} `)) && k.length > best.length) best = k;
  return best || key;
}

/**
 * A control that steps into the exact square a sibling just left (Stop taking
 * Dictate's place while a queued message is edited) is a swap: no box on the row
 * moved, one control stands in for another.
 */
function tookPlace(before: WholeFrame, after: WholeFrame, key: string, to: readonly number[], kinds: readonly string[]): boolean {
  const kind = kindOf(key, kinds);
  return before.els.some((e) => e.key !== key && kindOf(e.key, kinds) === kind && same(e.box, to) && !after.els.some((a) => a.key === e.key && same(a.box, to)));
}

/** While a control is gone, a sibling holds its exact square (Send becomes Stop for a reply, then Send again). */
function stoodIn(frames: readonly WholeFrame[], key: string, box: readonly number[], kinds: readonly string[]): boolean {
  const kind = kindOf(key, kinds);
  return frames.every((f) => f.els.some((e) => e.key !== key && kindOf(e.key, kinds) === kind && same(e.box, box)));
}

/** A box that shifts after it first showed: how far, on which side, and when. */
function moves(s: StepFrames, from: number, base: number, free: readonly string[], keys: readonly string[]): Finding[] {
  const out: Finding[] = [];
  for (const key of keys) {
    if (isFree(key, free)) continue;
    const at = s.frames.map((f, i) => ({ i, box: i >= from ? boxOf(f, key) : undefined })).filter((e): e is { i: number; box: readonly number[] } => e.box !== undefined);
    const first = at[0];
    if (!first) continue;
    let moved = -1, px = 0, axis = 0;
    for (const e of at) {
      for (let a = 0; a < 4; a++) {
        const d = Math.abs((e.box[a] ?? 0) - (first.box[a] ?? 0));
        if (d > SLACK && moved < 0) moved = at.indexOf(e);
        if (d > px) { px = d; axis = a; }
      }
    }
    if (moved < 0) continue;
    const before = at[moved - 1] ?? first, after = at[moved]!;
    if (tookPlace(s.frames[before.i]!, s.frames[after.i]!, key, after.box, s.kinds ?? [])) continue;
    const last = at.at(-1)!;
    const delta = (last.box[axis] ?? 0) - (first.box[axis] ?? 0);
    const back = Math.abs(delta) <= SLACK;
    // where it went: its end place, or (when it came back) where it was on the way
    const to = (back ? after.box[axis] : last.box[axis]) ?? 0;
    out.push({
      screen: s.screen, step: s.step, kind: "moves", element: key, px: r(px), ms: r(s.frames[after.i]!.at - base),
      frames: [before.i, after.i, last.i],
      detail: `${AXES[axis]} ${r(first.box[axis] ?? 0)} → ${r(to)}${back ? ", then back" : ""} (${r(px)} px)`,
      boxes: [before.box, back ? after.box : last.box],
      series: at.map((e) => [r(s.frames[e.i]!.at - base), r(e.box[axis] ?? 0)] as const),
    });
  }
  return out.toSorted((a, b) => (b.px ?? 0) - (a.px ?? 0));
}

/** Something that showed after the surface's first frame without a placeholder holding its place. */
function late(s: StepFrames, from: number, free: readonly string[], keys: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const first = s.frames[from]!;
  for (const key of keys) {
    if (isFree(key, free)) continue;
    const i = s.frames.findIndex((f, n) => n >= from && boxOf(f, key) !== undefined);
    if (i < 0) continue;
    out.push({ screen: s.screen, step: s.step, kind: "late", element: key, ms: r(s.frames[i]!.at - first.at), frames: [from, i], boxes: [boxOf(s.frames[i]!, key)!],
      detail: `arrived ${r(s.frames[i]!.at - first.at)} ms and ${i - from} frames after the surface showed` });
  }
  return out.toSorted((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
}

/** Shown, gone, shown again within the step. */
function flicker(s: StepFrames, from: number, base: number, free: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const keys = [...new Set(s.frames.slice(from).flatMap((f) => f.els.map((e) => e.key)))];
  for (const key of keys) {
    if (isFree(key, free)) continue;
    const on = s.frames.map((f, i) => i >= from && boxOf(f, key) !== undefined);
    const gaps: { shown: number; gone: number; back: number }[] = [];
    let last = -1;
    for (let i = from; i < on.length; i++) {
      if (!on[i]) continue;
      if (last >= 0 && i > last + 1) gaps.push({ shown: last, gone: last + 1, back: i });
      last = i;
    }
    // a sibling standing in its square the whole time is a swap, not a flicker
    const real = gaps.filter((g) => !stoodIn(s.frames.slice(g.gone, g.back), key, boxOf(s.frames[g.shown]!, key)!, s.kinds ?? []));
    gaps.splice(0, gaps.length, ...real);
    const gone = gaps.map((g) => s.frames[g.back]!.at - s.frames[g.gone]!.at).filter((ms) => ms >= MIN_GONE_MS);
    if (gone.length === 0) continue;
    const g = gaps[0]!;
    out.push({
      screen: s.screen, step: s.step, kind: "flicker", element: key, ms: r(Math.max(...gone)), frames: [g.shown, g.gone, g.back],
      detail: `gone for ${r(s.frames[g.back]!.at - s.frames[g.gone]!.at)} ms (${g.back - g.gone} frames), then back${gaps.length > 1 ? `; ${gaps.length} times in the step` : ""}`,
      boxes: [boxOf(s.frames[g.shown]!, key)!, boxOf(s.frames[g.back]!, key)!],
      series: s.frames.slice(from).map((f, n) => [r(f.at - base), on[from + n] ? 1 : 0] as const),
    });
  }
  return out.toSorted((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
}

/** The same phrase visible twice on the surface at once. */
function twice(s: StepFrames, from: number, base: number): Finding[] {
  const seen = new Map<string, { i: number; twin: Twin }>();
  for (let i = from; i < s.frames.length; i++) {
    for (const t of s.frames[i]!.twice) if (!seen.has(t.phrase)) seen.set(t.phrase, { i, twin: t });
  }
  return [...seen.values()].map(({ i, twin }) => ({
    screen: s.screen, step: s.step, kind: "twice" as const, element: `"${twin.phrase}"`, ms: r(Math.max(0, s.frames[i]!.at - base)), frames: [i],
    detail: twin.els.map((e) => `${e.tip ? "tooltip of " : ""}${e.key}`).join(" · "),
    boxes: twin.els.map((e) => e.box),
  }));
}
