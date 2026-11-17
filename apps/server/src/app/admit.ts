import type { AttachedFile, BlockingTurn, FitOffer, Message, OtherHolder } from "@gates-local/contracts";
import { accountImages, imagePrompt, saveAttachments, visionHistory } from "../chat/attachments.ts";
import { checkFiles, fileLine, fileSources } from "../chat/files.ts";
import { condensePages } from "../chat/pages.ts";
import { sendMark } from "../chat/send-times.ts";
import type { TurnMessage } from "../chat/types.ts";
import { fitToWindow, OMITTED_IMAGE } from "../chat/window.ts";
import { offerAfterRefusal, withFree } from "../fit/alternatives.ts";
import { planLoad } from "../fit/fit.ts";
import { untilAborted } from "../fit/gpu.ts";
import { fetchShow, sameModel } from "../fit/ollama.ts";
import type { FitReport } from "../fit/types.ts";
import { catalogModels } from "../runtime/catalog.ts";
import { AdmitCancelled, ModelActionError, type AdmitContext, type TurnReservation } from "../runtime/load.ts";
import type { turnSettings } from "../settings/turn.ts";
import { threadChanged } from "../threads/sync.ts";
import { AppError, attachError, cancelledBeforeStart, imageError, preemptedBy, refusalOf, runtimeChangedTurn } from "./errors.ts";
import type { RunTurn, TurnOptions } from "./run-turn.ts";
import { endedOf, type AppContext, type StartParams, type Turn, type TurnFailure } from "./turn.ts";

type LibraryEntry = NonNullable<TurnOptions["files"]>[number];

export interface Admission {
  planBeside(baseUrl: string, model: string, numCtx: number, options?: { signal?: AbortSignal; measured?: boolean }): Promise<{ report: FitReport; stop: Turn[] }>;
  blockingTurns(stop: readonly Turn[]): BlockingTurn[];
  admitting(turn: Turn, admission: Promise<Message>, replacedFiles?: readonly string[], carrying?: readonly string[]): void;
  admitTurn(
    turn: Turn,
    end: () => void,
    load: TurnReservation | undefined,
    params: StartParams & { images: readonly string[] },
    context: { replaced: readonly string[]; prior: readonly Message[]; settings: ReturnType<typeof turnSettings> },
  ): Promise<Message>;
  refused(turn: Turn, e: unknown, stoppedAt: number | undefined): void;
  notReady(): AppError;
}

export interface AdmissionDeps extends Pick<AppContext, "deps" | "store" | "runtime" | "catalog" | "log" | "push" | "said" | "turns" | "imageReady" | "imageFiles" | "attachedFiles" | "pushReply" | "answered" | "replies" | "fitTable"> {
  readonly runTurn: RunTurn;
}

