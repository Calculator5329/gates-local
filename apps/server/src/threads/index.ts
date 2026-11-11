// Thread store: messages in SQLite (WAL), a streaming reply as one row marked interrupted.
export {
  DuplicateMessageError,
  InvalidInputError,
  StoreClosedError,
  StoreVersionTooNewError,
  ThreadNotFoundError,
} from "./errors.ts";
export { LATEST_VERSION } from "./migrations.ts";
export { DEFAULT_THREAD_TITLE, openThreadStore, type ModelSpeed, type ThreadStore, type ThreadStoreOptions } from "./store.ts";
export type { Message, MessageStats, NewMessage, Role, Thread, ThreadWithMessages } from "./types.ts";
