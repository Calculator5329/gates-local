// Whether a page panel lies over the chat right now. In a narrow window
// (pages.css) the panel covers everything; the app makes what is under it
// inert, so the keyboard cannot reach the chat behind it. Kept apart from the
// panel so the app's first chunk can read it without loading the panel.
import { useSyncExternalStore } from "react";

/** pages.css: at this width and below the panel covers the chat instead of standing beside it. */
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
