// The chat model list this server uses: the one built into the app
// (packages/contracts/src/chat-models.json), or a newer signed list an
// installed copy downloaded with its update check (update/installed/
// models-list.ts). The catalog, the tiers and the pick read it through
// chatList() on every call, so a list that arrives shows on the next read;
// listeners (app.ts) tell the clients.
import { CHAT_MODELS, type ChatModels } from "@gates-local/contracts";

let inUse: ChatModels = CHAT_MODELS;
const listeners = new Set<(list: ChatModels) => void>();

export const chatList = (): ChatModels => inUse;

/** Use list from now on; listeners hear of it only when it is another list. */
export function useChatList(list: ChatModels): void {
  if (list === inUse) return;
  inUse = list;
  for (const listener of listeners) listener(list);
}

export function onChatList(listener: (list: ChatModels) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
