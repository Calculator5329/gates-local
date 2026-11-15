// Taking a send in: the fit beside the running turns, the GPU claim and the load gate, the saved
// question, then the start and the reply (run-turn.ts). A refusal on the way is the turn's one
// error event.
import type { AttachedFile, BlockingTurn, FitOffer, Message, Params } from "@gates-local/contracts";
import { accountImages, imagePrompt, saveAttachments, visionHistory } from "../chat/attachments.ts";
import { checkFiles, fileLine, fileSources } from "../chat/files.ts";
import { condensePages } from "../chat/pages.ts";
import { sendMark } from "../chat/send-times.ts";
import type { TurnMessage } from "../chat/types.ts";
import { fitToWindow, OMITTED_IMAGE } from "../chat/window.ts";
import { offerAfterRefusal } from "../fit/alternatives.ts";
import { planLoad } from "../fit/fit.ts";
import { untilAborted } from "../fit/gpu.ts";
import { fetchShow, sameModel } from "../fit/ollama.ts";
import type { FitReport } from "../fit/types.ts";
import { catalogModels } from "../runtime/catalog.ts";
import { AdmitCancelled, ModelActionError, type AdmitContext, type TurnReservation } from "../runtime/load.ts";
import type { turnSettings } from "../settings/turn.ts";
import { AppError, attachError, cancelledBeforeStart, imageError, preemptedBy, runtimeChangedTurn } from "./errors.ts";
import type { RunTurn, TurnOptions } from "./run-turn.ts";
import { endedOf, type AppContext, type Turn, type TurnFailure } from "./turn.ts";

/** A Library entry as a turn takes its thread's files (the harness's type, through run-turn.ts). */
type LibraryEntry = NonNullable<TurnOptions["files"]>[number];

export interface Admission {
  /** A load of `model` at `numCtx` beside the admitted turns, and the turns it would push out of the GPU (below). */
  planBeside(baseUrl: string, model: string, numCtx: number, options?: { signal?: AbortSignal; measured?: boolean }): Promise<{ report: FitReport; stop: Turn[] }>;
  /** Turns as the client names them in its warning. */
  blockingTurns(stop: readonly Turn[]): BlockingTurn[];
  /** Keeps the admission on the turn for App.admission (below). */
  admitting(turn: Turn, admission: Promise<Message>, replacedFiles?: readonly string[], carrying?: readonly string[]): void;
  /** A turn chat.send took and answered (below). */
  admitTurn(
    turn: Turn,
    end: () => void,
    load: TurnReservation | undefined,
    params: Params<"chat.send"> & { images: readonly string[] },
    context: { replaced: readonly string[]; prior: readonly Message[]; settings: ReturnType<typeof turnSettings> },
  ): Promise<Message>;
  /** A turn that ended before its start: its one error event (below). */
  refused(turn: Turn, e: unknown): void;
  /** runtime-not-ready, with the runtime's state. */
  notReady(): AppError;
}

export interface AdmissionDeps extends Pick<AppContext, "deps" | "store" | "runtime" | "catalog" | "log" | "push" | "turns" | "imageReady" | "imageFiles" | "attachedFiles" | "pushReply" | "waitsOnLoad" | "fitTable"> {
  readonly runTurn: RunTurn;
}

