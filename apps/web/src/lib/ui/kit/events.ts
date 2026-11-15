// Listeners on the document or the window for as long as a component wants them, and the
// "press outside closes it" rule every small menu shares.
import { type RefObject, useEffect, useEffectEvent } from "react";

export interface ListenOptions {
  /** Listen in the capture phase. */
  readonly capture?: boolean;
  readonly passive?: boolean;
  /** Listen only while true. */
  readonly when?: boolean;
  /** Where to listen: the document (the default) or the window. */
  readonly on?: "document" | "window";
}

/** Calls `handler` (always the newest one) for each `type` event while mounted and `when` holds. */
export function useDocumentEvent<K extends keyof DocumentEventMap & keyof WindowEventMap>(type: K, handler: (e: DocumentEventMap[K]) => void, options: ListenOptions = {}): void {
  const { capture = false, passive, when = true, on = "document" } = options;
  const handle = useEffectEvent(handler);
  // oxlint-disable-next-line gates/effect-needs-reason -- keeps a document or window listener attached while the component wants it
  useEffect(() => {
    if (!when) return;
    const target: EventTarget = on === "window" ? window : document;
    const listener = (e: Event) => handle(e as DocumentEventMap[K]);
    target.addEventListener(type, listener, { capture, ...(passive === undefined ? {} : { passive }) });
    return () => target.removeEventListener(type, listener, { capture });
  }, [type, capture, passive, when, on]);
}

/** While `open`, a press anywhere outside `ref` calls `close`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useDocumentEvent("pointerdown", (e) => {
    if (!ref.current?.contains(e.target as Node)) close();
  }, { when: open });
}
