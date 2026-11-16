import { useEffect, useState } from "react";

export function useFlash<T>(ms: number, stays?: (value: T) => boolean): readonly [T | null, (value: T | null) => void] {
  const [value, set] = useState<T | null>(null);
  // oxlint-disable-next-line gates/effect-needs-reason -- holds the clear timer for the value on show, and drops it on change or unmount
  useEffect(() => {
    if (value === null || stays?.(value) === true) return;
    // oxlint-disable-next-line gates/timer-needs-reason -- how long the flash stays on screen
    const timer = setTimeout(() => set(null), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return [value, set] as const;
}