export function createAdmission({ deps, store, runtime, catalog, log, push, said, turns, imageReady, imageFiles, attachedFiles, pushReply, answered, replies, fitTable, runTurn }: AdmissionDeps): Admission {
  const planBeside = async (
    baseUrl: string,
    model: string,
    numCtx: number,
    options: { signal?: AbortSignal; measured?: boolean } = {},
  ): Promise<{ report: FitReport; stop: Turn[] }> => {
    const running = [...turns.values()].filter((t) => t.inMemory && !sameModel(t.model, model));
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

  const offerFor = async (baseUrl: string, report: FitReport) => {
    const installed = catalogModels(catalog.current() ?? []).filter((m) => m.installed).map((m) => m.name);
    return offerAfterRefusal({
      ...deps.fit,
      baseUrl,
      models: installed,
      defaultNumCtx: deps.settings?.get().defaultNumCtx ?? report.numCtx,
      busy: [...turns.values()].filter((t) => t.inMemory && !sameModel(t.model, report.model)).map((t) => t.model),
    }, report);
  };

  const blockingTurns = (stop: readonly Turn[]): BlockingTurn[] => {
    const titles = new Map(store.listThreads().map((t) => [t.id, t.title]));
    return stop.map((t) => ({ threadId: t.threadId, title: titles.get(t.threadId) ?? "", model: t.model, turnId: t.turnId }));
  };

  const admitting = (turn: Turn, admission: Promise<Message>, replacedFiles: readonly string[] = [], carrying: readonly string[] = []) => {
    const carried = attachedFiles?.sending(carrying);
    admission.catch(() => undefined).finally(() => {
      carried?.();
      if (replacedFiles.length) attachedFiles?.collect(replacedFiles).catch((error: unknown) => log(`attached-file cleanup after a retry failed: ${String(error)}`));
    });
    turn.admission = admission;
  };

  async function admitTurn(
    turn: Turn,
    end: () => void,
    load: TurnReservation | undefined,
    { threadId, content, model, numCtx, messageId, images, files: attaching = [], tools, think, stopOthers, stopTurns, askFirst }: StartParams & { images: readonly string[] },
    { replaced, prior, settings }: { replaced: readonly string[]; prior: readonly Message[]; settings: ReturnType<typeof turnSettings> },
  ): Promise<Message> {
    let releaseGpu: (() => void) | undefined;
    let started: Message | undefined;
    let failure: unknown;
    let stoppedAt: number | undefined;
    let admissionImages: string[] = [];
    const still = () => replies.starting(turn.turnId, turn.attempt);
    const ending = () => {
      releaseGpu?.();
      end();
    };
    try {
      try {
        await new Promise((resolve) => setImmediate(resolve));
        answered(turn);
        await imageReady;
        sendMark("answered");
        const files = deps.dataDir ? await checkFiles(deps.dataDir, attaching, { threadId, owners: store.fileOwners() }).catch(attachError) : [];
        const wantsTools = tools ?? deps.toolsEnabled?.() ?? false;
        const fileEntries = wantsTools && deps.dataDir ? await fileSources(deps.dataDir, [...prior.flatMap(m => m.files ?? []), ...files], deps.sources?.entries() ?? []).catch(attachError) : new Map<string, LibraryEntry>();
        const withFiles = (text: string, attached: readonly AttachedFile[] | undefined) => attached?.length ? [text, ...attached.map(f => fileLine(f, fileEntries.get(f.path)))].filter(Boolean).join("\n") : text;
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
        const stoppedEarly = () => turn.halted ?? cancelledBeforeStart();
        const baseUrl = load ? load.baseUrl : runtime.baseUrl();
        if (baseUrl === undefined) throw notReady();
        const show = images.length || prior.some(m => m.images?.length) ? await fetchShow(baseUrl, model, turn.controller.signal) : undefined;
        const vision = show?.capabilities?.includes("vision") === true;
        if (images.length && !vision) throw new AppError("image-input", `${model} cannot see images. Pick a model that reads images, or remove the attachments.`);
        if (images.length && deps.dataDir === undefined) throw new AppError("image-input", "Image storage is not available.");
        const turnSignal = turn.controller.signal;
        let held: readonly OtherHolder[] | undefined;
        const refusal = async (report: FitReport) => {
          const e = new AppError("wont-fit", report.message ?? `${model} at num_ctx ${numCtx} does not fit (fit check refused).`, report);
          const offer = withFree(await offerFor(baseUrl, report), report, held);
          if (offer !== undefined) e.offer = offer;
          return e;
        };
        // external: Ollama queues a load that needs a busy model's memory until that reply ends
        const fit = async (signal: AbortSignal, context?: AdmitContext): Promise<{ report: FitReport; stop: Turn[] }> => {
          for (;;) {
            const plan = await planBeside(baseUrl, model, numCtx, { signal, measured: context?.handoff !== undefined });
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
        const engineMayHold = deps.image !== undefined && deps.image.current().state !== "off";
        if (stopOthers === true || (askFirst === true && [...turns.values()].some((t) => t.inMemory))) {
          const ahead = await planned();
          if (ahead.report.verdict === "refuse" && !engineMayHold) throw await refusal(ahead.report);
        }
        sendMark("lease");
        try {
          releaseGpu = await deps.lease?.acquire("chat", turnSignal);
        } catch {
          throw stoppedEarly();
        }
        const admitted = async (signal: AbortSignal, context?: AdmitContext) => {
          const r = (await fit(signal, context)).report;
          held = context?.handoff?.held;
          if (r.verdict !== "refuse") turn.inMemory = true;
          return r;
        };
        sendMark("admit");
        let report: FitReport;
        try {
          report = load ? await load.admit(numCtx, { fit: admitted, signal: turnSignal }) : await admitted(turnSignal);
        } catch (e) {
          if (e instanceof AdmitCancelled || turn.halted || turnSignal.aborted) throw stoppedEarly();
          throw e;
        }
        sendMark("admitted");
        if (report.verdict === "refuse") throw await refusal(report);
        if (!still()) throw stoppedEarly();
        const history = [...condensePages(prior).map((m): TurnMessage => {
          const priorContent = m.imageJob ? `Image job ${m.imageJob.state}${m.imageJob.message ? `: ${m.imageJob.message}` : ""}` : withFiles(m.content, m.files);
          if (!m.images?.length) return { role: m.role, content: priorContent };
          if (vision && m.role === "user") return { role: m.role, content: priorContent, images: m.images };
          return { role: m.role, content: `${priorContent}\n${OMITTED_IMAGE}`, imageTokens: m.images.map(() => 0) };
        }), { role: "user" as const, content: withFiles(content, files), ...(images.length ? { images } : {}) }].map(imagePrompt);
        // why: text-only overflow stays the runtime's stream error; images must fit before saving
        const imageContext = images.length > 0 || prior.some(m => m.images?.length);
        const firstWindow = imageContext ? fitToWindow(history, report.numCtx) : { ok: true as const, messages: history };
        if (!firstWindow.ok) throw new AppError("image-input", firstWindow.message);
        const accounted = vision && deps.dataDir ? await accountImages(deps.dataDir, firstWindow.messages, show?.model_info).catch(imageError) : { messages: firstWindow.messages, omitted: false };
        const windowed = imageContext ? fitToWindow(accounted.messages, report.numCtx) : { ok: true as const, messages: accounted.messages };
        if (!windowed.ok) throw new AppError("image-input", windowed.message);
        if (!still()) throw stoppedEarly();
        const savedImages = images.length && deps.dataDir ? await saveAttachments(deps.dataDir, images) : [];
        admissionImages = savedImages.filter(attachment => !images.includes(attachment));
        if (savedImages.length) windowed.messages[windowed.messages.length - 1] = { ...windowed.messages.at(-1)!, images: savedImages };
        const modelHistory = vision && deps.dataDir ? await visionHistory(deps.dataDir, windowed.messages).catch(imageError) : windowed.messages;
        if (!still()) throw stoppedEarly();
        const append = () => {
          if (!still()) throw stoppedEarly();
          const question = store.appendMessage({ ...(messageId === undefined ? {} : { id: messageId }), threadId, role: "user", content, ...(savedImages.length ? { images: savedImages } : {}), ...(files.length ? { files } : {}) }, replaced);
          replies.started(turn.turnId, turn.attempt, question, model, { cold: load?.cold === true, drawing: false, ...(replaced.length === 0 ? { chat: store.numbers.chat(threadId) } : {}) });
          return question;
        };
        const stopFirst = (wrap: (error: unknown) => never) => (error: unknown): never => { if (!still() && replies.question(turn.turnId) === undefined) throw stoppedEarly(); return wrap(error); };
        const withImages = () => imageFiles ? imageFiles.save(savedImages, append).catch(stopFirst(imageError)) : append();
        const userMessage = attachedFiles && files.length ? await attachedFiles.save(files, withImages, threadId).catch(stopFirst(attachError)) : await withImages();
        sendMark("saved");
        started = userMessage;
        turn.inMemory = true;
        if (load?.cold === true) turn.clock.loading();
        else turn.clock.ready(Date.now());
        said({ turnId: turn.turnId, threadId, event: { type: "start", model, userMessage } });
        pushReply(turn);
        replies.notify();
        // why: after the rows' change, so a window that took their number reads nothing for this push
        push(...threadChanged(store, threadId));
        fitTable.changed({ afterPlan: true });
        void runTurn(turn, ending, baseUrl, model, report.numCtx, modelHistory, load, { tools, think, settings, files: [...fileEntries.values()] });
      } catch (e) {
        failure = e;
        replies.refused(turn.turnId, turn.attempt, refusalOf(e));
        stoppedAt = replies.stoppedAt(turn.turnId);
      } finally {
        try {
          if (!started) await imageFiles?.collect(admissionImages);
        } finally { if (!started) { load?.end(); ending(); } }
      }
    } catch (e) {
      log(`turn ${turn.turnId}: admission cleanup failed: ${(e as Error).message}`);
    }
    if (started === undefined) {
      refused(turn, failure, stoppedAt);
      throw failure;
    }
    return started;
  }

  function refused(turn: Turn, e: unknown, stoppedAt: number | undefined): void {
    const { code, message, blocking, neededBy, report, offer } = typeof e === "object" && e !== null ? (e as { code?: unknown; message?: unknown; blocking?: readonly BlockingTurn[]; neededBy?: string; report?: FitReport; offer?: FitOffer }) : {};
    const failure: TurnFailure = {
      type: "error",
      code: typeof code === "string" && code !== "" ? code : "internal",
      message: typeof message === "string" ? message : String(e),
      ...(blocking === undefined ? {} : { blocking }),
      ...(neededBy === undefined ? {} : { neededBy }),
      ...(code === "wont-fit" && report !== undefined ? { fit: report } : {}),
      ...(offer === undefined ? {} : { offer }),
    };
    if (failure.code === "internal") log(`turn ${turn.turnId} refused: ${failure.message}`);
    said({ turnId: turn.turnId, threadId: turn.threadId, event: { ...failure, ended: endedOf(turn, failure, Date.now(), stoppedAt) } });
    replies.notify();
  }

  function notReady(): AppError {
    const s = runtime.status();
    return new AppError("runtime-not-ready", `Ollama is not ready (${s.state}${s.detail ? `: ${s.detail}` : ""}).`);
  }

  return { planBeside, blockingTurns, admitting, admitTurn, refused, notReady };
}
