import type { ReplyAnswer } from "@gates-local/contracts";
import type { Entry, Replies } from "./replies.ts";

type GoneWhy = Extract<ReplyAnswer, { answer: "gone" }>["why"];

export const entry = (id: string, threadId = "t1", more: Partial<Entry> = {}): Entry => ({ id, threadId, messageId: `m-${id}`, text: id, at: 1, waitFor: "reply", model: "m", numCtx: 4096, ...more });

export function waits(q: Replies, { id, threadId, waitFor, at, ...said }: Entry): "ok" | GoneWhy {
  const sent = q.send({ id, threadId, ...said }, { at, behind: waitFor, busy: true, turnId: `turn-${id}` });
  return sent.kind === "answer" && sent.answer.answer === "gone" ? sent.answer.why : "ok";
}
