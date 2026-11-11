// Files a person chose or dropped that a message cannot carry. Messages hold
// text and images only, so these stay as chips that say why until removed.
// Held in memory per draft and never saved: the file itself was never read.
import { useSyncExternalStore } from "react";
import { type DraftKey, currentDraftKey } from "./drafts.ts";
import { useStore } from "./store.ts";

export interface RefusedFile {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  /** Plain words for the chip's tooltip. */
  readonly reason: string;
  /** The Library can hold it, so the chip offers that way in. */
  readonly library: boolean;
  /** A dropped folder: the chip says so instead of a size. */
  readonly folder?: boolean;
}

export const sizeOf = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

const none: readonly RefusedFile[] = [];
const slots = new Map<DraftKey, readonly RefusedFile[]>();
const listeners = new Set<() => void>();
let next = 0;
const changed = () => { for (const listener of listeners) listener(); };

export function refuseFiles(key: DraftKey, files: readonly Omit<RefusedFile, "id">[]): void {
  if (!files.length) return;
  slots.set(key, [...(slots.get(key) ?? none), ...files.map(f => ({ ...f, id: ++next }))]);
  changed();
}

export function removeRefused(key: DraftKey, id: number): void {
  const left = (slots.get(key) ?? none).filter(f => f.id !== id);
  if (left.length) slots.set(key, left); else slots.delete(key);
  changed();
}

export function getRefused(key: DraftKey = currentDraftKey()): readonly RefusedFile[] { return slots.get(key) ?? none; }

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The refused files of the draft on screen. */
export function useRefused(): readonly RefusedFile[] {
  const key = useStore(s => s.threadId);
  const snapshot = () => getRefused(key);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
