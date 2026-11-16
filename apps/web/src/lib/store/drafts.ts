import { useSyncExternalStore } from "react";
import type { AttachedFile } from "@gates-local/contracts";
import { type Draft, type DraftKey, type DraftWords, changed, slots, subscribeDrafts } from "./draft-slots.ts";
import { getState, setState, useStore } from "./store.ts";

export type { Draft, DraftKey, DraftWords } from "./draft-slots.ts";
export { draftRevision, dropDraft, subscribeDrafts } from "./draft-slots.ts";
const holds = (d: DraftWords) => d.text !== "" || d.images.length > 0 || (d.files?.length ?? 0) > 0;
const emptyImages: readonly string[] = [];
let version = 0;

export const currentDraftKey = (): DraftKey => getState().threadId;
export function getDraft(key: DraftKey = currentDraftKey()): Draft {
  let draft = slots.get(key);
  if (!draft) { draft = { text: "", images: emptyImages, sendId: null, version: ++version }; slots.set(key, draft); }
  return draft;
}
export const draftHolds = (key: DraftKey): boolean => holds(getDraft(key));

export function replaceDraft(key: DraftKey, patch: Partial<DraftWords>, typing = false): void {
  const previous = getDraft(key);
  const edited = patch.text !== undefined && patch.text !== previous.text || patch.images !== undefined && patch.images !== previous.images
    || patch.files !== undefined && patch.files !== previous.files;
  slots.delete(key);
  slots.set(key, { ...previous, ...patch, sendId: patch.sendId !== undefined ? patch.sendId : edited ? null : previous.sendId,
    version: typing && patch.text !== "" ? previous.version : ++version });
  changed();
}
export function editDraft(text: string): void {
  const state = getState();
  if (state.notice !== null || state.stopAsk !== null) setState({ notice: null, stopAsk: null });
  replaceDraft(currentDraftKey(), { text }, true);
}
export function clearDraft(key: DraftKey): void {
  slots.set(key, { ...(getDraft(key).beforeEdit ?? { text: "", images: emptyImages, sendId: null }), version: ++version });
  changed();
}
export function renewDraft(key: DraftKey): void {
  slots.set(key, { ...getDraft(key), version: ++version });
  changed();
}
export function moveDraft(from: DraftKey, to: DraftKey): void {
  const draft = getDraft(from);
  slots.delete(from);
  if (holds(draft) || draft.beforeEdit) {
    slots.delete(to);
    slots.set(to, { ...draft, version: ++version });
  }
  changed();
}
export function beginQueuedDraft(key: DraftKey, text: string, images: readonly string[], sendId: string | null, files?: readonly AttachedFile[]): void {
  const old = getDraft(key);
  slots.delete(key);
  slots.set(key, { text, images, ...(files?.length ? { files } : {}), sendId, version: ++version,
    beforeEdit: old.beforeEdit ?? { text: old.text, images: old.images, ...(old.files?.length ? { files: old.files } : {}), sendId: old.sendId } });
  changed();
}
export function cancelQueuedDraft(key: DraftKey): void {
  const old = getDraft(key);
  if (!old.beforeEdit) return;
  slots.set(key, { ...old.beforeEdit, version: ++version });
  changed();
}

export function draftFilePaths(): Set<string> {
  const paths = new Set<string>();
  for (const draft of slots.values()) for (const f of [...draft.files ?? [], ...draft.beforeEdit?.files ?? []]) paths.add(f.path);
  return paths;
}

export function savedDrafts(): readonly { key: DraftKey; draft: Draft }[] {
  const drafts = [...slots].filter(([, d]) => holds(d) || d.beforeEdit !== undefined).slice(-32);
  let imageSlots = 0;
  return drafts.toReversed().map(([key, draft]) => {
    const keep = draft.images.length > 0 || (draft.beforeEdit?.images.length ?? 0) > 0 ? ++imageSlots <= 2 : true;
    return { key, draft: keep ? draft : { ...draft, images: emptyImages, sendId: draft.images.length ? null : draft.sendId,
      ...(draft.beforeEdit ? { beforeEdit: { ...draft.beforeEdit, images: emptyImages, sendId: draft.beforeEdit.images.length ? null : draft.beforeEdit.sendId } } : {}) } };
  }).toReversed();
}
export function restoreDrafts(drafts: readonly { key: DraftKey; draft: DraftWords & { beforeEdit?: DraftWords } }[]): ReadonlySet<DraftKey> {
  const memory = new Map([...slots].filter(([, draft]) => holds(draft) || draft.beforeEdit !== undefined));
  const restored = new Set<DraftKey>();
  slots.clear();
  for (const { key, draft } of drafts) if (!memory.has(key)) {
    slots.set(key, { ...draft, version: ++version });
    restored.add(key);
  }
  for (const [key, draft] of memory) slots.set(key, draft);
  changed();
  return restored;
}

// why: one subscription feeds every draft reader, so typing reruns only cheap selectors
export function useDraft<T>(selector: (draft: Draft) => T): T {
  const key = useStore(s => s.threadId);
  const snapshot = () => selector(getDraft(key));
  return useSyncExternalStore(subscribeDrafts, snapshot, snapshot);
}
