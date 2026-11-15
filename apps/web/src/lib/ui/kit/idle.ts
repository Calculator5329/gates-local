// Work that must not cost the first paint (a preload, a warm-up), and work cut into idle slices.

/** Idle work may wait this long on a busy page before it runs anyway. */
export const IDLE_LIMIT_MS = 1500;

/** Runs `work` after the next two frames, in idle time (or straight after, with no idle callback). Returns a cancel. */
export function scheduleIdle(work: () => void): () => void {
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // oxlint-disable-next-line gates/timer-needs-reason -- two frames, so the first paint happens before the work
  let frame = requestAnimationFrame(() => {
    // oxlint-disable-next-line gates/timer-needs-reason -- the second of the two frames
    frame = requestAnimationFrame(() => {
      // oxlint-disable-next-line gates/timer-needs-reason -- idle time, bounded so a busy page still gets the work
      if (typeof requestIdleCallback === "function") idle = requestIdleCallback(work, { timeout: IDLE_LIMIT_MS });
      // oxlint-disable-next-line gates/timer-needs-reason -- no idle callback here: the next task
      else timer = setTimeout(work, 0);
    });
  });
  return () => {
    cancelAnimationFrame(frame);
    if (idle !== undefined) cancelIdleCallback(idle);
    clearTimeout(timer);
  };
}

/** With no idle callback, a slice waits this long, then runs with no idle time to spend. */
export const NO_IDLE_WAIT_MS = 50;

/**
 * Runs `slice` once the browser is idle, or after `within` ms at most, with how long it may still
 * work (`timeLeft`, 0 once the wait ran out). For work cut into slices, each scheduling the next.
 * Returns a cancel.
 */
export function whenIdle(slice: (timeLeft: () => number) => void, within: number): () => void {
  if (typeof requestIdleCallback === "function") {
    // oxlint-disable-next-line gates/timer-needs-reason -- idle time, bounded so a page that is never idle still gets the slice
    const id = requestIdleCallback((deadline) => slice(() => deadline.timeRemaining()), { timeout: within });
    return () => cancelIdleCallback(id);
  }
  // oxlint-disable-next-line gates/timer-needs-reason -- no idle callback here: a short pause between slices so input still gets in
  const id = setTimeout(() => slice(() => 0), NO_IDLE_WAIT_MS);
  return () => clearTimeout(id);
}
