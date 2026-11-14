// Runtime/model reads, local model choice, catalog and download actions.
import type { BlockingTurn, MemoryState, MethodName, Params, Payload, ResultOf } from "@gates-local/contracts";
import { draftHolds } from "../drafts.ts";
import { type ModelDecision, choosable, modelChoice as pickChoice, modelNameKey, newestOnly } from "../pick.ts";
import { describeModel, k } from "../format.ts";
import { imageMode } from "../image-choice.ts";
import { saveLoadTimes } from "../load-times.ts";
import { NA, type State, chatReady, getState, setState } from "../store.ts";

type Request = <M extends MethodName>(method: M, params: Params<M>) => Promise<ResultOf<M>>;
type Act = <M extends MethodName>(method: M, params: Params<M>, what: string, todo?: string) => Promise<{ readonly ok: true; readonly value: ResultOf<M> } | { readonly ok: false; readonly message: string }>;
type Probe = <M extends MethodName>(method: M, params: Params<M>) => Promise<ResultOf<M> | typeof NA | undefined>;
interface ModelEffects {
  readonly applyServerEvent: typeof setState;
  readonly call: Request;
  readonly probe: Probe;
  readonly act: Act;
  readonly isNA: (error: unknown) => boolean;
  readonly restoreSaved: () => void;
  readonly flushQueued: () => void;
  readonly blockingFor: (model: string, numCtx: number) => Promise<readonly BlockingTurn[]>;
}

/** A memory refusal's words, as a send's ("Gemma 4 12B doesn't fit in memory at 16k."). */
export function memoryRefusal(model: string, numCtx: number): string {
  const s = getState();
  return `${describeModel(model, s.catalog === NA ? undefined : s.catalog).name} doesn't fit in memory at ${k(numCtx)}.`;
}

/** How often typing may ask for a load of the same model. */
const TYPED_LOAD_EVERY_MS = 60_000;

/** First-batch hydration holds all pushes until this snapshot lands. */
export function reconcilePulls(pulls: State["pulls"], pending: ResultOf<"models.pulls"> | typeof NA | undefined): State["pulls"] {
  if (pending === NA || pending === undefined) return pulls;
  const terminal = Object.entries(pulls).filter(([, p]) => p.state !== "queued" && p.state !== "downloading" && p.state !== "verifying");
  return { ...Object.fromEntries(terminal), ...Object.fromEntries(pending.map((p) => [p.name, p])) };
}

/** Completed progress bridges the list handoff, then retires so Remove cannot revive it. */
export function settlePulls(pulls: State["pulls"], models: State["models"]): State["pulls"] {
  const installed = new Set(models?.map((m) => modelNameKey(m.name)));
  return Object.fromEntries(Object.entries(pulls).filter(([name, p]) => p.state !== "done" || !installed.has(modelNameKey(name))));
}

/** Keep the chat model valid: the settings default, else the smallest installed model (the fastest that fits). */
export function chooseModel(): void {
  setState(decided(modelChoice(getState())));
}

/**
 * Keep, switch to the server's pick (pick.ts), or clear when no model can chat.
 * An open thread's model counts as chosen, so a recommendation never moves it;
 * only a new chat the user has not picked for follows the pick (MP-02).
 */
export function modelChoice(s: State): ModelDecision {
  return pickChoice(s.models, s.model, s.threadId === null ? newChatWant(s) : (s.threadModels[s.threadId] ?? s.model));
}

/** The chat model memory holds, as memory names it; undefined when it holds an image setup or nothing. */
export const residentChat = (s: Pick<State, "memory">): string | undefined =>
  s.memory?.resident?.kind === "chat" ? s.memory.resident.model : undefined;

/**
 * What a new chat starts on (owner, 2026-11-13: the model in memory is the default): the chat model
 * in memory when the chat opened or a load ended under an empty box, as the installed list names it,
 * unless the person picked in this chat; else the model used last (`chosen`), else the server's pick.
 */
export function newChatWant(s: State): string | undefined {
  if (s.newChatPicked || s.newChatResident === undefined) return s.chosen;
  const key = modelNameKey(s.newChatResident);
  return s.models?.find((m) => modelNameKey(m.name) === key && choosable(m))?.name ?? s.chosen;
}

/** A new chat's model, from what memory holds now: the snapshot it keeps until the person picks or a load ends under an empty box. */
export function newChatModel(s: State): Partial<State> {
  // An image setup in memory keeps the chat model the button had; nothing in memory is today's default.
  const resident = s.memory?.resident === undefined ? undefined : (residentChat(s) ?? s.newChatResident);
  const fresh: State = { ...s, threadId: null, newChatPicked: false, newChatResident: resident };
  return { newChatPicked: false, newChatResident: fresh.newChatResident, ...decided(pickChoice(s.models, s.model, newChatWant(fresh))) };
}

