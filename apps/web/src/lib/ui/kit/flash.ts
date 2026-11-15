// A value shown for a moment and then gone: a check after Copy, an alert after a failed save.
import { useEffect, useState } from "react";

/**
 * A value that clears itself `ms` after it is set, unless `stays` says this one stays (a failure
 * that waits for a retry). Unmounting cancels the clear, so it never fires on a gone component.
 */
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
