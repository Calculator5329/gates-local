import type { Message, ToolStep, TurnEnded } from "@gates-local/contracts";
import type { LiveTurn, State, TurnClock } from "../lib/store/store.ts";

export interface TurnFailure {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly ended?: TurnEnded;
  readonly partial?: Message;
  readonly question?: Message;
  readonly neededBy?: string;
}
export type TurnEvent =
  | { readonly type: "delta" | "thinking"; readonly text: string }
  | { readonly type: "tool"; readonly step: ToolStep }
  | { readonly type: "reply"; readonly reply: TurnClock }
  | TurnFailure;

const stoppedSecs = (reply: TurnClock | undefined, at: number | undefined): number =>
  reply === undefined ? 0 : Math.max(0, Math.round(((reply.stoppedAt ?? at ?? reply.startedAt) - reply.startedAt) / 1000));

export const stopping = (turn: Pick<LiveTurn, "reply"> | undefined): boolean =>
  turn?.reply?.stage === "stopping" || (drawsPicture(turn) && turn?.reply?.stoppedAt !== undefined);

export const drawsPicture = (turn: Pick<LiveTurn, "reply"> | undefined): boolean => turn?.reply?.stage === "drawing";

export function workMsAt(turn: Pick<LiveTurn, "reply" | "replyAt" | "end">, now: number): number | undefined {
  const r = turn.reply;
  if (r === undefined) return undefined;
  const growing = turn.end === undefined && (r.stage === "thinking" || r.stage === "tool");
  return r.workMs + (growing ? Math.max(0, now - (turn.replyAt ?? now)) : 0);
}

export const endReason = (event: TurnFailure): TurnEnded["reason"] => event.ended?.reason ?? "failed";

function upsertStep(steps: readonly ToolStep[], step: ToolStep): ToolStep[] {
  const i = steps.findIndex((x) => x.callId === step.callId);
  // why: a step only moves forward; a running part that arrives late never takes back its result
  if (i >= 0 && steps[i]?.state !== "running" && step.state === "running") return [...steps];
  return i < 0 ? [...steps, step] : steps.map((x, j) => (j === i ? step : x));
}

export function reduceTurn(turn: LiveTurn, event: TurnEvent, now: number): LiveTurn | null {
  switch (event.type) {
    case "reply": {
      if (turn.end?.kind === "error") return turn;
      const again = turn.reply !== undefined && event.reply.attempt > turn.reply.attempt;
      const next = { ...turn, reply: event.reply, replyAt: now, ...(again ? { text: "", thinking: "", tools: [] } : {}) };
      return event.reply.stoppedAt === undefined ? next : { ...next, end: { kind: "stopped", secs: stoppedSecs(event.reply, undefined) } };
    }
    case "thinking":
      return turn.end !== undefined || event.text === "" ? turn : { ...turn, thinking: turn.thinking + event.text };
    case "delta":
      return turn.end !== undefined || event.text === "" ? turn : { ...turn, text: turn.text + event.text };
    case "tool":
      return { ...turn, tools: upsertStep(turn.tools, event.step) };
    case "error": {
      if (event.partial !== undefined) return null;
      const reply: TurnClock | undefined = turn.reply === undefined ? undefined
        : { ...turn.reply, stage: drawsPicture(turn) ? "drawing" : "ended", workMs: event.question?.times?.workMs ?? turn.reply.workMs, ...(event.ended === undefined ? {} : { ended: event.ended }) };
      const ended = { ...turn, ...(reply === undefined ? {} : { reply, replyAt: now }) };
      if (endReason(event) !== "stopped") return { ...ended, end: { kind: "error", code: event.code, message: event.message } };
      return { ...ended, end: turn.end?.kind === "stopped" ? turn.end : { kind: "stopped", secs: stoppedSecs(turn.reply, event.ended?.at) } };
    }
  }
}

export function withTurn(turns: State["turns"], threadId: string, turn: LiveTurn | null): State["turns"] {
  if (turn !== null) return { ...turns, [threadId]: turn };
  if (turns[threadId] === undefined) return turns;
  const { [threadId]: _gone, ...rest } = turns;
  return rest;
}

export function unfinished(turn: LiveTurn | undefined): boolean {
  return turn !== undefined && (turn.end === undefined || stopping(turn));
}
