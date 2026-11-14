// One reply and everything that can happen to it while it runs. The same
// function applies a turn's events whether its chat is open or not; chat.ts
// runs the side effects (saved rows, notes, the queue) after it. The two ends
// that save a row, done and an error with a partial, are applied in chat.ts
// with that row in one store update; reduceTurn gives null for them too.
//
// What the reply is doing and its seconds are the server's reply record
// (decision 33): this client keeps no clock of its own and guesses no stage.
import type { Payload, ToolStep, TurnEnded } from "@gates-local/contracts";
import type { LiveTurn, State } from "../store.ts";

export type ChatEvent = Payload<"chat.event">["event"];

/** The server's events for a turn, and this client's own. */
export type TurnEvent =
  | ChatEvent
  /** chat.send answered: the turn has its id; its start brings the saved question. */
  | { readonly type: "sent"; readonly turnId: string }
  /** The person pressed Stop; the server's end is still to come. */
  | { readonly type: "stop" }
  /** chat.send was refused after the turn had ended here: it stays as it ended, without the question it was waiting to save. */
  | { readonly type: "refused" }
  /** The connection dropped: a reply still being written stops here, and a stopped one stops waiting for the server. */
  | { readonly type: "lost" }
  /** turns.active after a reconnect: the server is still writing this reply. */
  | { readonly type: "running" };

const CLOSED = { kind: "error", code: "closed", message: "The connection dropped while this reply was being written." } as const;

/** Cut off by a dropped connection; the server may still be writing it. */
const closed = (turn: LiveTurn) => turn.end?.kind === "error" && turn.end.code === "closed";

const secsSince = (turn: LiveTurn, now: number) => Math.round((now - turn.startedAt) / 1000);

/**
 * The reply's work at `now`, in milliseconds (decision 2): thinking plus tool time, never the
 * load and never the writing. The record's own figure, grown on this client's clock from when the
 * record arrived, only while it thinks or runs a call and has not ended here. Undefined before
 * the first record.
 */
export function workMsAt(turn: Pick<LiveTurn, "reply" | "replyAt" | "end">, now: number): number | undefined {
  const r = turn.reply;
  if (r === undefined) return undefined;
  const growing = turn.end === undefined && (r.stage === "thinking" || r.stage === "tool");
  return r.workMs + (growing ? Math.max(0, now - (turn.replyAt ?? now)) : 0);
}

/** The record held still at `now`: the turn ended here (Stop, a failure, a dropped connection) before the server said so. */
function frozen(turn: LiveTurn, now: number): Pick<LiveTurn, "reply" | "replyAt"> {
  const work = workMsAt(turn, now);
  return turn.reply === undefined || work === undefined ? {} : { reply: { ...turn.reply, stage: "ended", workMs: Math.round(work) }, replyAt: now };
}

type TurnEnd = Extract<ChatEvent, { type: "done" | "error" }>;

/** How the server says the turn ended (chat row 32); an end without the word, from an older server, counts as a failure, which is said. */
export const endReason = (event: TurnEnd): TurnEnded["reason"] => event.ended?.reason ?? (event.type === "done" ? "done" : "failed");

function upsertStep(steps: readonly ToolStep[], step: ToolStep): ToolStep[] {
  const i = steps.findIndex((x) => x.callId === step.callId);
  return i < 0 ? [...steps, step] : steps.map((x, j) => (j === i ? step : x));
}

/**
 * The turn after `event` at time `now`; null when the turn is over and its
 * saved row takes its place. Words that come after the turn ended here are
 * dropped (W-05); a tool step still lands.
 */
export function reduceTurn(turn: LiveTurn, event: TurnEvent, now: number): LiveTurn | null {
  const next = advance(turn, event, now);
  // a record alone does not make a listed turn one that shows: its start does
  if (next === null || next.listed !== true || event.type === "running" || event.type === "reply") return next;
  // its own first event makes a turn known only from turns.active a turn like any other
  return { ...next, listed: undefined, ...(event.type === "start" ? { startedAt: now } : {}) };
}

function advance(turn: LiveTurn, event: TurnEvent, now: number): LiveTurn | null {
  switch (event.type) {
    case "start":
      // a reply the connection cut off comes back with the server's snapshot of its words,
      // also when turns.active already showed it running again
      return {
        ...turn,
        model: event.model,
        userMessageId: turn.userMessageId ?? event.userMessage.id,
        // the saved question takes the place of the words shown while it waited
        pendingUser: null,
        ...(event.image === true ? { image: true as const } : {}),
        ...(turn.end === undefined || closed(turn) ? { end: undefined, text: "", thinking: "", tools: [] } : {}),
      };
    case "reply": {
      // a reply that ended here keeps the time it ended with; one the connection cut off takes the server's again
      if (turn.end !== undefined && !closed(turn)) return turn;
      // the server runs a failed reply once more (decision 7): the second attempt starts over in the same place
      const again = turn.reply !== undefined && event.reply.attempt > turn.reply.attempt;
      return { ...turn, reply: event.reply, replyAt: now, ...(again ? { text: "", thinking: "", tools: [] } : {}) };
    }
    case "thinking":
      return turn.end !== undefined || event.text === "" ? turn : { ...turn, thinking: turn.thinking + event.text };
    case "delta":
      return turn.end !== undefined || event.text === "" ? turn : { ...turn, text: turn.text + event.text };
    case "tool":
      return { ...turn, tools: upsertStep(turn.tools, event.step) };
    case "done":
      return null;
    case "error": {
      if (event.partial !== undefined) return null;
      // held at this client's time: the record's arrival was on this clock, the server's `at` is not
      const ended = { ...turn, ending: undefined, ...(turn.end === undefined ? frozen(turn, now) : {}) };
      // the server says why it ended: a Stop keeps the time this client's Stop showed, or is the time the server
      // took it; a halt or a failure is said, also when it beat this client's Stop to the server
      if (endReason(event) !== "stopped") return { ...ended, end: { kind: "error", code: event.code, message: event.message } };
      if (turn.end?.kind === "stopped") return { ...ended, end: turn.end };
      return { ...ended, end: { kind: "stopped", secs: secsSince(turn, event.ended?.at ?? now) } };
    }
    case "sent":
      return { ...turn, turnId: event.turnId };
    case "stop":
      if (turn.end !== undefined) return turn;
      return { ...turn, end: { kind: "stopped", secs: secsSince(turn, now) }, ending: true, ...frozen(turn, now) };
    case "refused":
      return { ...turn, pendingUser: null, ending: undefined };
    case "lost":
      if (turn.end === undefined) return { ...turn, end: CLOSED, ...frozen(turn, now) };
      return turn.ending === true ? { ...turn, ending: undefined } : turn;
    case "running":
      return closed(turn) ? { ...turn, end: undefined } : turn;
  }
}

/** The map with this thread's turn replaced, or removed when null. */
export function withTurn(turns: State["turns"], threadId: string, turn: LiveTurn | null): State["turns"] {
  if (turn !== null) return { ...turns, [threadId]: turn };
  if (turns[threadId] === undefined) return turns;
  const { [threadId]: _gone, ...rest } = turns;
  return rest;
}

/** A reply still being written, or stopped here and not yet ended on the server; one known only from turns.active may never start, so it is neither. */
export function unfinished(turn: LiveTurn | undefined): boolean {
  return turn !== undefined && turn.listed !== true && (turn.end === undefined || turn.ending === true);
}
