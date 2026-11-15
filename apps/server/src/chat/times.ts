// A turn's reply record: what the reply is doing and its times, kept by the server
// as it sends the turn's events, pushed to every window at each change, and saved on the reply's
// row when it ends. Every window and every reload shows the same stage and seconds;
// no window keeps a clock of its own. The clock only times: which stage a reply is in is its
// record's to say (chat/reply.ts), and each call here is told the stage the record shows.
import type { ReplyRecord, ReplyStage, ReplyTimes, TurnEnded } from "@gates-local/contracts";

/** An event the turn sends before its end. */
export type TurnStep =
  | { readonly type: "thinking" | "delta"; readonly text: string }
  | { readonly type: "tool"; readonly step: { readonly callId: string; readonly state: string } };

export interface TurnClock {
  /** Its model is loading for it (a cold load, or a load it waits behind): the stage until it is ready. True when the record changed. */
  loading(): boolean;
  /** The model is in memory for this reply: called at the start of a turn whose model was resident or whose load it waited behind has finished. The stage is waiting (never still loading) until the runtime's first event. */
  ready(now: number): void;
  /**
   * `event` was sent at `now`; `thought` is the thinking sent before it; `stage` is what the reply's
   * record shows after it (chat/reply.ts decides that, never this clock). True when the record
   * changed. Nothing after a Stop counts.
   */
  see(event: TurnStep, now: number, thought: string, stage: ReplyStage): boolean;
  /** A Stop was taken at `now`: the times end there, whatever words were already on their way, and the stage is stopping until the end. */
  stop(now: number, thought: string): void;
  /** The attempt failed and runs again from `now`, at the `stage` its record shows: its rounds and first word start over; the work done so far stays counted. */
  retry(now: number, stage: ReplyStage): void;
  /** The record as of `now`, for a push, a replay or turns.active. */
  record(now: number): ReplyRecord;
  /** The times once the turn ended; `thought` is all the thinking it sent; `why` the error of a turn that did not finish. */
  end(ended: TurnEnded, thought: string, why?: ReplyTimes["why"]): ReplyTimes;
}

/** Stages whose time is the reply's work: the one clock, never the load and never the writing. */
const WORKING: ReadonlySet<ReplyStage> = new Set(["thinking", "tool"]);

/** A running total: its closed part plus the open part since `since`, as of `now`. */
const sum = (closed: number, since: number | undefined, now: number) => Math.round(closed + (since === undefined ? 0 : Math.max(0, now - since)));

/**
 * The model is ready at the start of a warm turn, else at its first token or call. A span of
 * thinking opens with its first words and closes when a call, the answer or the end comes.
 * The work clock runs while the model thinks (from ready, also while it reads a call's result)
 * and while a call runs. "Thought for" (thoughtMs, kept for rows before workMs) runs from ready
 * to the first answer word after thinking, or to the end of a reply that thought and never answered.
 */
export function turnClock(startedAt: number): TurnClock {
  let stage: ReplyStage = "waiting";
  let attempt = 1;
  let readyAt: number | undefined;
  let firstTokenAt: number | undefined;
  let thoughtMs: number | undefined;
  let ended: TurnEnded | undefined;
  let stoppedAt: number | undefined;
  let open: { readonly since: number; readonly from: number } | undefined;
  let spans: { from: number; ms: number }[] = [];
  let callsAt: Record<string, number> = {};
  let workMs = 0;
  let toolMs = 0;
  let workSince: number | undefined;
  let toolSince: number | undefined;
  const moveTo = (next: ReplyStage, now: number) => {
    if (next === stage) return;
    if (workSince !== undefined && !WORKING.has(next)) {
      workMs += Math.max(0, now - workSince);
      workSince = undefined;
    } else if (workSince === undefined && WORKING.has(next)) workSince = now;
    if (toolSince !== undefined && next !== "tool") {
      toolMs += Math.max(0, now - toolSince);
      toolSince = undefined;
    } else if (toolSince === undefined && next === "tool") toolSince = now;
    stage = next;
  };
  const close = (now: number) => {
    if (open === undefined) return;
    spans.push({ from: open.from, ms: Math.max(0, now - open.since) });
    open = undefined;
  };
  const thoughtUntil = (now: number) => Math.max(0, now - (readyAt ?? startedAt));
  /** The times stop at `now`: an open round closes, and a reply that thought and never answered thought until then. */
  const finish = (now: number, thought: string, as: "stopping" | "ended") => {
    close(now);
    if (thought !== "" && thoughtMs === undefined && firstTokenAt === undefined) thoughtMs = thoughtUntil(now);
    moveTo(as, now);
  };
  /** What a window draws: a change in any of these is pushed. */
  const shape = () => `${stage}|${attempt}|${readyAt}|${firstTokenAt}|${spans.length}|${Object.keys(callsAt).length}`;
  return {
    loading() {
      if (stage !== "waiting") return false;
      stage = "loading";
      return true;
    },
    ready(now) {
      // the "Thought for" time runs from here; the stage waits for the runtime's first event, since a
      // request it queues behind another reply (one slot) looks the same from here as one it started
      readyAt ??= now;
      // a load it waited behind has finished: the model is in memory, so the line no longer says loading
      if (stage === "loading") stage = "waiting";
    },
    stop(now, thought) {
      if (stoppedAt !== undefined || ended !== undefined) return;
      finish(now, thought, "stopping");
      stoppedAt = now;
    },
    retry(now, to) {
      if (stoppedAt !== undefined || ended !== undefined) return;
      attempt += 1;
      spans = [];
      callsAt = {};
      open = undefined;
      firstTokenAt = undefined;
      thoughtMs = undefined;
      moveTo(to, now);
    },
    see(event, now, thought, to) {
      if (stoppedAt !== undefined) return false;
      const before = shape();
      if (event.type === "tool") {
        readyAt ??= now;
        close(now);
        callsAt[event.step.callId] ??= thought.length;
        moveTo(to, now);
        return shape() !== before;
      }
      if (event.text === "") return false;
      readyAt ??= now;
      if (event.type === "thinking") open ??= { since: now, from: thought.length };
      else {
        close(now);
        firstTokenAt ??= now;
        if (thought !== "" && thoughtMs === undefined) thoughtMs = thoughtUntil(now);
      }
      moveTo(to, now);
      return shape() !== before;
    },
    record(now) {
      return {
        stage,
        startedAt,
        ...(readyAt === undefined ? {} : { readyAt }),
        ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
        workMs: sum(workMs, workSince, now),
        toolMs: sum(toolMs, toolSince, now),
        attempt,
        spans: [...spans],
        callsAt: { ...callsAt },
        ...(stoppedAt === undefined ? {} : { stoppedAt }),
        ...(ended === undefined ? {} : { ended }),
      };
    },
    end(how, thought, why) {
      // a stopped reply's times ended at its Stop: only the stage moves on
      if (stoppedAt === undefined) finish(how.at, thought, "ended");
      else moveTo("ended", how.at);
      ended = how;
      return {
        startedAt,
        ...(readyAt === undefined ? {} : { readyAt }),
        ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
        ...(thoughtMs === undefined ? {} : { thoughtMs }),
        spans: [...spans],
        callsAt: { ...callsAt },
        workMs: Math.round(workMs),
        ended: how,
        ...(why === undefined || how.reason === "done" || how.reason === "stopped" ? {} : { why }),
      };
    },
  };
}
