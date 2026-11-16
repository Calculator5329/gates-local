import { queuedOf } from "./queue.ts";

type Store = Pick<typeof import("../src/lib/store/store.ts"), "getState">;
type Drafts = Pick<typeof import("../src/lib/store/drafts.ts"), "getDraft">;

/** A read-only test observation; writes still use the real store and draft APIs. `queued`: the messages that wait, read from the window's records. */
export function draftView(store: Store, drafts: Drafts) {
  const state = store.getState();
  const draft = drafts.getDraft(state.threadId);
  return { ...state, draft: draft.text, draftImages: draft.images, draftSendId: draft.sendId, queued: queuedOf(state) };
}
