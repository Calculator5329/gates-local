export type DeferredState<T> = { kind: "pending" } | { kind: "ready"; value: T } | { kind: "error" };

export function deferred<T>(importScreen: () => Promise<T>) {
  let state: DeferredState<T> = { kind: "pending" };
  let promise: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: DeferredState<T>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load(): Promise<void> {
      promise ??= Promise.resolve().then(importScreen).then(
        (value) => publish({ kind: "ready", value }),
        () => publish({ kind: "error" }),
      );
      return promise;
    },
  };
}

export { scheduleIdle as afterFirstPaint } from "../ui/kit/idle.ts";
