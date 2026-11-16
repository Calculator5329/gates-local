import { chatScope, type Payload, type SyncChange } from "@gates-local/contracts";
import type { HandlerContext } from "../ws/server.ts";
import type { ThreadStore } from "./store.ts";
import type { Thread } from "./types.ts";

type Numbered = Pick<ThreadStore, "numbers">;

const listChange = (store: Numbered): SyncChange => ({ scope: "threads", kind: "snapshot", rev: store.numbers.list() });
const chatChange = (store: Numbered, threadId: string): SyncChange => ({ scope: chatScope(threadId), kind: "snapshot", rev: store.numbers.chat(threadId) });

export function listRead(store: Pick<ThreadStore, "numbers" | "listThreads">, ctx?: HandlerContext): Thread[] {
  const threads = store.listThreads();
  ctx?.capture?.([listChange(store), ...threads.map(thread => chatChange(store, thread.id))]);
  return threads;
}

export function chatRead(store: Numbered, threadId: string, ctx?: HandlerContext): void {
  ctx?.capture?.([listChange(store), chatChange(store, threadId)]);
}

export function threadChanged(store: Pick<ThreadStore, "numbers" | "threadRow">, threadId: string, ctx?: HandlerContext): [channel: "threads.changed", payload: Payload<"threads.changed">, changes: SyncChange[]] {
  const changes = [listChange(store), chatChange(store, threadId)];
  ctx?.capture?.(changes);
  return ["threads.changed", { threadId, thread: store.threadRow(threadId) ?? null }, changes];
}
