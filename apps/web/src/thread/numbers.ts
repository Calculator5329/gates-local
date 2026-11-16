import { type ScopeName, type SyncMetadata, revisionOf } from "@gates-local/contracts";

export interface ThreadNumbers {
  begin(epoch: string, cached: Iterable<string>): boolean;
  of(sync: SyncMetadata | undefined, scope: ScopeName): number | undefined;
  row(threadId: string, list: number | undefined): boolean;
  list(list: number | undefined): ReadonlySet<string> | undefined;
  announce(threadId: string, chat: number | undefined): void;
  asked(threadId: string): number;
  hold(threadId: string, chat: number): void;
  current(threadId: string): boolean;
  known(threadId: string): number;
  drop(threadId: string): void;
}

export function createThreadNumbers(): ThreadNumbers {
  let epoch: string | undefined;
  let listAt = -1;
  const rowAt = new Map<string, number>();
  const known = new Map<string, number>();
  const held = new Map<string, number>();
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
      const copy = held.get(threadId) ?? (doubted.has(threadId) ? undefined : 0);
      return copy !== undefined && (known.get(threadId) ?? 0) <= copy;
    },
    known: threadId => known.get(threadId) ?? 0,
    drop(threadId) { known.delete(threadId); held.delete(threadId); doubted.delete(threadId); },
  };
}
