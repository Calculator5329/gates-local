import { useEffect, useState } from "react";

export function useFlash<T>(ms: number, stays?: (value: T) => boolean, initial: T | null = null): readonly [T | null, (value: T | null) => void] {
  const [value, set] = useState<T | null>(initial);
  // oxlint-disable-next-line gates/effect-needs-reason -- holds the clear timer for the value on show, and drops it on change or unmount
  useEffect(() => {
    if (value === null || stays?.(value) === true) return;
    // oxlint-disable-next-line gates/timer-needs-reason -- how long the flash stays on screen
    const timer = setTimeout(() => set(null), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return [value, set] as const;
}

// why: each change is a new object, so a flash already showing starts its timer again
const fresh = (key: unknown): object | null => (key === null || key === undefined ? null : {});

export function useAfter(ms: number, key: unknown): boolean {
  const [waiting, flash] = useFlash<object>(ms, undefined, fresh(key));
  const [seen, see] = useState(key);
  // why: on the render a key arrives or changes, its wait has not started yet
  if (!Object.is(seen, key)) { see(key); flash(fresh(key)); return false; }
  return key !== null && key !== undefined && waiting === null;
}
