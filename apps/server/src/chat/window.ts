// What a model can be sent. A small context window (some models take about
// 2,000 tokens) cannot hold a long chat, so the oldest turns go first; a new
// message that alone will not fit gets a plain sentence instead of a request
// Ollama would cut without saying so. Tokens are estimated: Ollama counts
// them only after the request, and four characters a token is close enough
// to leave the model room to answer.
import { observationBody, type ModelMessage } from "../../../../packages/harness/src/index.ts";
import type { TurnMessage } from "./types.ts";

const MESSAGE_FRAMING_TOKENS = 4;
/** Room kept for the reply: a quarter of the window, at most this many tokens. */
const REPLY_ROOM_MAX_TOKENS = 2048;
const replyRoom = (numCtx: number) => Math.min(Math.ceil(numCtx / 4), REPLY_ROOM_MAX_TOKENS);
/** A tool result is not cut below this many characters: less tells the model nothing. */
const MIN_OBSERVATION_CHARS = 200;
const WINDOW_FULL = "\n[cut: this model's context window is full]";

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
  const budget = numCtx - replyRoom(numCtx) - overhead;
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

const messageTokens = (m: ModelMessage) => estimateTokens(m.content) + (m.tool_calls ? Math.ceil(JSON.stringify(m.tool_calls).length / 4) : 0);
const tokensOf = (messages: readonly ModelMessage[]) => messages.reduce((sum, m) => sum + messageTokens(m), 0);

/**
 * One request of a tool turn, inside `numCtx`: `history` as it stands when it fits. Otherwise
 * the oldest turns before this one go, then tool results are cut, oldest first, down to a
 * floor. Undefined when even that does not fit. `turnStart` is where the messages the loop
 * added begin; the message before it, what was asked, always stays. `overhead` is the tokens
 * spent outside `history` (tool definitions).
 */
export function fitRound(history: readonly ModelMessage[], turnStart: number, numCtx: number, overhead = 0): readonly ModelMessage[] | undefined {
  const budget = numCtx - replyRoom(numCtx) - overhead;
  if (tokensOf(history) <= budget) return history;
  const before = history.slice(0, turnStart);
  const system = before.filter((m) => m.role === "system");
  const talk = before.filter((m) => m.role !== "system");
  const older = talk.slice(0, -1);
  const asked = talk.slice(-1);
  const turn = history.slice(turnStart);
  let used = tokensOf(system) + tokensOf(talk) + tokensOf(turn);
  let first = 0;
  while (first < older.length && used > budget) used -= messageTokens(older[first++]!);
  // A chat the model sees starts with what was asked, never with a reply to something it cannot see.
  while (first < older.length && older[first]!.role === "assistant") used -= messageTokens(older[first++]!);
  for (const [index, message] of turn.entries()) {
    if (used <= budget) break;
    const observation = observationBody(message);
    if (!observation) continue;
    const keep = Math.max(MIN_OBSERVATION_CHARS, observation.body.length - (used - budget) * 4 - WINDOW_FULL.length);
    if (keep + WINDOW_FULL.length >= observation.body.length) continue;
    const cut = observation.withBody(observation.body.slice(0, keep) + WINDOW_FULL);
    used += messageTokens(cut) - messageTokens(message);
    turn[index] = cut;
  }
  return used <= budget ? [...system, ...older.slice(first), ...asked, ...turn] : undefined;
}
