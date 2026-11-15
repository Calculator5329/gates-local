// The draft slots, one per chat, and their change signal. A chat's slot ends when the chat is
// deleted (thread/threads.ts), never because a thread list left it out; drafts.ts does the rest.
import type { AttachedFile } from "@gates-local/contracts";

export type DraftKey = string | null;
export interface DraftWords {
  readonly text: string;
  readonly images: readonly string[];
  /** Non-image files already copied to the server; the draft keeps only their names. */
  readonly files?: readonly AttachedFile[];
  readonly sendId: string | null;
}
export interface Draft extends DraftWords {
  /** Replacement identity: typing keeps it; clears, queued edits and restores replace it. */
  readonly version: number;
  readonly beforeEdit?: DraftWords;
}
export const slots = new Map<DraftKey, Draft>();
const listeners = new Set<() => void>();
let revision = 0;

export const draftRevision = () => revision;
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function changed(): void { revision++; for (const listener of listeners) listener(); }

export function dropDraft(key: DraftKey): void { if (slots.delete(key)) changed(); }
