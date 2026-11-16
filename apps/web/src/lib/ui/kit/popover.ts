import { type DependencyList, type RefObject, useLayoutEffect, useState } from "react";

export function usePopover(ref: RefObject<HTMLElement | null>, open: boolean, place: (el: HTMLElement) => void, deps?: DependencyList): void {
  // oxlint-disable-next-line gates/effect-needs-reason -- writes the pop-up's position, which depends on laid-out boxes, before the first paint
  useLayoutEffect(() => {
    const el = ref.current;
    if (open && el !== null) place(el);
  }, deps === undefined ? undefined : [open, ...deps]);
}

// why: changed may set only this component's own state (React's render-phase rule)
export function useChange<T>(value: T, changed: (now: T, before: T) => void): void {
  const [seen, setSeen] = useState(value);
  if (!Object.is(seen, value)) {
    setSeen(value);
    changed(value, seen);
  }
}
