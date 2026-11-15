// The threads kind's numbers, as the socket frames them. The store counts its writes
// (ThreadStore.numbers); these read the numbers in the same turn as the value they go with, so a
// frame never carries a number newer or older than what it holds.
import { chatScope, type Payload, type SyncChange } from "@gates-local/contracts";
import type { HandlerContext } from "../ws/server.ts";
import type { ThreadStore } from "./store.ts";
import type { Thread } from "./types.ts";

type Numbered = Pick<ThreadStore, "numbers">;

const listChange = (store: Numbered): SyncChange => ({ scope: "threads", kind: "snapshot", rev: store.numbers.list() });
const chatChange = (store: Numbered, threadId: string): SyncChange => ({ scope: chatScope(threadId), kind: "snapshot", rev: store.numbers.chat(threadId) });

/** threads.list's answer: every chat's row, with the list's number and each chat's own. */
export function listRead(store: Pick<ThreadStore, "numbers" | "listThreads">, ctx?: HandlerContext): Thread[] {
  const threads = store.listThreads();
  ctx?.capture?.([listChange(store), ...threads.map(thread => chatChange(store, thread.id))]);
  return threads;
}

/** A read of one chat answers with the numbers it was read at: call it in the same turn as the read. */
export function chatRead(store: Numbered, threadId: string, ctx?: HandlerContext): void {
  ctx?.capture?.([listChange(store), chatChange(store, threadId)]);
}

/**
 * The push that one chat changed, ready to spread into `push`: its row as it is now (null once it
 * is deleted) and the numbers it is at. With `ctx`, the action that made the change answers with
 * the same numbers.
 */
export function threadChanged(store: Pick<ThreadStore, "numbers" | "threadRow">, threadId: string, ctx?: HandlerContext): [channel: "threads.changed", payload: Payload<"threads.changed">, changes: SyncChange[]] {
  const changes = [listChange(store), chatChange(store, threadId)];
  ctx?.capture?.(changes);
  return ["threads.changed", { threadId, thread: store.threadRow(threadId) ?? null }, changes];
}
