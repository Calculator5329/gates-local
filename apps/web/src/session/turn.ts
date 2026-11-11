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

/**
 * How long a reply thought, kept as its events arrive, so every screen that
 * shows it reads the same number and a remount rebuilds nothing. A span of
 * thinking opens with its first words and closes when a call, the answer or
 * the end arrives; it never closes before a time already shown, so the total
 * never goes down. A turn this client did not watch from its start has none.
 */
export interface WorkClock {
  /** Thinking since `since`; otherwise a call, the answer, or waiting. */
  readonly thinking: boolean;
  readonly since: number;
  /** Where the open span's words start in the thinking. */
  readonly from: number;
  /** Milliseconds in closed spans. */
  readonly total: number;
  /** Each closed span: where its words start in the thinking, and how long it ran. */
  readonly spans: readonly { readonly from: number; readonly ms: number }[];
  /** The thinking's length when each call first arrived: where it came in the thinking. */
  readonly at: Readonly<Record<string, number>>;
}

export const startClock = (now: number): WorkClock => ({ thinking: false, since: now, from: 0, total: 0, spans: [], at: {} });

/** The clock once the thinking stops at `now`. */
export function stopThinking(clock: WorkClock, now: number): WorkClock {
  if (!clock.thinking) return clock;
  const ms = Math.max(0, now - clock.since);
  return { ...clock, thinking: false, since: now, total: clock.total + ms, spans: [...clock.spans, { from: clock.from, ms }] };
}

/** Whole seconds of thinking at `now`, at least one. */
export const thoughtSecs = (clock: WorkClock, now: number): number =>
  Math.max(1, Math.round((clock.total + (clock.thinking ? Math.max(0, now - clock.since) : 0)) / 1000));

/** The turn with its thinking stopped at `now`: a call, the answer or the end came. */
export function leaveThinking(turn: LiveTurn, now: number): LiveTurn {
  return turn.clock?.thinking === true ? { ...turn, clock: stopThinking(turn.clock, now) } : turn;
}

function clockOn(turn: LiveTurn, event: TurnEvent, now: number): WorkClock | undefined {
  const c = turn.clock;
  if (c === undefined) return undefined;
  switch (event.type) {
    case "thinking":
      return c.thinking || event.text === "" ? c : { ...c, thinking: true, since: now, from: turn.thinking.length };
    case "tool":
      return { ...stopThinking(c, now), at: c.at[event.step.callId] === undefined ? { ...c.at, [event.step.callId]: turn.thinking.length } : c.at };
    case "delta":
      return event.text === "" ? c : stopThinking(c, now);
    case "stop":
    case "error":
    case "lost":
      return stopThinking(c, now);
    default:
      return c;
  }
}

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
  const advanced = advance(turn, event, now);
  if (advanced === null) return null;
  const clock = event.type === "start"
    // heard of at its start: watched from there; a start sent again to a client that connected
    // mid-reply, and words the start replaces, were not watched
    ? event.replayed === true ? undefined : turn.listed === true ? startClock(now) : turn.thinking !== "" || turn.text !== "" || turn.tools.length > 0 ? undefined : turn.clock
    // words after the end are dropped, and so is their time
    : turn.end !== undefined && (event.type === "thinking" || event.type === "delta") ? turn.clock : clockOn(turn, event, now);
  const next = clock === advanced.clock ? advanced : { ...advanced, clock };
  if (next.listed !== true || event.type === "running") return next;
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
        ...(event.image === true ? { image: true as const } : {}),
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
      // the person's Stop is why it ended, whatever the server calls it (a cancel during a model load comes back as an error)
      if (event.code !== "cancelled" && turn.end?.kind !== "stopped") return { ...ended, end: { kind: "error", code: event.code, message: event.message } };
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
