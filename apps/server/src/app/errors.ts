import type { BlockingTurn, FitOffer } from "@gates-local/contracts";
import type { Refusal } from "../chat/reply.ts";
import type { FitReport } from "../fit/types.ts";

// why: contracts lists only protocol codes, and clients switch on these strings
export type AppErrorCode =
  | "turn-active"
  | "runtime-not-ready"
  | "wont-fit"
  | "cancelled"
  | "runtime-changed"
  | "preempted"
  | "would-stop"
  | "thread-not-found"
  | "message-not-found"
  | "image-input"
  | "shutting-down";

export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: AppErrorCode;
  readonly report?: FitReport;
  readonly neededBy?: string;
  readonly blocking?: readonly BlockingTurn[];
  offer?: FitOffer;
  constructor(code: AppErrorCode, message: string, report?: FitReport, neededBy?: string, blocking?: readonly BlockingTurn[]) {
    super(message);
    this.code = code;
    if (report !== undefined) this.report = report;
    if (neededBy !== undefined) this.neededBy = neededBy;
    if (blocking !== undefined) this.blocking = blocking;
  }
}

export const attachError = (e: unknown): never => { throw new AppError("image-input", e instanceof Error ? e.message : "An attached file is no longer available. Attach it again; your words are kept."); };

export const imageError = (error: unknown): never => { throw new AppError("image-input", error instanceof Error ? error.message : "An attached image is no longer available. Paste it again; your words are kept."); };

export const RUNTIME_CHANGED_TURN_MESSAGE = "The Ollama runtime changed while this reply was running, so it stopped. Send the message again.";
export const runtimeChangedTurn = (): AppError => new AppError("runtime-changed", RUNTIME_CHANGED_TURN_MESSAGE);

export const preemptedBy = (model: string, numCtx: number, held: string): AppError =>
  new AppError("preempted", `${model} at num_ctx ${numCtx} needed the GPU memory ${held} was using, so this reply stopped. Send the message again.`, undefined, model);
export const threadGoing = (threadId: string) => new AppError("thread-not-found", `thread ${threadId} is being deleted`);
export const cancelledBeforeStart = () => new AppError("cancelled", "the turn was cancelled before it started");

export function refusalOf(e: unknown): Refusal {
  const { code, message, blocking, offer } = typeof e === "object" && e !== null ? (e as { code?: unknown; message?: unknown; blocking?: readonly BlockingTurn[]; offer?: FitOffer }) : {};
  return {
    code: typeof code === "string" && code !== "" ? code : "internal",
    message: typeof message === "string" ? message : String(e),
    ...(blocking === undefined ? {} : { blocking }),
    ...(offer === undefined ? {} : { offer }),
  };
}