/**
 * What is in memory changed. A new chat's button takes a chat model that is now in memory only while
 * the box is empty, the list is closed and the person has not picked here: it never changes under
 * their hand. An image setup in memory leaves the chat button as it is.
 */
export function memoryChanged(memory: MemoryState): void {
  setState((s) => {
    const model = residentChat({ memory });
    const take = model !== undefined && s.threadId === null && !s.newChatPicked && s.pop?.id !== "picker" && !draftHolds(null);
    if (!take) return { memory };
    const next: State = { ...s, memory, newChatResident: model };
    return { memory, newChatResident: model, ...decided(modelChoice(next)) };
  });
}

export const decided = (d: ModelDecision): Partial<State> => (d.kind === "keep" ? {} : { model: d.kind === "set" ? d.model : undefined });

export function createModels({ applyServerEvent, call, probe, act, isNA, restoreSaved, flushQueued, blockingFor }: ModelEffects) {
  const modelsOrder = newestOnly();
  const runtimeOrder = newestOnly();
  // A catalog asked before a later models.changed describes the list before it: only the newest lands.
  const catalogOrder = newestOnly();

  /** The newest answer lands; an older one only while there is nothing to show, since the newer question may have failed (W1-02). */
  const catalogLands = (ticket: number): boolean => catalogOrder.current(ticket) || getState().catalog === undefined;

  async function refreshCatalog(): Promise<void> {
    if (getState().catalog === NA) return;
    const ticket = catalogOrder.next();
    const catalog = await probe("models.catalog", {});
    if (catalog !== undefined && catalogLands(ticket)) applyServerEvent({ catalog });
  }

  async function refreshModels(): Promise<void> {
    const ticket = modelsOrder.next();
    const models = await call("models.refresh", {}).catch(() => undefined);
    if (models === undefined || !modelsOrder.current(ticket)) return;
    applyServerEvent((s) => ({ models, pulls: settlePulls(s.pulls, models) }));
    restoreSaved();
    chooseModel();
    if (getState().catalog === undefined) void refreshCatalog();
  }

  /** The server's last refusal of a pick, said in the status line; it leaves when the pick changes. */
  let refusal: string | null = null;

  function pickModel(model: string): void {
    setState((st) => ({
      model,
      chosen: model,
      ...(st.threadId === null ? { newChatPicked: true } : {}),
      ...(st.threadId === null ? {} : { threadModels: { ...st.threadModels, [st.threadId]: model } }),
      ...(refusal !== null && st.notice === refusal && st.model !== model ? { notice: null } : {}),
    }));
    const s = getState();
    if (!s.unavailable["models.load"] && chatReady(s)) void preload(model, s.numCtx);
  }

  /**
   * Load the picked model ahead of the first message, unless a running reply is
   * holding the memory it needs. Then models.load would wait behind that reply
   * (Ollama queues it), and only a send may stop someone's answer: the load
   * happens at the send, behind its warning.
   */
  async function preload(model: string, numCtx: number): Promise<void> {
    if (Object.values(getState().turns).some((turn) => turn.model === model && turn.end === undefined)) return;
    if ((await blockingFor(model, numCtx)).length !== 0 || getState().model !== model) return;
    const r = await act("models.load", { model, numCtx }, `load ${model}`);
    // The pick passed on this client's table; the server refused it on its own, newer reading.
    // Say why once, in the status line under the box the pick was made from, while it is still the pick.
    if (r.ok && r.value.state === "error" && r.value.message !== undefined && getState().model === model) {
      const { offer } = r.value;
      // A memory refusal with its offer: the note says it in numbers and buttons, its words are the short ones a send gets (WIN-MEM-02).
      refusal = offer === undefined ? r.value.message : memoryRefusal(model, r.value.numCtx);
      setState({ notice: refusal, noticeOffer: offer === undefined ? null : { notice: refusal, model, numCtx: r.value.numCtx, offer } });
    }
  }

  /** When each model was last asked to load by typing, so a run of keys asks once. */
  const typedAt = new Map<string, number>();

  /**
   * A key typed in the message box starts the thread's model loading (chat row 39, owner pick A):
   * the load runs while the person writes, and opening the app takes nothing from the card. At most
   * one ask a minute per model; the server answers at once when the model is already in memory.
   */
  function typedInComposer(): void {
    const s = getState();
    const model = s.model;
    // in Image mode the words are a picture's prompt: the card is the image model's
    if (model === undefined || imageMode(s) || s.unavailable["models.load"] || !chatReady(s) || s.loads[model]?.state === "loading") return;
    const now = Date.now();
    if (now - (typedAt.get(model) ?? Number.NEGATIVE_INFINITY) < TYPED_LOAD_EVERY_MS) return;
    typedAt.set(model, now);
    void preload(model, s.numCtx);
  }

  async function pull(name: string): Promise<string | null> {
    const tag = name.trim();
    if (tag === "") return null;
    const queued = { name: tag, state: "queued", completedBytes: 0 } satisfies Payload<"models.pull">;
    applyServerEvent((s) => ({ pulls: { ...s.pulls, [tag]: queued } }));
    const r = await act("models.pull", { name: tag }, `start downloading ${tag}`);
    if (r.ok) return null;
    applyServerEvent((s) => {
      if (s.pulls[tag] !== queued) return {}; // A push or newer attempt already owns the row.
      const { [tag]: _gone, ...pulls } = s.pulls;
      return { pulls };
    });
    return r.message;
  }

  async function cancelPull(name: string): Promise<string | null> {
    const r = await act("models.cancelPull", { name }, `cancel the download of ${name}`);
    // a cancel the server never heard leaves the download running, and its row stays
    if (!r.ok) return r.message;
    applyServerEvent((s) => {
      const { [name]: _gone, ...pulls } = s.pulls;
      return { pulls };
    });
    return null;
  }

  async function removeModel(name: string): Promise<string | null> {
    const r = await act("models.remove", { name }, `remove ${name}`);
    if (!r.ok) return r.message;
    await refreshModels();
    return null;
  }

  /**
   * Retry from a runtime banner: the server looks for Ollama again (and starts
   * the app's own copy where it may), then the model list reloads. The phone
   * only looks, starting nothing; a server without runtime.retry answers its
   * cached status.
   */
  async function recheckRuntime(): Promise<void> {
    const asked = getState().unavailable["runtime.retry"]
      ? call("runtime.discover", {})
      : call("runtime.retry", {}).catch((e: unknown) => (isNA(e) ? call("runtime.status", {}) : Promise.reject(e)));
    const runtime = await asked.catch(() => undefined);
    if (runtime !== undefined) applyServerEvent({ runtime });
    await refreshModels();
    if (runtime?.state === "ready") void refreshCatalog();
  }

  function runtimeChanged(runtime: Payload<"runtime.changed">): void {
      // A list asked before the change describes the runtime before it (MP2-02); ask again.
      modelsOrder.next();
      runtimeOrder.next(); // and a runtime.status asked before it is older than this (MP4-03)
      applyServerEvent({ runtime });
      if (runtime.state === "ready") {
        flushQueued();
        void refreshModels();
        // A catalog read before Ollama answered recommends nothing, so first run had no Download button.
        void refreshCatalog();
      }
  }

  function modelsChanged(models: Payload<"models.changed">): void {
      modelsOrder.next();
      applyServerEvent((s) => ({ models, pulls: settlePulls(s.pulls, models) }));
      restoreSaved();
      chooseModel();
      flushQueued();
      // The catalog's Installed marks follow the list: a removal or a runtime
      // switch (the app's own copy has its own models) must not leave them stale.
      void refreshCatalog();
  }

  function pullChanged(p: Payload<"models.pull">): void {
      applyServerEvent((s) => ({ pulls: settlePulls({ ...s.pulls, [p.name]: p }, s.models) }));
      if (p.state === "done") void refreshModels();
  }

  function loadChanged(l: Payload<"models.load">): void {
      const now = Date.now();
      applyServerEvent((s) => {
        const loads = { ...s.loads, [l.model]: l };
        const since = s.loadSince[l.model];
        // a load opens at its first "loading" notice; only a "ready" that ends one this client saw start is a time
        if (l.state === "loading") return { loads, ...(since === undefined ? { loadSince: { ...s.loadSince, [l.model]: now } } : {}) };
        if (since === undefined) return { loads };
        const { [l.model]: _done, ...loadSince } = s.loadSince;
        if (l.state !== "ready") return { loads, loadSince };
        const loadTimes = { ...s.loadTimes, [l.model]: now - since };
        saveLoadTimes(loadTimes);
        return { loads, loadSince, loadTimes };
      });
  }

  return { modelsOrder, runtimeOrder, catalogOrder, catalogLands, refreshModels, refreshCatalog,
    pickModel, typedInComposer, pull, cancelPull, removeModel, recheckRuntime, runtimeChanged, modelsChanged, pullChanged, loadChanged };
}
