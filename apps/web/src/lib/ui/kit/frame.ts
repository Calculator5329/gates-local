// Work done once a frame while something animates (a paced reveal).
import { useEffect, useEffectEvent } from "react";

/** Calls `tick` every frame while `active`; `tick` returns false to stop until `active` turns on again. */
export function useAnimationFrame(tick: (time: number) => boolean, active: boolean): void {
  const step = useEffectEvent(tick);
  // oxlint-disable-next-line gates/effect-needs-reason -- holds the frame loop while active and cancels it on stop or unmount
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const frame = (time: number) => {
      // oxlint-disable-next-line gates/timer-needs-reason -- the next frame of the animation
      if (step(time)) id = requestAnimationFrame(frame);
    };
    // oxlint-disable-next-line gates/timer-needs-reason -- the animation's first frame
    id = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(id);
  }, [active]);
}
