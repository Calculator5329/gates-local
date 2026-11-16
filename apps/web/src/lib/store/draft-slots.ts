import type { AttachedFile } from "@gates-local/contracts";

export type DraftKey = string | null;
export interface DraftWords {
  readonly text: string;
  readonly images: readonly string[];
  readonly files?: readonly AttachedFile[];
  readonly sendId: string | null;
}
export interface Draft extends DraftWords {
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
