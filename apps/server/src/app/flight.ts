// A turn as one reply record (what a call on that reply is answered with), and the Stop itself.
import type { InFlight, RepliesDeps } from "../chat/replies.ts";
import type { Turn } from "./turn.ts";

/** None for a turn that has ended, or whose question is not saved yet. */
export function inFlight(turn: Turn | undefined, now: number): InFlight | undefined {
  if (turn === undefined || turn.terminal || turn.start === undefined) return undefined;
  const r = turn.clock.record(now);
  if (r.stage === "ended") return undefined;
  const questionId = turn.start.userMessage.id;
  const { threadId } = turn;
  // an Image turn runs no chat model: its pictures are the image module's jobs, which it lists itself
  if (turn.start.image === true) return (id, rev) => ({ id, threadId, rev, stage: "drawing", questionId, startedAt: r.startedAt, jobs: [] });
  const clock = {
    questionId, model: turn.model, startedAt: r.startedAt, workMs: r.workMs, toolMs: r.toolMs, try: r.attempt, spans: r.spans, callsAt: r.callsAt,
    ...(r.readyAt === undefined ? {} : { readyAt: r.readyAt }),
    ...(r.firstTokenAt === undefined ? {} : { firstTokenAt: r.firstTokenAt }),
  };
  if (r.stage === "stopping" || r.stoppedAt !== undefined) return (id, rev) => ({ id, threadId, rev, ...clock, stage: "stopping", stoppedAt: r.stoppedAt ?? now });
  // its question is saved and no word has come: its model is loading, or ready and about to answer
  const stage = r.stage === "waiting" ? (r.readyAt === undefined ? "loading" : "thinking") : r.stage;
  return (id, rev) => ({ id, threadId, rev, ...clock, stage });
}

/**
 * A turn stopped before its question was saved, as the words it was sent with, on hold. For a
 * send that came from no waiting message: the server keeps no row for it, the window that sent it
 * does. None once the question is saved or the turn has ended.
 */
export function stoppedStart(turn: Turn | undefined): InFlight | undefined {
  if (turn === undefined || turn.terminal || turn.start !== undefined || turn.asked === undefined || turn.stoppedAt === undefined) return undefined;
  const { content, messageId, images, files, numCtx, think } = turn.asked;
  const { threadId, turnId, model } = turn;
  const at = turn.clock.record(turn.stoppedAt).startedAt;
  return (id, rev) => ({
    id, threadId, rev, messageId: messageId ?? turnId, text: content, at,
    ...(images?.length ? { images } : {}),
    ...(files?.length ? { files } : {}),
    ...(model === "" ? {} : { model }),
    ...(numCtx === undefined ? {} : { numCtx }),
    ...(think === undefined ? {} : { think }),
    stage: "held", held: { why: "stopped" },
  });
}

/**
 * The person's Stop for a turn still held, started or not: its clock stands at the Stop, every
 * window hears so, and its work is cut. Asked again, of a turn already ending, or of one whose
 * last event is out, it changes nothing. Its chat, or none when the turn has left.
 */
export function stopTurn(turn: Turn | undefined, pushReply: (turn: Turn) => void): string | undefined {
  if (turn === undefined) return undefined;
  if (!turn.terminal && !turn.controller.signal.aborted) {
    turn.stoppedAt = Date.now();
    // words already on their way when the Stop landed change no time on the row
    turn.clock.stop(turn.stoppedAt, turn.thinking);
    // every window draws the Stop from this record, started or not: none keeps a clock of its own
    pushReply(turn);
    turn.controller.abort();
  }
  return turn.threadId;
}

/** What the replies (chat/replies.ts) read of the turns in flight, and the Stop they ask for. */
export function turnReads(turns: ReadonlyMap<string, Turn>, byThread: ReadonlyMap<string, Turn>, pushReply: (turn: Turn) => void): Pick<RepliesDeps, "flight" | "inChat" | "stop" | "unsaved"> {
  return {
    flight: (turnId) => inFlight(turns.get(turnId), Date.now()),
    inChat: (threadId) => byThread.get(threadId)?.turnId,
    stop: (turnId) => stopTurn(turns.get(turnId), pushReply),
    unsaved: (turnId) => stoppedStart(turns.get(turnId)),
  };
}
