import { replaceDraft } from "../lib/store/drafts.ts";
import { newThread, send } from "../lib/session/index.ts";
import { focusComposer } from "./focus.ts";
import { getState, setState } from "../lib/store/store.ts";

export function startWith(text: string, image = false): void {
  if (getState().view !== "new") newThread();
  replaceDraft(null, { text });
  if (image) setState({ image: true });
  focusComposer(true);
}

export function askWith(text: string): void {
  if (getState().view !== "new") newThread();
  if (getState().image) setState({ image: false });
  focusComposer(true);
  void send(text, { keepDraft: true });
}
