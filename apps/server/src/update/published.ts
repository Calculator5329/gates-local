import type { SyncChange, UpdateStatus } from "@gates-local/contracts";
import { createRevisions, type Revisions } from "../ws/revisions.ts";

export type StatusListener = (status: UpdateStatus, change: SyncChange) => void;

export interface PublishedStatus {
  read(): UpdateStatus;
  changed(): void;
  stamp(value: UpdateStatus): SyncChange;
}

export function publishStatus(work: () => UpdateStatus, announce?: StatusListener): PublishedStatus {
  // why: its inputs, other modules' activity, may not exist while the module is being built
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
    // why: a repeat keeps its number, so a window that has it drops it
    changed: () => { const { value, revisions } = settle(); announce?.(value, revisions.stamp(value)); },
    stamp(value) {
      if (held === undefined) throw new Error("update value was not committed by its owner");
      return held.revisions.stamp(value);
    },
  };
}
