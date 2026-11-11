// What the Models page does to the session: set the default and remove a model
// (moving the default as the dialog said). Built from session.ts so the page
// holds no server logic of its own.
import { modelChoice } from "./pick.ts";
import { type ActionResult, removeModel, updateSettings } from "./session.ts";
import { NA, type State, getState, setState } from "./store.ts";

/** The saved default, while it is installed. Only this one needs no "Use as default". */
export function savedDefault(s: State): string | undefined {
  const saved = s.settings === NA ? undefined : s.settings?.defaultModel;
  return saved !== undefined && (s.models ?? []).some((m) => m.name === saved) ? saved : undefined;
}

/** The model the Default card shows: the saved default, else the one a new chat starts on before anyone picks, never the open chat's. */
export function cardDefault(s: State): string | undefined {
  const saved = savedDefault(s);
  if (saved !== undefined) return saved;
  const newChat = modelChoice(s.models, s.model, undefined);
  return newChat.kind === "keep" ? s.model : newChat.kind === "set" ? newChat.model : undefined;
}

/** "Use as default" from the row menu or the Default card. */
export function makeDefault(name: string): Promise<ActionResult> {
  return updateSettings({ defaultModel: name });
}

/** Two results: a removal that worked is finished and cannot be retried, even when the save after it failed. */
export interface RemoveResult {
  readonly removeErr: ActionResult;
  readonly defaultErr: ActionResult;
}

/**
 * Remove a model. When it was the default, `next` is the model the dialog
 * named (null: none can take over, so the default clears); it is saved only
 * after the removal worked, and new chats start on it from then on.
 */
export async function removeModelAndMoveDefault(name: string, next: string | null | undefined): Promise<RemoveResult> {
  const before = getState();
  const wasCurrent = before.model === name;
  const removeErr = await removeModel(name);
  if (removeErr !== null || next === undefined) return { removeErr, defaultErr: null };
  const refreshed = getState().model;
  const defaultErr = await updateSettings({ defaultModel: next });
  // Only the chat that was on the removed model moves, and only if nothing chose for it during the save.
  const now = getState();
  if (defaultErr === null && wasCurrent && next !== null && now.threadId === before.threadId && now.model === refreshed) setState({ model: next });
  return { removeErr: null, defaultErr };
}
