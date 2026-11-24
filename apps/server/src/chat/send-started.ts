import type { Message, Params } from "@gates-local/contracts";
import type { App } from "../app.ts";
import { AppError, type AppErrorCode } from "../app/errors.ts";
import type { StartParams } from "../app/turn.ts";

type Ctx = Parameters<App["handlers"]["reply.send"]>[1];
export type Sending = StartParams & { readonly id?: string; readonly image?: boolean };

let sends = 0;

export function replySend({ id = `send-${++sends}`, threadId, content, messageId, model, stopOthers, stopTurns, askFirst, image: _older, ...said }: Sending): Params<"reply.send"> {
  return {
    ...said, id, threadId, text: content, messageId: messageId ?? id,
    ...(model === "" ? {} : { model }),
    ...(stopOthers === true ? { consent: stopTurns === undefined ? { kind: "standing" } : { kind: "named", replies: stopTurns } } : askFirst === true ? { askFirst } : {}),
  } as Params<"reply.send">;
}

export async function sendTaken(app: Pick<App, "handlers" | "started">, params: Sending, ctx: Ctx = { clientId: 1 }): Promise<{ id: string; turnId: string; admission: Promise<Message>; ended: Promise<void>; replayed?: true }> {
  const send = replySend(params);
  const answer = await app.handlers["reply.send"](send, ctx);
  if (answer.answer === "gone") {
    if (answer.question !== undefined) return { id: send.id, turnId: `saved-${answer.question.id}`, admission: Promise.resolve(answer.question), ended: Promise.resolve(), replayed: true };
    if (answer.why === "chat-deleted") throw new AppError("thread-not-found", `thread ${params.threadId} is being deleted`);
    throw new Error(`the message is gone: ${answer.why}`);
  }
  const { reply } = answer;
  if (reply.stage === "held" && reply.held.why === "refused") {
    const { code, message, blocking, offer } = reply.held;
    throw Object.assign(new AppError(code as AppErrorCode, message, undefined, undefined, blocking), offer === undefined ? {} : { offer });
  }
  if (reply.stage === "queued" || reply.stage === "held" || reply.stage === "next" || reply.stage === "editing") {
    await app.handlers["reply.remove"]({ id: send.id }, ctx);
    const w = reply.stage === "queued" ? reply.waitFor : undefined;
    const behind = w?.what === "reply" || w?.what === "retry" ? `: ${w.reply}` : "";
    throw new AppError("turn-active", `thread ${params.threadId} already has a reply on its way${behind}`);
  }
  const started = app.started(send.id);
  if (started === undefined) throw new Error(`send ${send.id} ended before its start was read`);
  return { id: send.id, ...started };
}

export function endOf(app: Pick<App, "started">, id: string): Promise<void> {
  const started = app.started(id);
  if (started === undefined) throw new Error(`send ${id} has no running turn`);
  return started.ended;
}

export async function sendStarted(app: Pick<App, "handlers" | "started">, params: Sending, ctx: Ctx = { clientId: 1 }): Promise<{ id: string; turnId: string; userMessage: Message; ended: Promise<void>; replayed?: true }> {
  const { admission, ...taken } = await sendTaken(app, params, ctx);
  return { ...taken, userMessage: await admission };
}
