import { useSyncExternalStore } from "react";

export const COVER = "(max-width: 1099px)";

let covering = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function setCovering(on: boolean): void {
  if (on === covering) return;
  covering = on;
  for (const l of listeners) l();
}

export const useCovering = (): boolean => useSyncExternalStore(subscribe, () => covering, () => false);
