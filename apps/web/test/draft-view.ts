type Store = Pick<typeof import("../src/lib/store/store.ts"), "getState">;
type Drafts = Pick<typeof import("../src/lib/store/drafts.ts"), "getDraft">;

/** A read-only test observation; writes still use the real store and draft APIs. */
export function draftView(store: Store, drafts: Drafts) {
  const state = store.getState();
  const draft = drafts.getDraft(state.threadId);
  return { ...state, draft: draft.text, draftImages: draft.images, draftSendId: draft.sendId };
}
