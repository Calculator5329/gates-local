// The pump: it asks the records (chat/replies.ts) which waiting message goes next, takes it,
// and begins its start. It listens to nothing: what happens to a start or a reply is said to
// the record by the work itself.
import type { Params, ResultOf } from "@gates-local/contracts";
import type { Replies } from "../chat/replies.ts";
import { rankChatModels } from "../runtime/pick.ts";
import { refusalOf } from "./errors.ts";
import type { AppContext, Taken } from "./turn.ts";

export interface QueuePumpDeps extends Pick<AppContext, "turns" | "byThread" | "closing" | "catalog" | "runtime" | "store"> {
  readonly replies: Replies;
  readonly settings: AppContext["deps"]["settings"];
  readonly newId: () => string;
  /** Begins the start of a taken message: the same work a window's chat.send begins. */
  readonly begin: (params: Params<"chat.send">, taken: Taken) => ResultOf<"chat.send"> | Promise<ResultOf<"chat.send">>;
}

export interface QueuePump {
  /** Look at the waiting messages once the current work settles: after a turn ends, the runtime or models change, or a message does. */
  pump(): void;
}

export function createQueuePump({ replies, turns, byThread, closing, catalog, runtime, store, settings, newId, begin }: QueuePumpDeps): QueuePump {
  let pumpAt: ReturnType<typeof setImmediate> | undefined;
  let pumping = false;
  const pump = () => {
    if (pumpAt === undefined && !closing()) pumpAt = setImmediate(() => { pumpAt = undefined; void startNext(); });
  };
  /** The next waiting message that can go, taken and begun; one at a time. */
  async function startNext(): Promise<void> {
    if (closing() || pumping) return;
    replies.notify();
    const best = rankChatModels(catalog.current() ?? [])[0]?.name;
    const q = replies.pick({ chat: runtime.status().state === "ready" && best !== undefined, anyWork: turns.size > 0, busy: (threadId) => byThread.has(threadId) });
    if (q === undefined) return;
    const { words } = q;
    const asked = store.getMessage(words.messageId);
    // a window's copy of a message that already went out: it was asked
    if (asked !== undefined && asked.threadId === q.threadId && asked.role === "user" && asked.content === words.text) {
      replies.sent(words.messageId);
      pump();
      return;
    }
    const turnId = newId();
    const attempt = replies.take(q.id, turnId, Date.now());
    if (attempt === undefined) return;
    pumping = true;
    try {
      const r = await begin({
        threadId: q.threadId, content: words.text, messageId: words.messageId,
        model: words.model ?? (words.draw === undefined ? best ?? "" : ""),
        numCtx: words.numCtx ?? settings?.get().defaultNumCtx ?? 4096,
        ...(words.images?.length ? { images: words.images } : {}),
        ...(words.files?.length ? { files: words.files } : {}),
        ...(words.think === undefined ? {} : { think: words.think }),
        ...(words.draw === undefined ? {} : { draw: words.draw, ...(words.drawCount === undefined ? {} : { drawCount: words.drawCount }) }),
        // Send now: a person is waiting on it, so a reply in another chat is not stopped without a yes
        ...(q.now ? (q.consent !== undefined ? { stopOthers: true, ...(q.consent.kind === "named" ? { stopTurns: q.consent.replies } : {}) } : { askFirst: true }) : {}),
      }, { turnId, attempt });
      // its question turned out to be in the chat already: no work began, and it was asked
      if ("replayed" in r) {
        replies.refused(turnId, attempt, { code: "internal", message: "this message was already sent" });
        replies.sent(words.messageId);
      } else replies.begun(turnId);
    } catch (e) {
      // refused before any work began (a reply already running there, a chat being deleted)
      replies.refused(turnId, attempt, refusalOf(e));
    } finally {
      replies.notify();
      pumping = false;
      pump();
    }
  }
  return { pump };
}
