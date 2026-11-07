// Thread store: completed messages in SQLite (WAL), streaming deltas in memory.
export {
  DuplicateMessageError,
  InvalidInputError,
  StoreClosedError,
  StoreVersionTooNewError,
  ThreadNotFoundError,
  TurnBufferClosedError,
} from "./errors.ts";
export { LATEST_VERSION } from "./migrations.ts";
export { DEFAULT_THREAD_TITLE, openThreadStore, type ThreadStore, type ThreadStoreOptions } from "./store.ts";
export { createTurnBuffer, type TurnBuffer, type TurnBufferOptions, type TurnBufferState, type TurnPartial } from "./turn-buffer.ts";
export type { Message, MessageStats, NewMessage, Role, Thread, ThreadWithMessages } from "./types.ts";
