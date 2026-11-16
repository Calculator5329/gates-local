import { frameLoop } from "./frame.ts";

export const IDLE_LIMIT_MS = 1500;

export function scheduleIdle(work: () => void): () => void {
  let frames = 0;
  let stopIdle: (() => void) | undefined;
  // why: two frames so the first paint comes first, then idle time (or the next task)
  const stopFrames = frameLoop(() => {
    frames += 1;
    if (frames < 2) return true;
    stopIdle = whenIdle(() => work(), IDLE_LIMIT_MS, 0);
    return false;
  });
  return () => {
    stopFrames();
    stopIdle?.();
  };
}

export const NO_IDLE_WAIT_MS = 50;

// external: once a browser's idle callback times out, timeRemaining() is 0
export function whenIdle(slice: (timeLeft: () => number) => void, within: number, pause = NO_IDLE_WAIT_MS): () => void {
  if (typeof requestIdleCallback === "function") {
    // oxlint-disable-next-line gates/timer-needs-reason -- idle time, bounded so a page that is never idle still gets the slice
    const id = requestIdleCallback((deadline) => slice(() => deadline.timeRemaining()), { timeout: within });
    return () => cancelIdleCallback(id);
  }
  // oxlint-disable-next-line gates/timer-needs-reason -- no idle callback here: a short pause between slices so input still gets in
  const id = setTimeout(() => slice(() => 0), pause);
  return () => clearTimeout(id);
}
