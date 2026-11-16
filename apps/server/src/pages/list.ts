import { type ThreadPage, pageBlocks } from "@gates-local/contracts";
import type { ThreadStore } from "../threads/store.ts";

export function threadPages(store: Pick<ThreadStore, "fencedReplies">, threadId: string, before?: string, writing?: string): ThreadPage[] {
  const seen = new Set<string>();
  const out: ThreadPage[] = [];
  for (const reply of store.fencedReplies(threadId, before)) {
    if (reply.id === writing) continue;
    for (const b of pageBlocks(reply.content)) {
      if (!b.closed || seen.has(b.code)) continue;
      seen.add(b.code);
      out.push({ messageId: reply.id, code: b.code });
    }
  }
  return out;
}