export function createAdmission({ deps, store, runtime, catalog, log, push, turns, imageReady, imageFiles, attachedFiles, pushReply, waitsOnLoad, fitTable, runTurn }: AdmissionDeps): Admission {
  /**
   * A load of `model` at `numCtx` as the fit plans it (fit/planLoad) beside the admitted turns on
   * other models (a halted one too, until it ends), and the turns it would push out of the GPU.
   * Reads only. `measured`: inside the load gate after the handoff, where no turn is admitted
   * meanwhile, the reading alone decides; before it, the models the handoff will ask to leave count
   * as free.
   */
  const planBeside = async (
    baseUrl: string,
    model: string,
    numCtx: number,
    options: { signal?: AbortSignal; measured?: boolean } = {},
  ): Promise<{ report: FitReport; stop: Turn[] }> => {
    const running = [...turns.values()].filter((t) => t.started && !sameModel(t.model, model));
    const plan = await planLoad({
      ...deps.fit,
      baseUrl,
      model,
      numCtx,
      busy: running.map((t) => t.model),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.measured === true ? { measured: true } : {}),
    });
    return { report: plan.report, stop: running.filter((t) => plan.stop.some((n) => sameModel(n, t.model))) };
  };

  /** What a wont-fit offers instead (fit/alternatives.ts), planned as planBeside plans; undefined when it cannot tell. */
  const offerFor = async (baseUrl: string, report: FitReport) => {
    const installed = catalogModels(catalog.current() ?? []).filter((m) => m.installed).map((m) => m.name);
    return offerAfterRefusal({
      ...deps.fit,
      baseUrl,
      models: installed,
      defaultNumCtx: deps.settings?.get().defaultNumCtx ?? report.numCtx,
      busy: [...turns.values()].filter((t) => t.started && !sameModel(t.model, report.model)).map((t) => t.model),
    }, report);
  };

  /** Turns as the client names them in its warning. */
  const blockingTurns = (stop: readonly Turn[]): BlockingTurn[] => {
    const titles = new Map(store.listThreads().map((t) => [t.id, t.title]));
    return stop.map((t) => ({ threadId: t.threadId, title: titles.get(t.threadId) ?? "", model: t.model, turnId: t.turnId }));
  };

  /** Kept on the turn for App.admission; its refusal has already gone out as the turn's error event. */
  /**
   * `replacedFiles`: the attached files of the rows a Retry replaces. Once the
   * admission settles, a copy no message holds any more goes; a refused Retry kept those rows.
   */
  const admitting = (turn: Turn, admission: Promise<Message>, replacedFiles: readonly string[] = [], carrying: readonly string[] = []) => {
    // Until the question is saved (or refused), a files.release from the emptied draft leaves these alone.
    const carried = attachedFiles?.sending(carrying);
    admission.catch(() => undefined).finally(() => {
      carried?.();
      if (replacedFiles.length) attachedFiles?.collect(replacedFiles).catch((error: unknown) => log(`attached-file cleanup after a retry failed: ${String(error)}`));
    });
    turn.admission = admission;
  };

  /**
   * A turn chat.send took and answered: its fit, its load, its GPU claim and its saved question,
   * then its start and its reply. A refusal on the way is its one error event, before any start,
   * so every window hears of it. It begins after the answer has gone out: no event
   * of this turn reaches a client before the answer that names it.
   */
  async function admitTurn(
    turn: Turn,
    end: () => void,
    load: TurnReservation | undefined,
    { threadId, content, model, numCtx, messageId, images, files: attaching = [], tools, think, stopOthers, stopTurns, askFirst }: Params<"chat.send"> & { images: readonly string[] },
    { replaced, prior, settings }: { replaced: readonly string[]; prior: readonly Message[]; settings: ReturnType<typeof turnSettings> },
  ): Promise<Message> {
    let releaseGpu: (() => void) | undefined;
    let started: Message | undefined;
    let failure: unknown;
    let admissionImages: string[] = [];
    const ending = () => {
      releaseGpu?.();
      end();
    };
    try {
      try {
        await new Promise((resolve) => setImmediate(resolve));
        // waiting for its files, the GPU and the load gate is the record's first stage: turns.active has it, and
        // no event of the turn reaches a socket before chat.send's answer. From here a load of its model that it
        // waits behind (the preload its first key started) is said as loading, also before its start.
        turn.answered = true;
        waitsOnLoad(turn);
        await imageReady;
        sendMark("answered");
        const files = deps.dataDir ? await checkFiles(deps.dataDir, attaching, { threadId, owners: store.fileOwners() }).catch(attachError) : [];
        // The thread's files, this message's included, open by label in this turn when tools are on.
        const wantsTools = tools ?? deps.toolsEnabled?.() ?? false;
        const fileEntries = wantsTools && deps.dataDir ? await fileSources(deps.dataDir, [...prior.flatMap(m => m.files ?? []), ...files], deps.sources?.entries() ?? []).catch(attachError) : new Map<string, LibraryEntry>();
        const withFiles = (text: string, attached: readonly AttachedFile[] | undefined) => attached?.length ? [text, ...attached.map(f => fileLine(f, fileEntries.get(f.path)))].filter(Boolean).join("\n") : text;
        // A runtime switch ends this turn now, at every phase; the switch waits for its end().
        // The loader's close (shutdown) cancels it the way chat.cancel does.
        const reservation = load;
        if (reservation !== undefined) {
          const runtimeGone = () => {
            const reason: unknown = reservation.signal.reason;
            if (reason instanceof ModelActionError && reason.code === "shutting-down") turn.controller.abort(reason);
            else turn.halt(runtimeChangedTurn());
          };
          if (reservation.signal.aborted) runtimeGone();
          else reservation.signal.addEventListener("abort", runtimeGone, { once: true });
        }
        // Before it started: a cancel, or the runtime switch above.
        const stoppedEarly = () => turn.halted ?? cancelledBeforeStart();
        // The runtime the reservation captured: fit, admit and chat all talk to it.
        const baseUrl = load ? load.baseUrl : runtime.baseUrl();
        if (baseUrl === undefined) throw notReady();
        const show = images.length || prior.some(m => m.images?.length) ? await fetchShow(baseUrl, model, turn.controller.signal) : undefined;
        const vision = show?.capabilities?.includes("vision") === true;
        if (images.length && !vision) throw new AppError("image-input", `${model} cannot see images. Pick a model that reads images, or remove the attachments.`);
        if (images.length && deps.dataDir === undefined) throw new AppError("image-input", "Image storage is not available.");
        // Every plan reads with a signal (fit/planLoad ends each read on it); a plan error that lands
        // after the turn's cancel is the cancel.
        const turnSignal = turn.controller.signal;
        const refusal = async (report: FitReport) => {
          const e = new AppError("wont-fit", report.message ?? `${model} at num_ctx ${numCtx} does not fit (fit check refused).`, report);
          const offer = await offerFor(baseUrl, report);
          if (offer !== undefined) e.offer = offer;
          return e;
        };
        // The plan beside the admitted turns. stopOthers ends the ones whose model holds memory this
        // load needs, the way a switch does (each saves what it sent and ends "preempted"), waits
        // for them and plans again until none is in the way. Inside the gate the handoff runs again
        // first (their models are no reply's any more, so they are asked to leave too) and the plan
        // measures what that left. Without it, Ollama queues this load until those turns end on
        // their own. admit passes its own signal (the turn's and the runtime's).
        const fit = async (signal: AbortSignal, context?: AdmitContext): Promise<{ report: FitReport; stop: Turn[] }> => {
          for (;;) {
            const plan = await planBeside(baseUrl, model, numCtx, { signal, measured: context?.handoff !== undefined });
            // Asked about every turn the plan needs, not only the new ones, so the next yes covers them all.
            const unagreed = stopOthers === true ? plan.stop.filter((t) => stopTurns !== undefined && !stopTurns.includes(t.turnId)) : askFirst === true ? plan.stop : [];
            if (unagreed.length > 0) {
              throw new AppError("would-stop", `${model} at num_ctx ${numCtx} needs the GPU memory of a running reply.`, undefined, undefined, blockingTurns(plan.stop));
            }
            const victims = stopOthers === true ? plan.stop : [];
            if (victims.length === 0) return plan;
            for (const t of victims) t.halt(preemptedBy(model, plan.report.numCtx, t.model));
            await untilAborted(Promise.all(victims.map((t) => t.ended)), signal);
            await context?.leave();
          }
        };
        const planned = async () => {
          try {
            return await fit(turnSignal);
          } catch (e) {
            if (turnSignal.aborted) throw stoppedEarly();
            throw e;
          }
        };
        // Before the load gate: a cold turn holds the gate until its first token or its end, so the
        // turns this load needs stopped (that one included) are stopped here. A plan that refuses
        // even with every turn stopped and every idle model gone refuses now, never waiting on a
        // claim, unless the image engine may hold memory the handoff frees (no plan counts that).
        // The plan inside the gate decides again, from its own reading.
        const engineMayHold = deps.image !== undefined && deps.image.current().state !== "off";
        if (stopOthers === true || (askFirst === true && [...turns.values()].some((t) => t.started))) {
          // askFirst: before the claim and the gate, where this send would otherwise wait behind that reply.
          const ahead = await planned();
          if (ahead.report.verdict === "refuse" && !engineMayHold) throw await refusal(ahead.report);
        }
        // Waits while an image job holds the GPU; admit's load gate runs inside this claim.
        sendMark("lease");
        try {
          releaseGpu = await deps.lease?.acquire("chat", turnSignal);
        } catch {
          throw stoppedEarly();
        }
        // Inside the gate, after the handoff: a passing fit admits the turn, so the next load plans around it.
        const admitted = async (signal: AbortSignal, context?: AdmitContext) => {
          const r = (await fit(signal, context)).report;
          if (r.verdict !== "refuse") turn.started = true;
          return r;
        };
        sendMark("admit");
        let report: FitReport;
        try {
          report = load ? await load.admit(numCtx, { fit: admitted, signal: turnSignal }) : await admitted(turnSignal);
        } catch (e) {
          // Without a loader too: a plan error that lands after a cancel is the cancel.
          if (e instanceof AdmitCancelled || turn.halted || turnSignal.aborted) throw stoppedEarly();
          throw e;
        }
        sendMark("admitted");
        if (report.verdict === "refuse") throw await refusal(report);
        if (turnSignal.aborted) throw stoppedEarly();
        // a model is sent only the newest page's code in full (chat/pages.ts); the thread keeps every version
        const history = [...condensePages(prior).map((m): TurnMessage => {
          const priorContent = m.imageJob ? `Image job ${m.imageJob.state}${m.imageJob.message ? `: ${m.imageJob.message}` : ""}` : withFiles(m.content, m.files);
          if (!m.images?.length) return { role: m.role, content: priorContent };
          if (vision && m.role === "user") return { role: m.role, content: priorContent, images: m.images };
          return { role: m.role, content: `${priorContent}\n${OMITTED_IMAGE}`, imageTokens: m.images.map(() => 0) };
        }), { role: "user" as const, content: withFiles(content, files), ...(images.length ? { images } : {}) }].map(imagePrompt);
        // Preserve text-only streaming errors; images must fit before their bytes are saved.
        const imageContext = images.length > 0 || prior.some(m => m.images?.length);
        const firstWindow = imageContext ? fitToWindow(history, report.numCtx) : { ok: true as const, messages: history };
        if (!firstWindow.ok) throw new AppError("image-input", firstWindow.message);
        const accounted = vision && deps.dataDir ? await accountImages(deps.dataDir, firstWindow.messages, show?.model_info).catch(imageError) : { messages: firstWindow.messages, omitted: false };
        const windowed = imageContext ? fitToWindow(accounted.messages, report.numCtx) : { ok: true as const, messages: accounted.messages };
        if (!windowed.ok) throw new AppError("image-input", windowed.message);
        const savedImages = images.length && deps.dataDir ? await saveAttachments(deps.dataDir, images) : [];
        admissionImages = savedImages.filter(attachment => !images.includes(attachment));
        if (savedImages.length) windowed.messages[windowed.messages.length - 1] = { ...windowed.messages.at(-1)!, images: savedImages };
        const modelHistory = vision && deps.dataDir ? await visionHistory(deps.dataDir, windowed.messages).catch(imageError) : windowed.messages;
        if (turnSignal.aborted) throw stoppedEarly();
        // The saves below wait their turn, so a Stop can land before the row goes in: the row is the point of no return.
        const append = () => {
          if (turnSignal.aborted) throw stoppedEarly();
          return store.appendMessage({ ...(messageId === undefined ? {} : { id: messageId }), threadId, role: "user", content, ...(savedImages.length ? { images: savedImages } : {}), ...(files.length ? { files } : {}) }, replaced);
        };
        const stopFirst = (wrap: (error: unknown) => never) => (error: unknown): never => { if (turnSignal.aborted) throw stoppedEarly(); return wrap(error); };
        const withImages = () => imageFiles ? imageFiles.save(savedImages, append).catch(stopFirst(imageError)) : append();
        // A file removed since the check above (its day ran out) is said, not saved as a dead reference.
        const userMessage = attachedFiles && files.length ? await attachedFiles.save(files, withImages, threadId).catch(stopFirst(attachError)) : await withImages();
        sendMark("saved");
        push("threads.changed", { threadId });
        started = userMessage;
        turn.started = true;
        // Every client (also one that did not send this) learns of the question here.
        turn.start = { type: "start", model, userMessage };
        // a model it loads is ready at its first token; one already in memory, now
        if (load?.cold === true) turn.clock.loading();
        else turn.clock.ready(Date.now());
        push("chat.event", { turnId: turn.turnId, threadId, event: turn.start });
        pushReply(turn);
        // the plan read the GPU a moment ago: the table takes that reading
        fitTable.changed({ afterPlan: true });
        void runTurn(turn, ending, baseUrl, model, report.numCtx, modelHistory, load, { tools, think, settings, files: [...fileEntries.values()] });
      } catch (e) {
        failure = e;
        turn.terminal = true;
      } finally {
        try {
          if (!started) await imageFiles?.collect(admissionImages);
        } finally { if (!started) { load?.end(); ending(); } }
      }
    } catch (e) {
      log(`turn ${turn.turnId}: admission cleanup failed: ${(e as Error).message}`);
    }
    // said once the turn let go of everything it held: a client that hears it finds no claim and no file left
    if (started === undefined) {
      refused(turn, failure);
      throw failure;
    }
    return started;
  }

  /**
   * A turn that ended before its start: one error event says why, with the turns
   * in the way for would-stop, and how it ended (a Stop, a halt, or a refusal). Nothing of it was
   * saved, so the sender's words go back to its composer.
   */
  function refused(turn: Turn, e: unknown): void {
    const { code, message, blocking, neededBy, report, offer } = typeof e === "object" && e !== null ? (e as { code?: unknown; message?: unknown; blocking?: readonly BlockingTurn[]; neededBy?: string; report?: FitReport; offer?: FitOffer }) : {};
    const failure: TurnFailure = {
      type: "error",
      code: typeof code === "string" && code !== "" ? code : "internal",
      message: typeof message === "string" ? message : String(e),
      ...(blocking === undefined ? {} : { blocking }),
      ...(neededBy === undefined ? {} : { neededBy }),
      // wont-fit: the reading the refusal was decided from (taken after everything else was asked to leave)
      ...(code === "wont-fit" && report !== undefined ? { fit: report } : {}),
      ...(offer === undefined ? {} : { offer }),
    };
    if (failure.code === "internal") log(`turn ${turn.turnId} refused: ${failure.message}`);
    turn.terminal = true;
    push("chat.event", { turnId: turn.turnId, threadId: turn.threadId, event: { ...failure, ended: endedOf(turn, failure, Date.now()) } });
  }

  function notReady(): AppError {
    const s = runtime.status();
    return new AppError("runtime-not-ready", `Ollama is not ready (${s.state}${s.detail ? `: ${s.detail}` : ""}).`);
  }

  return { planBeside, blockingTurns, admitting, admitTurn, refused, notReady };
}
