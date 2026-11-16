import { type State, getState, subscribe } from "../../store/store.ts";

// why: a store value followed outside render; changed hears each new value once, after its write
export function watch<T>(select: (s: State) => T, changed: (now: T, before: T) => void): () => void {
  let before = select(getState());
  return subscribe(() => {
    const now = select(getState());
    if (Object.is(now, before)) return;
    const was = before;
    before = now;
    changed(now, was);
  });
}
