// Where a thread changed what answers it: chat model to chat model, chat to image, image to chat.
// Read from what each reply already records (its model, or its picture's preset), so threads saved
// before this show it too and nothing new is stored.
import type { Message } from "@gates-local/contracts";
import { modelNameKey } from "./pick.ts";

/** What answered a question: a chat model by its tag, or an image setup by its preset id. */
export type Answerer = { readonly kind: "chat"; readonly model: string } | { readonly kind: "image"; readonly preset: string };
export interface Change { readonly from: Answerer; readonly to: Answerer }

/** The key of a live turn's question before the server saved it. */
export const LIVE_QUESTION = "live";

/**
 * The questions answered by something other than the turn before them, by question id. `live` is the
 * turn running now: what it was sent to counts from its first frame, before any reply is saved.
 */
export function modelChanges(messages: readonly Message[], live?: { readonly questionId: string | undefined; readonly by: Answerer }): ReadonlyMap<string, Change> {
  const changes = new Map<string, Change>();
  let before: Answerer | undefined;
  const turn = (questionId: string, by: Answerer | undefined) => {
    if (by === undefined) return;
    if (before !== undefined && !same(before, by)) changes.set(questionId, { from: before, to: by });
    before = by;
  };
  let question: string | undefined;
  let replies: Message[] = [];
  const close = () => {
    if (question !== undefined) turn(question, live?.questionId === question ? live.by : answeredBy(replies));
  };
  for (const m of messages) {
    if (m.role === "user") {
      close();
      question = m.id;
      replies = [];
    } else if (m.role === "assistant") replies.push(m);
  }
  close();
  if (live !== undefined && (live.questionId === undefined || !messages.some((m) => m.id === live.questionId))) turn(LIVE_QUESTION, live.by);
  return changes;
}

/** What answered one question, from its saved replies: a text reply's model, else its picture's preset. */
function answeredBy(replies: readonly Message[]): Answerer | undefined {
  const text = replies.find((m) => m.imageJob === undefined && m.model !== undefined);
  if (text?.model !== undefined) return { kind: "chat", model: text.model };
  const job = replies.find((m) => m.imageJob !== undefined);
  const preset = job?.imageJob?.sent?.preset ?? job?.imageJob?.choice?.preset ?? job?.model;
  return preset === undefined ? undefined : { kind: "image", preset };
}

const same = (a: Answerer, b: Answerer): boolean =>
  a.kind === "chat" ? b.kind === "chat" && modelNameKey(a.model) === modelNameKey(b.model) : b.kind === "image" && a.preset === b.preset;
