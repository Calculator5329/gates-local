// What the Models page does to the session: set the default, remove a model
// (moving the default as the dialog said), cancel a download, and start a chat
// on a model that just finished downloading. Built from session.ts so the
// page holds no server logic of its own.
import { type ActionResult, cancelPull, newThread, pickModel, removeModel, updateSettings } from "./session.ts";
import { NA, type State, getState, setState } from "./store.ts";

/** The model the Default card shows: the saved default while it is installed, else the one new chats use now. */
export function cardDefault(s: State): string | undefined {
  const saved = s.settings === NA ? undefined : s.settings?.defaultModel;
  if (saved !== undefined && (s.models ?? []).some((m) => m.name === saved)) return saved;
  return s.model;
}

/** "Use as default" from the row menu or the Default card. */
export function useAsDefault(name: string): Promise<ActionResult> {
  return updateSettings({ defaultModel: name });
}

/**
 * Remove a model. When it was the default, `next` is the model the dialog
 * named (null: none can take over, so the default clears); it is saved only
 * after the removal worked, and new chats start on it from then on.
 */
export async function removeModelAndMoveDefault(name: string, next: string | null | undefined): Promise<ActionResult> {
  const wasCurrent = getState().model === name;
  const r = await removeModel(name);
  if (r !== null) return r;
  if (next === undefined) return null;
  const saved = await updateSettings({ defaultModel: next });
  if (saved === null && wasCurrent && next !== null) setState({ model: next });
  return saved;
}

/** Cancel a running download; its card goes once the server confirms. */
export function cancelDownload(name: string): Promise<ActionResult> {
  return cancelPull(name);
}

/** Forget a finished or failed download's card. */
export function dismissDownload(name: string): void {
  setState((s) => {
    const { [name]: _gone, ...pulls } = s.pulls;
    return { pulls };
  });
}

/** The ready card's Start chat: a new chat on that model, and the card goes. */
export function startChatWith(name: string): void {
  newThread();
  pickModel(name);
  dismissDownload(name);
}
