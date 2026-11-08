// What a model can be sent. A small context window (some models take about
// 2,000 tokens) cannot hold a long chat, so the oldest turns go first; a new
// message that alone will not fit gets a plain sentence instead of a request
// Ollama would cut without saying so. Tokens are estimated: Ollama counts
// them only after the request, and four characters a token is close enough
// to leave the model room to answer.
import type { TurnMessage } from "./types.ts";

const MESSAGE_FRAMING_TOKENS = 4;
/** Room kept for the reply: a quarter of the window, at most this many tokens. */
const REPLY_ROOM_MAX_TOKENS = 2048;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4) + MESSAGE_FRAMING_TOKENS;

/** 2048 → "2k", 512 → "512". */
export const contextWords = (numCtx: number): string => (numCtx < 1024 ? String(numCtx) : `${Math.round(numCtx / 1024)}k`);

export type Windowed = { ok: true; messages: TurnMessage[] } | { ok: false; message: string };

/**
 * The newest messages that fit in `numCtx`, system messages always kept.
 * `overhead` is the tokens the turn spends outside `messages` (tool
 * definitions, a system block added later).
 */
export function fitToWindow(messages: readonly TurnMessage[], numCtx: number, overhead = 0): Windowed {
  const budget = numCtx - Math.min(Math.ceil(numCtx / 4), REPLY_ROOM_MAX_TOKENS) - overhead;
  const system = messages.filter((m) => m.role === "system");
  const talk = messages.filter((m) => m.role !== "system");
  let used = system.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const last = talk.at(-1);
  if (last !== undefined && used + estimateTokens(last.content) > budget) {
    return { ok: false, message: `This message is too long for this model, which keeps about ${contextWords(numCtx)} tokens in view. Shorten it or pick a model with more context.` };
  }
  let first = talk.length;
  while (first > 0) {
    const cost = estimateTokens(talk[first - 1]?.content ?? "");
    if (used + cost > budget) break;
    used += cost;
    first -= 1;
  }
  // A chat the model sees starts with what was asked, never with a reply to something it cannot see.
  while (first < talk.length - 1 && talk[first]?.role === "assistant") first += 1;
  return { ok: true, messages: [...system, ...talk.slice(first)] };
}
