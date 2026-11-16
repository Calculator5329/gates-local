// The numbers this window holds for the chat list and for each chat. On an ordered connection every
// answer and push about the list carries the list's number, and one about a chat also carries the
// chat's (the list's number at the last write to its messages). A row applies only when it is newer
// than the list read and the row this window already has; a chat's copy is current while no push or
// list has named a newer chat number than the copy's.
import { type ScopeName, type SyncMetadata, revisionOf } from "@gates-local/contracts";

export interface ThreadNumbers {
  /**
   * A new connection: an epoch the window has not seen forgets every number, and the chats `cached`
   * from before are not current until read again; true when it forgot.
   */
  begin(epoch: string, cached: Iterable<string>): boolean;
  /** The number an answer or push carries for `scope` on this connection; undefined when it has none. */
  of(sync: SyncMetadata | undefined, scope: ScopeName): number | undefined;
  /** Whether a row about `threadId` at list number `list` is newer than what the window shows. */
  row(threadId: string, list: number | undefined): boolean;
  /**
   * A whole list read at number `list`: undefined when an applied list is as new; else the chats whose
   * row the window holds from after the read, which keep their row (or stay deleted).
   */
  list(list: number | undefined): ReadonlySet<string> | undefined;
  /** A push or a list named the chat's number. */
  announce(threadId: string, chat: number | undefined): void;
  /** What a read sent now is at when its answer has no number: the newest named so far. */
  asked(threadId: string): number;
  /** The copy of the chat installed now is at this number. */
  hold(threadId: string, chat: number): void;
  /**
   * Whether the window's copy of the chat (the caller knows it has one) needs no read: nothing newer
   * was named than the read it came from, and it is not from before a connection that forgot.
   */
  current(threadId: string): boolean;
  /** The newest number named for the chat. */
  known(threadId: string): number;
  /** The chat is gone: its numbers go with it. */
  drop(threadId: string): void;
}

export function createThreadNumbers(): ThreadNumbers {
  let epoch: string | undefined;
  let listAt = -1;
  const rowAt = new Map<string, number>();
  const known = new Map<string, number>();
  const held = new Map<string, number>();
  /** Copies from before the last connection that forgot: each is read again on its next visit. */
  const doubted = new Set<string>();
  return {
    begin(next, cached) {
      if (next === epoch) return false;
      epoch = next;
      listAt = -1;
      rowAt.clear(); known.clear(); held.clear(); doubted.clear();
      for (const id of cached) doubted.add(id);
      return true;
    },
    of: (sync, scope) => epoch === undefined ? undefined : revisionOf(sync, epoch, scope),
    row(threadId, list) {
      if (list === undefined || list <= Math.max(listAt, rowAt.get(threadId) ?? -1)) return false;
      rowAt.set(threadId, list);
      return true;
    },
    list(list) {
      if (list === undefined || list <= listAt) return undefined;
      listAt = list;
      return new Set([...rowAt].filter(([, at]) => at > list).map(([id]) => id));
    },
    announce(threadId, chat) {
      if (chat !== undefined) known.set(threadId, Math.max(known.get(threadId) ?? 0, chat));
    },
    asked: threadId => known.get(threadId) ?? 0,
    hold(threadId, chat) {
      doubted.delete(threadId);
      held.set(threadId, Math.max(chat, held.get(threadId) ?? -1));
    },
    current(threadId) {
      // a copy put in without a read (a new chat's empty one) is at 0
      const copy = held.get(threadId) ?? (doubted.has(threadId) ? undefined : 0);
      return copy !== undefined && (known.get(threadId) ?? 0) <= copy;
    },
    known: threadId => known.get(threadId) ?? 0,
    drop(threadId) { known.delete(threadId); held.delete(threadId); doubted.delete(threadId); },
  };
}
