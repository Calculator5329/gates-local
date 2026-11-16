import { modelChoice } from "./pick.ts";
import { type ActionResult, removeModel, updateSettings } from "../lib/session/index.ts";
import { NA, type State, getState, setState } from "../lib/store/store.ts";

export function savedDefault(s: State): string | undefined {
  const saved = s.settings === NA ? undefined : s.settings?.defaultModel;
  return saved !== undefined && (s.models ?? []).some((m) => m.name === saved) ? saved : undefined;
}

export function cardDefault(s: State): string | undefined {
  const saved = savedDefault(s);
  if (saved !== undefined) return saved;
  const newChat = modelChoice(s.models, s.model, undefined);
  return newChat.kind === "keep" ? s.model : newChat.kind === "set" ? newChat.model : undefined;
}

export function makeDefault(name: string): Promise<ActionResult> {
  return updateSettings({ defaultModel: name });
}

export interface RemoveResult {
  readonly removeErr: ActionResult;
  readonly defaultErr: ActionResult;
}

export async function removeModelAndMoveDefault(name: string, next: string | null | undefined): Promise<RemoveResult> {
  const before = getState();
  const wasCurrent = before.model === name;
  const removeErr = await removeModel(name);
  if (removeErr !== null || next === undefined) return { removeErr, defaultErr: null };
  const refreshed = getState().model;
  const defaultErr = await updateSettings({ defaultModel: next });
  const now = getState();
  if (defaultErr === null && wasCurrent && next !== null && now.threadId === before.threadId && now.model === refreshed) setState({ model: next });
  return { removeErr: null, defaultErr };
}
