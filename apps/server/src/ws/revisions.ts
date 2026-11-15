// One number per thing, for ordered data. The owner of a thing commits each new immutable value
// here as it becomes current; an answer or push of that value then carries the number it was
// committed with, never the latest number at the time the frame is written.
import type { FixedScope, SyncChange } from "@gates-local/contracts";

export interface Revisions<T extends object> {
  /** Numbers `value` as the newest; returns it. Commit only the value readers and listeners get. */
  commit(value: T): T;
  /** The snapshot change for a value this owner committed. Throws for any other value. */
  stamp(value: T): SyncChange;
}

export function createRevisions<T extends object>(scope: FixedScope, initial: T): Revisions<T> {
  let rev = 0;
  const numbers = new WeakMap<T, number>([[initial, rev]]);
  return {
    commit(value) {
      numbers.set(value, ++rev);
      return value;
    },
    stamp(value) {
      const committed = numbers.get(value);
      if (committed === undefined) throw new Error(`${scope} value was not committed by its owner`);
      return { scope, kind: "snapshot", rev: committed };
    },
  };
}
