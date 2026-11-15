// The queue every window shows, moved on by what each turn's events say and sent one message
// at a time through chat.send (the queue itself is chat/queue.ts).
import type { Params, Payload, ResultOf } from "@gates-local/contracts";
import type { Queue, Why } from "../chat/queue.ts";
import { rankChatModels } from "../runtime/pick.ts";
import type { AppContext } from "./turn.ts";

export interface QueuePumpDeps extends Pick<AppContext, "turns" | "byThread" | "closing" | "catalog" | "runtime"> {
  readonly queue: Queue;
  readonly settings: AppContext["deps"]["settings"];
  /** chat.send, as a window sends it. */
  readonly send: (params: Params<"chat.send">) => ResultOf<"chat.send"> | Promise<ResultOf<"chat.send">>;
}

export interface QueuePump {
  /** Every chat.event the app pushes. */
  heard(payload: Payload<"chat.event">): void;
  /** Look at the queue once the current work settles: after a turn ends, the runtime or models change, or the queue does. */
  pump(): void;
}

export function createQueuePump({ queue, turns, byThread, closing, catalog, runtime, settings, send }: QueuePumpDeps): QueuePump {
  /** Turns whose start went out: a terminal event of one that never started is its refusal. */
  const startedTurns = new Set<string>();
  /** Every turn's events, from any window or the queue: the queue moves on what they say. */
  function heard({ turnId, threadId, event }: Payload<"chat.event">): void {
    if (event.type === "start") {
      startedTurns.add(turnId);
      queue.started(event.userMessage.id);
      return;
    }
    if (event.type !== "done" && event.type !== "error") return;
    if (!startedTurns.delete(turnId)) {
      if (event.type !== "error") return;
      const why = { code: event.code, message: event.message, ...(event.blocking === undefined ? {} : { blocking: event.blocking }), ...(event.offer === undefined ? {} : { offer: event.offer }) };
      // a send the person stopped before it started: Stop means stop, so what queued behind it holds too
      if (!queue.refused(turnId, why) && (event.ended?.reason === "stopped" || turns.get(turnId)?.stoppedAt !== undefined)) queue.ended(threadId, "stopped");
      return;
    }
    const turn = turns.get(turnId);
    // the person said stop: a Stop that lost the race to the last token holds the queue like any other
    if (event.type === "done") return queue.ended(threadId, turn?.stoppedAt !== undefined ? "stopped" : "done");
    const again = event.ended?.reason === "failed" && (turn?.clock.record(Date.now()).attempt ?? 1) > 1;
    queue.ended(threadId, again ? "failed-again" : "stopped");
  }
  let pumpAt: ReturnType<typeof setImmediate> | undefined;
  let pumping = false;
  /** Look at the queue once the current work settles: after a turn ends, the runtime or models change, or the queue does. */
  const pump = () => {
    if (pumpAt === undefined && !closing()) pumpAt = setImmediate(() => { pumpAt = undefined; void sendQueued(); });
  };
  /** The next queued message, through chat.send as a window would send it; one at a time. */
  async function sendQueued(): Promise<void> {
    if (closing() || pumping) return;
    const best = rankChatModels(catalog.current() ?? [])[0]?.name;
    const q = queue.next({ chat: runtime.status().state === "ready" && best !== undefined, anyTurn: turns.size > 0, busy: new Set(byThread.keys()) });
    if (q === undefined) return;
    pumping = true;
    try {
      const r = await send({
        threadId: q.threadId, content: q.text, messageId: q.messageId,
        model: q.model ?? (q.draw === undefined ? best ?? "" : ""),
        numCtx: q.numCtx ?? settings?.get().defaultNumCtx ?? 4096,
        ...(q.images?.length ? { images: q.images } : {}),
        ...(q.files?.length ? { files: q.files } : {}),
        ...(q.think === undefined ? {} : { think: q.think }),
        ...(q.draw === undefined ? {} : { draw: q.draw, ...(q.drawCount === undefined ? {} : { drawCount: q.drawCount }) }),
        // Send now: a person is waiting on it, so a reply in another chat is not stopped without a yes
        ...(q.now === true ? (q.stopOthers === true ? { stopOthers: true, ...(q.stopTurns === undefined ? {} : { stopTurns: q.stopTurns }) } : { askFirst: true }) : {}),
      });
      if ("replayed" in r) queue.started(q.messageId);
      else queue.sending(q.id, r.turnId);
    } catch (e) {
      // refused before any turn was taken (a reply already running there, a chat being deleted)
      const { code, message } = e as { code?: unknown; message?: unknown };
      const why: Why = { code: typeof code === "string" ? code : "internal", message: typeof message === "string" ? message : String(e) };
      queue.turnless(q.id, why);
    } finally {
      pumping = false;
      pump();
    }
  }
  return { heard, pump };
}
