import { CHAT_MODELS, type ChatModels } from "@gates-local/contracts";

let inUse: ChatModels = CHAT_MODELS;
const listeners = new Set<(list: ChatModels) => void>();

export const chatList = (): ChatModels => inUse;

export function useChatList(list: ChatModels): void {
  if (list === inUse) return;
  inUse = list;
  for (const listener of listeners) listener(list);
}

export function onChatList(listener: (list: ChatModels) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
