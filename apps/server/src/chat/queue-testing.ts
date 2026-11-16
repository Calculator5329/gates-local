import type { ReplyAnswer } from "@gates-local/contracts";
import type { Entry, Replies } from "./replies.ts";

type GoneWhy = Extract<ReplyAnswer, { answer: "gone" }>["why"];

export const entry = (id: string, threadId = "t1", more: Partial<Entry> = {}): Entry => ({ id, threadId, messageId: `m-${id}`, text: id, at: 1, waitFor: "reply", model: "m", numCtx: 4096, ...more });

export function sentFree(q: Replies, turnId: string, { threadId = "t1", messageId = `m-${turnId}`, text = turnId, at = 1, retryOf }: { threadId?: string; messageId?: string; text?: string; at?: number; retryOf?: string } = {}): void {
  const sent = q.send({ id: turnId, threadId, messageId, text, model: "m", numCtx: 4096, ...(retryOf === undefined ? {} : { retryOf }) }, { at, behind: "reply", busy: false, turnId });
  if (sent.kind !== "start") throw new Error(`${turnId} was not taken at once`);
}

export function waits(q: Replies, { id, threadId, waitFor, at, ...said }: Entry): "ok" | GoneWhy {
  const sent = q.send({ id, threadId, ...said }, { at, behind: waitFor, busy: true, turnId: `turn-${id}` });
  return sent.kind === "answer" && sent.answer.answer === "gone" ? sent.answer.why : "ok";
}
