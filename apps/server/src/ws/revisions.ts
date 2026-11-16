import type { FixedScope, SyncChange } from "@gates-local/contracts";

export interface Revisions<T extends object> {
  commit(value: T): T;
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
