// The pump: it asks the records (chat/replies.ts) which waiting message goes next, takes it,
// and begins its start. It listens to nothing: what happens to a start or a reply is said to
// the record by the work itself.
import type { Message } from "@gates-local/contracts";
import type { Picked, Replies } from "../chat/replies.ts";
import type { Behind } from "../chat/reply.ts";
import { rankChatModels } from "../runtime/pick.ts";
import { refusalOf } from "./errors.ts";
import type { AppContext, StartAnswer, StartParams, Taken } from "./turn.ts";

export interface QueuePumpDeps extends Pick<AppContext, "turns" | "byThread" | "closing" | "catalog" | "runtime" | "store"> {
  readonly replies: Replies;
  readonly settings: AppContext["deps"]["settings"];
  readonly newId: () => string;
  /** Begins the start of a taken message. */
  readonly begin: (params: StartParams, taken: Taken) => StartAnswer | Promise<StartAnswer>;
}

export interface QueuePump {
  /** Look at the waiting messages once the current work settles: after a turn ends, the runtime or models change, or a message does. */
  pump(): void;
  // why: `asked` is a question saved before any work began, `refused` a refusal before any work
  start(q: Picked, turnId: string, attempt: number): Promise<{ readonly asked?: Message | undefined; readonly refused?: unknown }>;
  behind(): Behind;
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
      await start(q, turnId, attempt);
    } finally {
      pumping = false;
      pump();
    }
  }
  const start: QueuePump["start"] = async (q, turnId, attempt) => {
    const { words } = q;
    try {
      const r = await begin({
        threadId: q.threadId, content: words.text, messageId: words.messageId,
        model: words.model ?? (words.draw === undefined ? rankChatModels(catalog.current() ?? [])[0]?.name ?? "" : ""),
        numCtx: words.numCtx ?? settings?.get().defaultNumCtx ?? 4096,
        ...(words.images?.length ? { images: words.images } : {}),
        ...(words.files?.length ? { files: words.files } : {}),
        ...(words.think === undefined ? {} : { think: words.think }),
        ...(words.tools === undefined ? {} : { tools: words.tools }),
        ...(words.retryOf === undefined ? {} : { retryOf: words.retryOf }),
        ...(words.draw === undefined ? {} : { draw: words.draw, ...(words.drawCount === undefined ? {} : { drawCount: words.drawCount }) }),
        // Send now: a person is waiting on it, so a reply in another chat is not stopped without a yes
        ...(q.now ? (q.consent !== undefined ? { stopOthers: true, ...(q.consent.kind === "named" ? { stopTurns: q.consent.replies } : {}) } : { askFirst: true }) : {}),
      }, { turnId, attempt });
      // its question turned out to be in the chat already: no work began, and it was asked
      if ("replayed" in r) {
        replies.refused(turnId, attempt, { code: "internal", message: "this message was already sent" });
        replies.sent(words.messageId);
        return { asked: r.userMessage };
      }
      replies.begun(turnId);
      return {};
    } catch (e) {
      // refused before any work began (a reply already running there, a chat being deleted)
      replies.refused(turnId, attempt, refusalOf(e));
      return { refused: e };
    } finally {
      replies.notify();
    }
  };
  const behind: QueuePump["behind"] = () => {
    const { state } = runtime.status();
    if (state === "installing") return "setup";
    const models = catalog.current();
    // why: a list not read yet says nothing; only a read list with no chat model means a download first
    return state === "ready" && models !== undefined && rankChatModels(models)[0] === undefined ? "download" : "reply";
  };
  return { pump, start, behind };
}
