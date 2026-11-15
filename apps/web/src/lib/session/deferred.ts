export type DeferredState<T> = { kind: "pending" } | { kind: "ready"; value: T } | { kind: "error" };

/** One import shared by idle preloading and navigation. Failures stay local to the requested screen. */
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

/** Two frames leave the first paint alone; the idle timeout also warms a busy page. */
export { scheduleIdle as afterFirstPaint } from "../ui/kit/idle.ts";
