import type { ReplyTimes, TurnEnded } from "@gates-local/contracts";

export type ReplyStage = "waiting" | "loading" | "thinking" | "tool" | "writing" | "stopping" | "ended";

export interface ReplyRecord {
  readonly stage: ReplyStage;
  readonly startedAt: number;
  readonly readyAt?: number;
  readonly firstTokenAt?: number;
  readonly workMs: number;
  readonly toolMs: number;
  readonly attempt: number;
  readonly spans: readonly { readonly from: number; readonly ms: number }[];
  readonly callsAt: Readonly<Record<string, number>>;
  readonly stoppedAt?: number;
  readonly ended?: TurnEnded;
}

export type TurnStep =
  | { readonly type: "thinking" | "delta"; readonly text: string }
  | { readonly type: "tool"; readonly step: { readonly callId: string; readonly state: string } };

export interface TurnClock {
  loading(): boolean;
  ready(now: number): void;
  see(event: TurnStep, now: number, thought: string, stage: ReplyStage): boolean;
  stop(now: number, thought: string): void;
  retry(now: number, stage: ReplyStage): void;
  record(now: number): ReplyRecord;
  end(ended: TurnEnded, thought: string, why?: ReplyTimes["why"]): ReplyTimes;
}

const WORKING: ReadonlySet<ReplyStage> = new Set(["thinking", "tool"]);

const sum = (closed: number, since: number | undefined, now: number) => Math.round(closed + (since === undefined ? 0 : Math.max(0, now - since)));

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
  const finish = (now: number, thought: string, as: "stopping" | "ended") => {
    close(now);
    if (thought !== "" && thoughtMs === undefined && firstTokenAt === undefined) thoughtMs = thoughtUntil(now);
    moveTo(as, now);
  };
  const shape = () => `${stage}|${attempt}|${readyAt}|${firstTokenAt}|${spans.length}|${Object.keys(callsAt).length}`;
  return {
    loading() {
      if (stage !== "waiting") return false;
      stage = "loading";
      return true;
    },
    ready(now) {
      // external: with one slot, Ollama queues a request behind another reply, and it looks started
      readyAt ??= now;
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
