// The update status as ordered data. Both update modules work it out afresh on every read (the
// activity list and the startup note come from outside); this keeps the last value given out with
// its number. A value that differs from the last one given out is committed with the next number.
// Only a module's change point announces: a read that finds something new answers with its new
// number and pushes nothing, as reads never pushed, so a module's own pacing of its pushes (the
// download's progress) still holds.
import type { SyncChange, UpdateStatus } from "@gates-local/contracts";
import { createRevisions, type Revisions } from "../ws/revisions.ts";

export type StatusListener = (status: UpdateStatus, change: SyncChange) => void;

export interface PublishedStatus {
  /** The current status for a reader, committed first when it is new. */
  read(): UpdateStatus;
  /** A module's change point: commit the status when it is new, and announce it with its number. */
  changed(): void;
  /** The number a value from read() or a listener was committed with. */
  stamp(value: UpdateStatus): SyncChange;
}

export function publishStatus(work: () => UpdateStatus, announce?: StatusListener): PublishedStatus {
  // The first value is worked out when it is first wanted, not while the module is being built:
  // its inputs (other modules' activity) may not exist yet. It is number 0.
  let held: { value: UpdateStatus; text: string; revisions: Revisions<UpdateStatus> } | undefined;
  const settle = (): { value: UpdateStatus; revisions: Revisions<UpdateStatus> } => {
    const next = work();
    const text = JSON.stringify(next);
    if (held === undefined) held = { value: next, text, revisions: createRevisions<UpdateStatus>("update", next) };
    else if (text !== held.text) { held.value = held.revisions.commit(next); held.text = text; }
    return held;
  };
  return {
    read: () => settle().value,
    // The same value announced again keeps its number; a window that has it drops the repeat.
    changed: () => { const { value, revisions } = settle(); announce?.(value, revisions.stamp(value)); },
    stamp(value) {
      if (held === undefined) throw new Error("update value was not committed by its owner");
      return held.revisions.stamp(value);
    },
  };
}
