// The time, for text that ages on its own ("5m"). Every reader asking for the same interval shares
// one timer; each starts from the time it mounted, so nothing shows an older time than before.
import { useEffect, useState } from "react";

type Clock = { readonly timer: ReturnType<typeof setInterval>; readonly readers: Set<(now: number) => void> };
const clocks = new Map<number, Clock>();

function join(ms: number, reader: (now: number) => void): () => void {
  let clock = clocks.get(ms);
  if (clock === undefined) {
    const readers = new Set<(now: number) => void>();
    // oxlint-disable-next-line gates/timer-needs-reason -- the clock itself: time passing is the point, one timer per interval for every reader
    const timer = setInterval(() => {
      const now = Date.now();
      for (const r of readers) r(now);
    }, ms);
    clock = { timer, readers };
    clocks.set(ms, clock);
  }
  clock.readers.add(reader);
  const mine = clock;
  return () => {
    mine.readers.delete(reader);
    if (mine.readers.size === 0) {
      clearInterval(mine.timer);
      clocks.delete(ms);
    }
  };
}

/**
 * The time now, read again every `ms` milliseconds while `when` holds. Off, the reader leaves the
 * clock and keeps the last time it read (a clock that stops shows where it stopped).
 */
export function useNow(ms: number, when = true): number {
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line gates/effect-needs-reason -- keeps this reader on the shared clock while it is mounted and on
  useEffect(() => (when ? join(ms, setNow) : undefined), [ms, when]);
  return now;
}

/** Test only: how many clocks are running. */
export const clockCount = (): number => clocks.size;
