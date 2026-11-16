import { useRef, useState, useSyncExternalStore } from "react";
import { useAnimationFrame } from "../lib/ui/kit/frame.ts";
import { useChange } from "../lib/ui/kit/popover.ts";

export interface Pace {
  shown: number;
  target: number;
  at: number;
  arrival: number;
  rate: number;
  finish?: number;
}

export const createPace = (length: number, now: number): Pace => ({ shown: length, target: length, at: now, arrival: now, rate: 80 });

export function advancePace(p: Pace, target: number, streaming: boolean, now: number): number {
  if (target < p.target) Object.assign(p, createPace(0, now), { finish: undefined });
  if (target > p.target) {
    const sample = (target - p.target) * 1000 / Math.max(16, now - p.arrival);
    p.rate = p.target === 0 ? Math.max(80, target / .24) : p.rate * .75 + sample * .25;
    p.arrival = now;
  }
  p.target = target;
  if (!streaming) p.finish ??= now + 120;
  const left = Math.max(0, target - p.shown);
  const dt = Math.max(0, now - p.at) / 1000;
  const seconds = p.finish === undefined ? .24 : Math.max(.016, (p.finish - now) / 1000);
  p.shown = p.finish !== undefined && now >= p.finish ? target : Math.min(target, p.shown + Math.max(p.rate, left / seconds) * dt);
  p.at = now;
  return Math.floor(p.shown);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeCut(text: string, cut: number): number {
  if (cut >= text.length) return text.length;
  let radius = 32;
  for (;;) {
    let start = Math.max(0, cut - radius);
    const end = Math.min(text.length, cut + radius);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start--;
    const segments = segmenter.segment(text.slice(start, end));
    const part = segments.containing(cut - start);
    if (!part) return cut;
    if ((start > 0 && (part.index === 0 || /^\p{Regional_Indicator}/u.test(segments.containing(0)?.segment ?? ""))) ||
        (end < text.length && part.index + part.segment.length === end - start)) {
      radius *= 2;
      continue;
    }
    return start + part.index;
  }
}

let motion: MediaQueryList | undefined;
const motionQuery = () => motion ??= matchMedia("(prefers-reduced-motion: reduce)");
const motionWatchers = new Set<() => void>();
const motionChanged = () => { for (const change of motionWatchers) change(); };
const onMotion = (change: () => void) => {
  if (motionWatchers.size === 0) motionQuery().addEventListener("change", motionChanged);
  motionWatchers.add(change);
  return () => {
    motionWatchers.delete(change);
    if (motionWatchers.size === 0) motionQuery().removeEventListener("change", motionChanged);
  };
};
const reducedMotion = () => motionQuery().matches;

export function usePacedText(text: string, streaming: boolean): string {
  const reduced = useSyncExternalStore(onMotion, reducedMotion, reducedMotion);
  const [shown, setShown] = useState(text);
  const pace = useRef<Pace | null>(null);
  pace.current ??= createPace(text.length, performance.now());
  const state = pace.current;
  const active = !reduced && state.shown !== text.length;
  // why: each arrival under reduced motion is shown whole, and the pace starts again from it
  useChange(reduced ? text : null, (now) => {
    if (now === null) return;
    Object.assign(state, createPace(now.length, performance.now()), { finish: undefined });
    setShown(now);
  });
  // why: a reveal that starts after a pause counts its time from now, not from its last frame
  useChange(active, (on) => { if (on) state.at = performance.now(); });
  // why: the reveal's frames while words are held back; a render with all of them shown ends it
  useAnimationFrame((now) => {
    setShown(text.slice(0, graphemeCut(text, advancePace(state, text.length, streaming, now))));
    return true;
  }, active);
  return reduced ? text : text.startsWith(shown) ? shown : "";
}
