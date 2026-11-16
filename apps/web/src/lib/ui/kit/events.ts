import { type RefObject, useEffect, useEffectEvent } from "react";

export interface ListenOptions {
  readonly capture?: boolean;
  readonly passive?: boolean;
  readonly when?: boolean;
  readonly on?: "document" | "window";
}

export function useDocumentEvent<K extends keyof DocumentEventMap & keyof WindowEventMap>(type: K, handler: (e: DocumentEventMap[K]) => void, options?: ListenOptions): void;
export function useDocumentEvent<K extends keyof WindowEventMap>(type: K, handler: (e: WindowEventMap[K]) => void, options: ListenOptions & { readonly on: "window" }): void;
export function useDocumentEvent(type: string, handler: (e: Event) => void, options: ListenOptions = {}): void {
  const { capture = false, passive, when = true, on = "document" } = options;
  const handle = useEffectEvent(handler);
  // oxlint-disable-next-line gates/effect-needs-reason -- keeps a document or window listener attached while the component wants it
  useEffect(() => {
    if (!when) return;
    const target: EventTarget = on === "window" ? window : document;
    const listener = (e: Event) => handle(e);
    target.addEventListener(type, listener, { capture, ...(passive === undefined ? {} : { passive }) });
    return () => target.removeEventListener(type, listener, { capture });
  }, [type, capture, passive, when, on]);
}

export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useDocumentEvent("pointerdown", (e) => {
    if (!ref.current?.contains(e.target as Node)) close();
  }, { when: open });
}
