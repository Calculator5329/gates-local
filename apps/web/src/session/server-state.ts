import type { State } from "../store.ts";

/** A legacy receipt or accepted projection, applied in its current JavaScript task. */
export type ServerEvent = Partial<State> | ((state: State) => Partial<State> | void);

/** No queue, promise or batching: domain guards and existing application points stay in place. */
export function createServerState(read: () => State, publish: (patch: Partial<State>) => void) {
  return function applyServerEvent(event: ServerEvent): void {
    const patch = typeof event === "function" ? event(read()) : event;
    if (patch !== undefined) publish(patch);
  };
}
