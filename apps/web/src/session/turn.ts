// One reply and everything that can happen to it while it runs. The same
// function applies a turn's events whether its chat is open or not; chat.ts
// runs the side effects (saved rows, notes, the queue) after it. The two ends
// that save a row, done and an error with a partial, are applied in chat.ts
// with that row in one store update; reduceTurn gives null for them too.
import type { Payload, ToolStep } from "@gates-local/contracts";
import type { LiveTurn, State } from "../store.ts";

export type ChatEvent = Payload<"chat.event">["event"];

/** The server's events for a turn, and this client's own. */
export type TurnEvent =
  | ChatEvent
  /** chat.send answered: the turn has its id and its saved question. */
  | { readonly type: "sent"; readonly turnId: string; readonly userMessageId: string }
  /** The person pressed Stop; the server's end is still to come. */
  | { readonly type: "stop" }
  /** chat.send was refused after the turn had ended here: it stays as it ended, without the question it was waiting to save. */
  | { readonly type: "refused" }
  /** The connection dropped: a reply still being written stops here, and a stopped one stops waiting for the server. */
  | { readonly type: "lost" }
  /** turns.active after a reconnect: the server is still writing this reply. */
  | { readonly type: "running" }
  /** While chat.send has not answered: the server started (or ended) a turn in this chat; its events wait for the answer. */
  | { readonly type: "early"; readonly turnId: string; readonly ended: boolean };

const CLOSED = { kind: "error", code: "closed", message: "The connection dropped while this reply was being written." } as const;

/** Cut off by a dropped connection; the server may still be writing it. */
const closed = (turn: LiveTurn) => turn.end?.kind === "error" && turn.end.code === "closed";

const secsSince =(turn: LiveTurn, now: number) => Math.round((now - turn.startedAt) / 1000);

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
  if (next?.listed !== true || event.type === "running") return next;
  // its own first event makes a turn known only from turns.active a turn like any
  // other; its start also starts its clock, as for a turn first heard of at its start
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
        ...(turn.end === undefined || closed(turn) ? { end: undefined, text: "", thinking: "", tools: [] } : {}),
      };
    case "thinking":
      return turn.end !== undefined || event.text === "" ? turn : { ...turn, thinking: turn.thinking + event.text };
    case "delta": {
      const noticed = event.contextNotice ? { ...turn, contextNotice: event.contextNotice } : turn;
      if (turn.end !== undefined || event.text === "") return noticed;
      return {
        ...noticed,
        text: turn.text + event.text,
        ...(turn.firstTokenAt === undefined ? { firstTokenAt: now } : {}),
        // Thought for: until the first word after thinking, measured when that word arrives
        ...(turn.thinking !== "" && turn.thinkingSecs === undefined ? { thinkingSecs: Math.max(1, secsSince(turn, now)) } : {}),
      };
    }
    case "tool":
      return { ...turn, tools: upsertStep(turn.tools, event.step) };
    case "done":
      return null;
    case "error": {
      if (event.partial !== undefined) return null;
      const ended = { ...turn, ending: undefined, ...(event.contextNotice ? { contextNotice: event.contextNotice } : {}) };
      if (event.code !== "cancelled") return { ...ended, end: { kind: "error", code: event.code, message: event.message } };
      return { ...ended, end: turn.end ?? { kind: "stopped", secs: secsSince(turn, now) } };
    }
    case "sent":
      return { ...turn, turnId: event.turnId, userMessageId: event.userMessageId, pendingUser: null, early: undefined };
    case "stop":
      return turn.end !== undefined ? turn : { ...turn, end: { kind: "stopped", secs: secsSince(turn, now) }, ending: true };
    case "refused":
      return { ...turn, pendingUser: null, ending: undefined, early: undefined };
    case "early":
      // an end of some other turn than the one seen starting says nothing about this chat
      if (event.ended && turn.early?.turnId !== event.turnId) return turn;
      return { ...turn, early: { turnId: event.turnId, ended: event.ended } };
    case "lost":
      if (turn.end === undefined) return { ...turn, end: CLOSED };
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
