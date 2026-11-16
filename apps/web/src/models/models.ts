// Runtime/model reads, local model choice, catalog and download actions.
import { type BlockingTurn, type CallOptions, type MemoryState, type MethodName, type ModelInfo, type Params, type Payload, type ResultOf, type RuntimeStatus, type SyncMetadata, type SyncRow, methodSync, pushSync } from "@gates-local/contracts";
import { draftHolds } from "../lib/store/drafts.ts";
import { type ModelDecision, choosable, modelChoice as pickChoice, modelNameKey } from "./pick.ts";
import { describeModel, k } from "../lib/words/format.ts";
import { imageMode } from "../image/image-choice.ts";
import { saveLoadTimes } from "../lib/store/load-times.ts";
import { NA, type State, chatReady, getState, setState } from "../lib/store/store.ts";

type Request = <M extends MethodName>(method: M, params: Params<M>, options?: CallOptions<M>) => Promise<ResultOf<M>>;
type Act = <M extends MethodName>(method: M, params: Params<M>, what: string, todo?: string) => Promise<{ readonly ok: true; readonly value: ResultOf<M> } | { readonly ok: false; readonly message: string }>;
type Probe = <M extends MethodName>(method: M, params: Params<M>, options?: CallOptions<M>) => Promise<ResultOf<M> | typeof NA | undefined>;
interface ModelEffects {
  readonly applyServerEvent: typeof setState;
  readonly call: Request;
  readonly probe: Probe;
  readonly act: Act;
  readonly isNA: (error: unknown) => boolean;
  readonly restoreSaved: () => void;
  readonly blockingFor: (model: string, numCtx: number) => Promise<readonly BlockingTurn[]>;
  /** Whether a frame of `row`'s thing applies: on an ordered connection only when its number is newer than the last applied. */
  readonly newer: (row: SyncRow, sync: SyncMetadata | undefined) => boolean;
}

const row = (sync: SyncRow | undefined): SyncRow => {
  if (sync === undefined) throw new Error("a models row lost its sync row");
  return sync;
};
/** The numbered things of the models kind the window applies (protocol.ts rows). */
export const RUNTIME = row(pushSync("runtime.changed"));
export const MODELS = row(pushSync("models.changed"));
export const CATALOG = row(methodSync("models.catalog"));

/**
 * A list answer (models.list, models.refresh) carries the runtime it was read beside and the list,
 * each with its own number; each applies when newer. The list says which models are installed only
 * beside a ready runtime: beside any other state no Ollama answered, and the store keeps the list it
 * had. Returns the patch, empty when nothing in it is newer.
 */
export function listArrived(listed: ResultOf<"models.list">, sync: SyncMetadata | undefined, newer: ModelEffects["newer"]): Partial<Pick<State, "runtime" | "models">> {
  const runtime = newer(RUNTIME, sync) ? { runtime: listed.runtime } : {};
  const models = answered(listed.runtime) && newer(MODELS, sync) ? { models: listed.models } : {};
  return { ...runtime, ...models };
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

/**
 * A model list is an answer only beside a ready runtime: there an empty list means no model is
 * installed. Beside any other state no Ollama answered, so it says nothing and the store keeps what
 * it had (unknown before the first ready list, else the last one read).
 */
export const answered = (runtime: Pick<RuntimeStatus, "state"> | undefined): boolean => runtime?.state === "ready";

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
 * What a new chat starts on (the model in memory is the default): the chat model
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

// why: the list and its choice in one update, so no render shows models with none chosen
const withModels = (models: readonly ModelInfo[]) => (s: State): Partial<State> =>
  ({ models, pulls: settlePulls(s.pulls, models), ...decided(modelChoice({ ...s, models })) });

export function createModels({ applyServerEvent, call, probe, act, isNA, restoreSaved, blockingFor, newer }: ModelEffects) {
  /** A catalog read applies when its number is newer: one asked before a later one, or before a models.changed, describes the list before it. */
  async function refreshCatalog(): Promise<void> {
    if (getState().catalog === NA) return;
    const catalog = await probe("models.catalog", {}, { onResult: (value, sync) => { if (newer(CATALOG, sync)) applyServerEvent({ catalog: value }); } });
    if (catalog === NA) applyServerEvent({ catalog });
  }

  /** The list's answer, as it arrives: its runtime and its models when newer, then the model choice. */
  const listLanded = (listed: ResultOf<"models.list">, sync: SyncMetadata | undefined): void => {
    const patch = listArrived(listed, sync, newer);
    if (patch.runtime !== undefined) applyServerEvent({ runtime: patch.runtime });
    const { models } = patch;
    if (models === undefined) return;
    applyServerEvent(withModels(models));
    restoreSaved();
    chooseModel();
    if (getState().catalog === undefined) void refreshCatalog();
  };

  async function refreshModels(): Promise<void> {
    await call("models.refresh", {}, { onResult: listLanded }).catch(() => undefined);
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
   * A key typed in the message box starts the thread's model loading:
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
    // Each answer applies when its number is newer: a runtime.changed that overtook it stays.
    const landed = { onResult: (runtime: RuntimeStatus, sync: SyncMetadata | undefined) => { if (newer(RUNTIME, sync)) applyServerEvent({ runtime }); } };
    const asked = getState().unavailable["runtime.retry"]
      ? call("runtime.discover", {}, landed)
      : call("runtime.retry", {}, landed).catch((e: unknown) => (isNA(e) ? call("runtime.status", {}, landed) : Promise.reject(e)));
    const runtime = await asked.catch(() => undefined);
    await refreshModels();
    if (runtime?.state === "ready") void refreshCatalog();
  }

  /** A newer runtime status; a ready one reads the list and the catalog again, which describe the runtime they were read beside. */
  function runtimeChanged(runtime: Payload<"runtime.changed">): void {
      applyServerEvent({ runtime });
      if (runtime.state === "ready") {
        void refreshModels();
        // A catalog read before Ollama answered recommends nothing, so first run had no Download button.
        void refreshCatalog();
      }
  }

  function modelsChanged(models: Payload<"models.changed">): void {
      // As with a list answer: an empty list beside a runtime not known to be ready says nothing (no
      // Ollama answered), and the store keeps its list. A list with models in it came from Ollama,
      // even when it lands before this window has heard the runtime's status.
      if (models.length === 0 && !answered(getState().runtime)) return;
      applyServerEvent(withModels(models));
      restoreSaved();
      chooseModel();
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

  return { listLanded, refreshModels, refreshCatalog,
    pickModel, typedInComposer, pull, cancelPull, removeModel, recheckRuntime, runtimeChanged, modelsChanged, pullChanged, loadChanged };
}
