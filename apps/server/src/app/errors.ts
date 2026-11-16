// The errors the app's handlers throw, and the ones a turn ends with.
import type { BlockingTurn, FitOffer } from "@gates-local/contracts";
import type { Refusal } from "../chat/reply.ts";
import type { FitReport } from "../fit/types.ts";

/**
 * Codes the handlers here throw. packages/contracts lists only the
 * protocol's own codes (WireErrorCode, "Handlers may add their own codes");
 * clients switch on these strings.
 */
export type AppErrorCode =
  | "turn-active" // the thread already has a turn streaming
  | "runtime-not-ready" // no ready Ollama to talk to
  | "wont-fit" // the fit check refused this model at this num_ctx; the message names the numbers
  | "cancelled" // the turn was cancelled (or its thread deleted) before it started
  | "runtime-changed" // a runtime switch ended the turn (any text sent is saved, event.partial); the client sends the message again
  | "preempted" // a send with stopOthers ended the turn: another model's load needed its GPU (event.neededBy, event.partial)
  | "would-stop" // a send with askFirst: running turns are in the way (error.blocking); nothing was saved or stopped
  | "thread-not-found" // the store's code, also thrown while the thread's delete runs
  | "message-not-found" // threads.get before: the message a page starts from is not in the thread
  | "image-input"
  | "shutting-down"; // the server is stopping and takes no new turns

export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: AppErrorCode;
  /** The refusing report, for wont-fit: on the wire as error.fit, with the reading it was decided from. */
  readonly report?: FitReport;
  /** For preempted: the model whose load needed the GPU (the terminal event's neededBy). */
  readonly neededBy?: string;
  /** For would-stop: the running turns in the way, on the wire as error.blocking. */
  readonly blocking?: readonly BlockingTurn[];
  /** For wont-fit: what does run from the same reading (WIN-MEM-02), on the wire as error.offer. */
  offer?: FitOffer;
  constructor(code: AppErrorCode, message: string, report?: FitReport, neededBy?: string, blocking?: readonly BlockingTurn[]) {
    super(message);
    this.code = code;
    if (report !== undefined) this.report = report;
    if (neededBy !== undefined) this.neededBy = neededBy;
    if (blocking !== undefined) this.blocking = blocking;
  }
}

/** An attached file the turn can't use: its words go back to the box with this reason. */
export const attachError = (e: unknown): never => { throw new AppError("image-input", e instanceof Error ? e.message : "An attached file is no longer available. Attach it again; your words are kept."); };

/** A pasted image the turn can't use: its words go back to the box with this reason. */
export const imageError = (error: unknown): never => { throw new AppError("image-input", error instanceof Error ? error.message : "An attached image is no longer available. Paste it again; your words are kept."); };

/** A runtime switch ended the turn; the reply streamed so far is saved as a stopped reply. */
export const RUNTIME_CHANGED_TURN_MESSAGE = "The Ollama runtime changed while this reply was running, so it stopped. Send the message again.";
export const runtimeChangedTurn = (): AppError => new AppError("runtime-changed", RUNTIME_CHANGED_TURN_MESSAGE);

/** A send with stopOthers ended this turn: `model`'s load needed the GPU memory `held` was using. */
export const preemptedBy = (model: string, numCtx: number, held: string): AppError =>
  new AppError("preempted", `${model} at num_ctx ${numCtx} needed the GPU memory ${held} was using, so this reply stopped. Send the message again.`, undefined, model);
export const threadGoing = (threadId: string) => new AppError("thread-not-found", `thread ${threadId} is being deleted`);
export const cancelledBeforeStart = () => new AppError("cancelled", "the turn was cancelled before it started");

/** Why a start was refused, as its message keeps it while on hold: the error's code and words, the replies in the way, what runs instead. */
export function refusalOf(e: unknown): Refusal {
  const { code, message, blocking, offer } = typeof e === "object" && e !== null ? (e as { code?: unknown; message?: unknown; blocking?: readonly BlockingTurn[]; offer?: FitOffer }) : {};
  return {
    code: typeof code === "string" && code !== "" ? code : "internal",
    message: typeof message === "string" ? message : String(e),
    ...(blocking === undefined ? {} : { blocking }),
    ...(offer === undefined ? {} : { offer }),
  };
}
