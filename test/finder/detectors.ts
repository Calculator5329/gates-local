// The finder's detectors: pure functions over one step's frames. Moves and
// late arrivals come from the probe's own rule (wholeFindings in
// test/e2e/flicker-probe.ts); flicker, words said twice and cut-off text are
// the finder's. Each finding carries numbers (px, ms), the frame indexes it
// shows in, and the boxes to outline on the sheet.
import { type WholeFrame, wholeFindings } from "../e2e/flicker-probe.ts";

/** One element in a phrase said twice: a visible label, or the tooltip of an element that has words of its own. */
export interface TwinEl { readonly key: string; readonly box: readonly number[]; readonly tip: boolean }
export interface Twin { readonly phrase: string; readonly els: readonly TwinEl[] }
/** A surface's frame (a pop-up, a picker) by its selector, wherever it is in the page. */
export interface HeldBox { readonly sel: string; readonly box: readonly number[] }
/** A probe frame plus what the finder samples on the same animation frame. */
export interface FinderFrame extends WholeFrame {
  /** Wall-clock ms (the page's), to line frames up with the screencast. */
  readonly t: number;
  readonly twice: readonly Twin[];
  /** The frames that keep one size whatever is in them (HOLD in screens.ts), when shown. */
  readonly hold?: readonly HeldBox[];
}
/** Text wider than its box, or a box past the viewport's edge, at the end of the step. */
export interface CutEl { readonly key: string; readonly box: readonly number[]; readonly how: "text" | "edge"; readonly px: number }
/**
 * Read over the whole page once the step is quiet: words painted although a layer
 * they sit in is hidden (`through`), and a pop-up that holds the page with no
 * Close or Back of its own (`noclose`).
 */
export interface EndEl { readonly key: string; readonly box: readonly number[]; readonly kind: "through" | "noclose"; readonly detail: string }

export type Kind = "moves" | "resized" | "flicker" | "late" | "twice" | "cut" | "through" | "noclose" | "error";
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
  /** Tracked kinds that are meant to make room on this step: they may grow for something that arrives inside them (see madeRoom). */
  readonly grows?: readonly string[];
  readonly cut?: readonly CutEl[];
  readonly ends?: readonly EndEl[];
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
  out.push(...resized(s));
  if (s.opens) out.push(...late(s, from, free, whole.filter((w) => w.kind === "late").map((w) => w.what)));
  out.push(...flicker(s, from, base, free));
  out.push(...twice(s, from, base));
  for (const c of s.cut ?? []) {
    out.push({ screen: s.screen, step: s.step, kind: "cut", element: c.key, px: r(c.px), frames: [s.frames.length - 1], boxes: [c.box],
      detail: c.how === "text" ? `its words are ${r(c.px)} px wider than its box` : `${r(c.px)} px past the window's edge` });
  }
  for (const e of s.ends ?? []) out.push({ screen: s.screen, step: s.step, kind: e.kind, element: e.key, frames: [s.frames.length - 1], boxes: [e.box], detail: e.detail });
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

const area = (e: readonly number[]) => (e[2]! - e[0]!) * (e[3]! - e[1]!);
const EDGES = (b: readonly number[]) => [b[0] ?? 0, b[1] ?? 0, (b[0] ?? 0) + (b[2] ?? 0), (b[1] ?? 0) + (b[3] ?? 0)] as const;

/**
 * A box that made room: one edge went and the other three held on every frame, and the
 * strip it gained holds a box that was not on screen before (the message box growing
 * upward for the queue shelf), or the strip it lost held one that has left. That is the
 * box doing its job, on a step that says it is meant to (`grows`): anywhere else a card
 * that grows by a row is a finding. A box that grew for nothing new, or whose second edge
 * went too, has moved.
 */
function madeRoom(frames: readonly WholeFrame[], at: readonly { readonly i: number; readonly box: readonly number[] }[], key: string): boolean {
  const first = at[0]!, last = at.at(-1)!;
  const a = EDGES(first.box), b = EDGES(last.box);
  const went = [0, 1, 2, 3].filter((e) => Math.abs(a[e]! - b[e]!) > SLACK);
  const edge = went[0];
  if (edge === undefined) return false;
  if (at.some((f) => EDGES(f.box).some((v, e) => e !== edge && Math.abs(v - a[e]!) > SLACK))) return false;
  // the strip between the edge's two places, across the box
  const strip = [...a] as number[];
  strip[edge] = Math.min(a[edge]!, b[edge]!);
  strip[edge < 2 ? edge + 2 : edge - 2] = Math.max(a[edge]!, b[edge]!);
  const grew = area(b) > area(a);
  const holds = frames[grew ? last.i : first.i]!, other = frames[grew ? first.i : last.i]!;
  return holds.els.some((e) => {
    if (e.key === key || other.els.some((o) => o.key === e.key)) return false;
    const cx = (e.box[0] ?? 0) + (e.box[2] ?? 0) / 2, cy = (e.box[1] ?? 0) + (e.box[3] ?? 0) / 2;
    return cx >= strip[0]! && cx <= strip[2]! && cy >= strip[1]! && cy <= strip[3]!;
  });
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
    if (isFree(key, s.grows ?? []) && madeRoom(s.frames, at, key)) continue;
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

/**
 * A frame that keeps one size whatever is in it (a pop-up, a picker: owner, settings
 * row 26 and image row 7) and changed after the action: measured from the last frame
 * before the action, so a step that swaps what is inside it counts, not only one
 * that opens it. A frame that was not up before the action has nothing to change from.
 */
function resized(s: StepFrames): Finding[] {
  const out: Finding[] = [];
  const before = s.frames.findLastIndex((f) => f.at < s.actAt);
  if (before < 0) return out;
  for (const held of s.frames[before]!.hold ?? []) {
    const at = s.frames.map((f, i) => ({ i, box: i > before ? f.hold?.find((h) => h.sel === held.sel)?.box : undefined }))
      .filter((e): e is { i: number; box: readonly number[] } => e.box !== undefined);
    let changed = -1, px = 0, axis = 0;
    for (const e of at) {
      for (let a = 0; a < 4; a++) {
        const d = Math.abs((e.box[a] ?? 0) - (held.box[a] ?? 0));
        if (d > SLACK && changed < 0) changed = e.i;
        if (d > px) { px = d; axis = a; }
      }
    }
    if (changed < 0) continue;
    const last = at.at(-1)!;
    out.push({
      screen: s.screen, step: s.step, kind: "resized", element: held.sel, px: r(px), ms: r(s.frames[changed]!.at - s.actAt),
      frames: [before, changed, last.i],
      detail: `${AXES[axis]} ${r(held.box[axis] ?? 0)} → ${r(last.box[axis] ?? 0)} (${r(px)} px at most)`,
      boxes: [held.box, last.box],
      series: [[r(s.frames[before]!.at - s.actAt), r(held.box[axis] ?? 0)], ...at.map((e) => [r(s.frames[e.i]!.at - s.actAt), r(e.box[axis] ?? 0)] as const)],
    });
  }
  return out;
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
