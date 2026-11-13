// For tests and the crash server: chat.send, then the turn's start (chat row 32). chat.send
// answers with the turn id once the turn is taken; the saved question comes with its start, and a
// refusal from then on is the turn's error event. In process, App.admission gives both.
import type { Message, Params } from "@gates-local/contracts";
import type { App } from "../app.ts";

type Ctx = Parameters<App["handlers"]["chat.send"]>[1];

/** The turn id and its saved question once the turn starts; a refusal, before or after the answer, rejects. */
export async function sendStarted(app: Pick<App, "handlers" | "admission">, params: Params<"chat.send">, ctx: Ctx = { clientId: 1 }): Promise<{ turnId: string; userMessage: Message; replayed?: boolean }> {
  const answer = await app.handlers["chat.send"](params, ctx);
  // a messageId already saved: nothing runs, and the answer is that question
  if (answer.userMessage !== undefined) return { ...answer, userMessage: answer.userMessage };
  const admission = app.admission(answer.turnId);
  if (admission === undefined) throw new Error(`turn ${answer.turnId} ended before its admission was read`);
  return { turnId: answer.turnId, userMessage: await admission };
}
