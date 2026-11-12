/// <reference lib="dom" />
// "Nothing moves or pops": an opening that should ease is judged against time,
// not frame count. A loaded machine can skip frames, so one long frame may
// carry half of an opening that eases correctly; a jump is still a jump in a
// normal frame. Each sample is the element's height at a frame's own
// timestamp, the clock its CSS transition runs on.
import type { Locator } from "@playwright/test";

export interface Sample { t: number; h: number }

interface Sampler { seen: Sample[]; until: number; finish?: (seen: Sample[]) => void }
const SAMPLER = "__e2eHeights";

/**
 * Heights of `target` at every frame, from a frame read before `act` starts until `forMs`
 * after it returns. Both ends are pinned to `act`, so a slow click on a loaded machine can
 * neither land before the first frame nor after the last.
 */
export async function sampleHeights(target: Locator, act: () => Promise<void>, forMs = 500): Promise<Sample[]> {
  await target.evaluate((n, key) => new Promise<void>((started) => {
    const s: Sampler = { seen: [], until: Infinity };
    (globalThis as unknown as Record<string, Sampler>)[key] = s;
    const look = (t: number) => {
      s.seen.push({ t, h: n.getBoundingClientRect().height });
      if (s.seen.length === 1) started();
      if (t < s.until) requestAnimationFrame(look); else s.finish?.(s.seen);
    };
    requestAnimationFrame(look);
  }), SAMPLER);
  await act();
  return target.evaluate((_, [key, span]) => new Promise<Sample[]>((done) => {
    const s = (globalThis as unknown as Record<string, Sampler>)[key]!;
    s.finish = done;
    s.until = performance.now() + span;
  }), [SAMPLER, forMs] as const);
}

/** One coordinate of a cubic Bézier from 0 to 1 with control points a and b, at parameter s. */
const curve = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;

/** CSS `ease`, cubic-bezier(.25, .1, .25, 1): the share of the change shown at time share x. */
export function ease(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (curve(0.25, 0.25, mid) < x) lo = mid; else hi = mid;
  }
  return curve(0.1, 1, (lo + hi) / 2);
}

export interface Opening {
  /** The height the element settled at. */
  full: number;
  /** Sampling began while it was still closed, so the frames read are the opening itself. */
  closedFirst: boolean;
  /** Frames that showed more of the opening than an `ease` over `durationMs` could have by then. */
  ahead: { atMs: number; shown: number; allowed: number }[];
}

/**
 * Reads an opening from 0 to its full height. The transition starts no earlier
 * than the last frame that still showed 0, so at every later frame an eased
 * opening shows at most ease(elapsed / duration) of its height; `slack` (a
 * share of the height) absorbs rounding. A jump shows all of it one frame
 * after that last closed frame, which only a frame longer than most of the
 * duration could hide, and no one can see an opening in a frame that long.
 */
export function readOpening(seen: readonly Sample[], durationMs: number, slack = 0.1): Opening {
  const full = seen.at(-1)?.h ?? 0;
  const firstOpen = seen.findIndex((s) => s.h >= 0.5);
  const closed = seen[firstOpen - 1];
  if (firstOpen < 1 || closed === undefined) return { full, closedFirst: false, ahead: [] };
  const ahead = seen.slice(firstOpen).flatMap((s) => {
    const atMs = s.t - closed.t;
    const shown = s.h / full;
    const allowed = ease(atMs / durationMs) + slack;
    return shown > allowed ? [{ atMs: Math.round(atMs), shown: Number(shown.toFixed(3)), allowed: Number(allowed.toFixed(3)) }] : [];
  });
  return { full, closedFirst: true, ahead };
}
