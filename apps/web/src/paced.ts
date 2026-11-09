import { useEffect, useRef, useState } from "react";

export interface Pace {
  shown: number;
  target: number;
  at: number;
  arrival: number;
  rate: number;
  finish?: number;
}

export const createPace = (length: number, now: number): Pace => ({ shown: length, target: length, at: now, arrival: now, rate: 80 });

/** A 240 ms reservoir absorbs delivery bursts; completion drains within 120 ms. */
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

/** Segment a small window, expanding only for a cluster crossing its edges.
 * Regional indicators need their preceding run too, to preserve flag pairing. */
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

/** Historical replies render immediately. Only a live reply owns a pacing loop. */
export function usePacedText(text: string, streaming: boolean): string {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [shown, setShown] = useState(streaming ? "" : text);
  const pace = useRef<Pace | null>(null);
  pace.current ??= createPace(streaming ? 0 : text.length, performance.now());
  const state = pace.current;
  const latest = useRef({ text, streaming });
  latest.current = { text, streaming };
  const raf = useRef(0);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (reduced) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      Object.assign(state, createPace(text.length, performance.now()), { finish: undefined });
      setShown(text);
      return;
    }
    const tick = (now: number) => {
      raf.current = 0;
      const value = latest.current;
      const cut = graphemeCut(value.text, advancePace(state, value.text.length, value.streaming, now));
      setShown(value.text.slice(0, cut));
      if (cut < value.text.length) raf.current = requestAnimationFrame(tick);
    };
    if (raf.current === 0 && state.shown !== text.length) {
      state.at = performance.now();
      raf.current = requestAnimationFrame(tick);
    }
  }, [text, streaming, reduced]);
  useEffect(() => () => { cancelAnimationFrame(raf.current); raf.current = 0; }, []);
  return reduced ? text : text.startsWith(shown) ? shown : "";
}
