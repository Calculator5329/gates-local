import { useEffect, useEffectEvent } from "react";

// why: the one frame request in the client; every frame loop and one-frame wait goes through it
export function frameLoop(step: (time: number) => boolean): () => void {
  let id = 0;
  const arm = () => {
    // oxlint-disable-next-line gates/timer-needs-reason -- the loop's next frame, asked for again while step says go on
    id = requestAnimationFrame((time) => {
      if (step(time)) arm();
    });
  };
  arm();
  return () => cancelAnimationFrame(id);
}

export function useAnimationFrame(tick: (time: number) => boolean, active: boolean): void {
  const step = useEffectEvent(tick);
  // oxlint-disable-next-line gates/effect-needs-reason -- holds the frame loop while active and cancels it on stop or unmount
  useEffect(() => (active ? frameLoop((time) => step(time)) : undefined), [active]);
}
