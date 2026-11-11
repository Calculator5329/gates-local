import { replaceDraft } from "./drafts.ts";
import { newThread, send } from "./session.ts";
import { focusComposer } from "./Sidebar.tsx";
import { getState, setState } from "./store.ts";

/**
 * A starter's act (F43): a new chat with `text` in its message box, the
 * cursor after it. The new-chat screen's cards start here; from anywhere
 * else it opens the new chat first.
 */
export function startWith(text: string, image = false): void {
  if (getState().view !== "new") newThread();
  replaceDraft(null, { text });
  if (image) setState({ image: true });
  focusComposer(true);
}

/**
 * A Library sample's question: a new chat, sent at once to the chat model.
 * It never goes through the message box, so words and pictures the person
 * left waiting there stay as they were. A question about a database is
 * never a picture, so Image goes off.
 */
export function askWith(text: string): void {
  if (getState().view !== "new") newThread();
  if (getState().image) setState({ image: false });
  focusComposer(true);
  void send(text, { keepDraft: true });
}
