// Work that must not cost the first paint: a preload, a warm-up.

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
