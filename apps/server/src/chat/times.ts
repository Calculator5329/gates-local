// A turn's reply record (decision 33): what the reply is doing and its times, kept by the server
// as it sends the turn's events, pushed to every window at each change, and saved on the reply's
// row when it ends (chat row 32). Every window and every reload shows the same stage and seconds;
// no window keeps a clock of its own.
import type { ReplyRecord, ReplyStage, ReplyTimes, TurnEnded } from "@gates-local/contracts";

/** An event the turn sends before its end. */
export type TurnStep =
  | { readonly type: "thinking" | "delta"; readonly text: string }
  | { readonly type: "tool"; readonly step: { readonly callId: string; readonly state: string } };

export interface TurnClock {
  /** Its model is loading for it (a cold load, or a load it waits behind): the stage until it is ready. True when the record changed. */
  loading(): boolean;
  /** The model is in memory for this reply: called at the start of a turn whose model was resident. The stage stays waiting until the runtime's first event. */
  ready(now: number): void;
  /** `event` was sent at `now`; `thought` is the thinking sent before it. True when the record changed. Nothing after a Stop counts. */
  see(event: TurnStep, now: number, thought: string): boolean;
  /** The person pressed Stop at `now`: the times end there, whatever words were already on their way. */
  stop(now: number, thought: string): void;
  /** The attempt failed and runs again from `now`: its rounds and first word start over; the work done so far stays counted. */
  retry(now: number): void;
  /** The record as of `now`, for a push, a replay or turns.active. */
  record(now: number): ReplyRecord;
  /** The times once the turn ended; `thought` is all the thinking it sent; `why` the error of a turn that did not finish. */
  end(ended: TurnEnded, thought: string, why?: ReplyTimes["why"]): ReplyTimes;
}

/** Stages whose time is the reply's work: the one clock (decision 2), never the load and never the writing. */
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
  let stopped = false;
  let open: { readonly since: number; readonly from: number } | undefined;
  let spans: { from: number; ms: number }[] = [];
  let callsAt: Record<string, number> = {};
  const running = new Set<string>();
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
  const readyNow = (now: number) => {
    readyAt ??= now;
    if (stage === "waiting" || stage === "loading") moveTo("thinking", now);
  };
  const thoughtUntil = (now: number) => Math.max(0, now - (readyAt ?? startedAt));
  /** The times stop at `now`: an open round closes, and a reply that thought and never answered thought until then. */
  const finish = (now: number, thought: string) => {
    close(now);
    if (thought !== "" && thoughtMs === undefined && firstTokenAt === undefined) thoughtMs = thoughtUntil(now);
    moveTo("ended", now);
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
    },
    stop(now, thought) {
      if (stopped) return;
      finish(now, thought);
      stopped = true;
    },
    retry(now) {
      if (stopped || ended !== undefined) return;
      attempt += 1;
      spans = [];
      callsAt = {};
      open = undefined;
      firstTokenAt = undefined;
      thoughtMs = undefined;
      running.clear();
      // a model that was ready works on the reply again at once; one still loading keeps loading
      moveTo(readyAt === undefined ? stage : "thinking", now);
    },
    see(event, now, thought) {
      if (stopped) return false;
      const before = shape();
      if (event.type === "tool") {
        readyNow(now);
        close(now);
        callsAt[event.step.callId] ??= thought.length;
        if (event.step.state === "running") running.add(event.step.callId);
        else running.delete(event.step.callId);
        // after a call the model reads its result: that is thinking until its next word
        moveTo(running.size > 0 ? "tool" : "thinking", now);
        return shape() !== before;
      }
      if (event.text === "") return false;
      readyNow(now);
      if (event.type === "thinking") {
        open ??= { since: now, from: thought.length };
        if (running.size === 0) moveTo("thinking", now);
        return shape() !== before;
      }
      close(now);
      firstTokenAt ??= now;
      if (thought !== "" && thoughtMs === undefined) thoughtMs = thoughtUntil(now);
      if (running.size === 0) moveTo("writing", now);
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
        ...(ended === undefined ? {} : { ended }),
      };
    },
    end(how, thought, why) {
      if (!stopped) finish(how.at, thought);
      ended = how;
      return {
        startedAt,
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
