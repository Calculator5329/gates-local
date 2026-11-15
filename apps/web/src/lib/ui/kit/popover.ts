// A pop-up placed against its control, and state that resets when what it belongs to changes.
import { type DependencyList, type RefObject, useLayoutEffect, useState } from "react";

/**
 * While `open`, runs `place` on the pop-up's node after each commit, before the browser paints,
 * so it is never drawn in the wrong place first. With `deps`, only when one of them changed.
 */
export function usePopover(ref: RefObject<HTMLElement | null>, open: boolean, place: (el: HTMLElement) => void, deps?: DependencyList): void {
  // oxlint-disable-next-line gates/effect-needs-reason -- writes the pop-up's position, which depends on laid-out boxes, before the first paint
  useLayoutEffect(() => {
    const el = ref.current;
    if (open && el !== null) place(el);
  }, deps === undefined ? undefined : [open, ...deps]);
}

/**
 * Calls `changed` during render when `value` differs from the last render's (not on the first),
 * so state that belongs to the old value resets in the same render instead of one commit late.
 * `changed` may only set this component's own state.
 */
export function useChange<T>(value: T, changed: (now: T, before: T) => void): void {
  const [seen, setSeen] = useState(value);
  if (!Object.is(seen, value)) {
    setSeen(value);
    changed(value, seen);
  }
}
