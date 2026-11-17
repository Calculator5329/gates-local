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
  readonly newer: (row: SyncRow, sync: SyncMetadata | undefined) => boolean;
}

const row = (sync: SyncRow | undefined): SyncRow => {
  if (sync === undefined) throw new Error("a models row lost its sync row");
  return sync;
};
export const RUNTIME = row(pushSync("runtime.changed"));
export const MODELS = row(pushSync("models.changed"));
export const CATALOG = row(methodSync("models.catalog"));

export function listArrived(listed: ResultOf<"models.list">, sync: SyncMetadata | undefined, newer: ModelEffects["newer"]): Partial<Pick<State, "runtime" | "models">> {
  const runtime = newer(RUNTIME, sync) ? { runtime: listed.runtime } : {};
  const models = answered(listed.runtime) && newer(MODELS, sync) ? { models: listed.models } : {};
  return { ...runtime, ...models };
}

export function memoryRefusal(model: string, numCtx: number): string {
  const s = getState();
  return `${describeModel(model, s.catalog === NA ? undefined : s.catalog).name} doesn't fit in memory at ${k(numCtx)}.`;
}

const TYPED_LOAD_EVERY_MS = 60_000;

export function reconcilePulls(pulls: State["pulls"], pending: ResultOf<"models.pulls"> | typeof NA | undefined): State["pulls"] {
  if (pending === NA || pending === undefined) return pulls;
  const terminal = Object.entries(pulls).filter(([, p]) => p.state !== "queued" && p.state !== "downloading" && p.state !== "verifying");
  return { ...Object.fromEntries(terminal), ...Object.fromEntries(pending.map((p) => [p.name, p])) };
}

export function settlePulls(pulls: State["pulls"], models: State["models"]): State["pulls"] {
  const installed = new Set(models?.map((m) => modelNameKey(m.name)));
  return Object.fromEntries(Object.entries(pulls).filter(([name, p]) => p.state !== "done" || !installed.has(modelNameKey(name))));
}

export const answered = (runtime: Pick<RuntimeStatus, "state"> | undefined): boolean => runtime?.state === "ready";

export function chooseModel(): void {
  setState(decided(modelChoice(getState())));
}

export function modelChoice(s: State): ModelDecision {
  return pickChoice(s.models, s.model, s.threadId === null ? newChatWant(s) : (s.threadModels[s.threadId] ?? s.model));
}

export const residentChat = (s: Pick<State, "memory">): string | undefined =>
  s.memory?.resident?.kind === "chat" ? s.memory.resident.model : undefined;

export function newChatWant(s: State): string | undefined {
  if (s.newChatPicked || s.newChatResident === undefined) return s.chosen;
  const key = modelNameKey(s.newChatResident);
  return s.models?.find((m) => modelNameKey(m.name) === key && choosable(m))?.name ?? s.chosen;
}

export function newChatModel(s: State): Partial<State> {
  const resident = s.memory?.resident === undefined ? undefined : (residentChat(s) ?? s.newChatResident);
  const fresh: State = { ...s, threadId: null, newChatPicked: false, newChatResident: resident };
  return { newChatPicked: false, newChatResident: fresh.newChatResident, ...decided(pickChoice(s.models, s.model, newChatWant(fresh))) };
}

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
  async function refreshCatalog(): Promise<void> {
    if (getState().catalog === NA) return;
    const catalog = await probe("models.catalog", {}, { onResult: (value, sync) => { if (newer(CATALOG, sync)) applyServerEvent({ catalog: value }); } });
    if (catalog === NA) applyServerEvent({ catalog });
  }

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
    if (!s.unavailable["models.load"] && chatReady(s)) void preload(model, s.numCtx, true);
  }

  // external: Ollama queues a load behind a running reply
  async function preload(model: string, numCtx: number, pick = false): Promise<void> {
    if (Object.values(getState().turns).some((turn) => turn.model === model && turn.end === undefined)) return;
    if ((await blockingFor(model, numCtx)).length !== 0 || getState().model !== model) return;
    const r = await act("models.load", { model, numCtx, ...(pick ? { pick } : {}) }, `load ${model}`);
    if (r.ok && r.value.state === "error" && r.value.message !== undefined && getState().model === model) {
      const { offer } = r.value;
      refusal = offer === undefined ? r.value.message : memoryRefusal(model, r.value.numCtx);
      setState({ notice: refusal, noticeOffer: offer === undefined ? null : { notice: refusal, model, numCtx: r.value.numCtx, offer } });
    }
  }

  const typedAt = new Map<string, number>();

  function typedInComposer(): void {
    const s = getState();
    const model = s.model;
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
      if (s.pulls[tag] !== queued) return {};
      const { [tag]: _gone, ...pulls } = s.pulls;
      return { pulls };
    });
    return r.message;
  }

  async function cancelPull(name: string): Promise<string | null> {
    const r = await act("models.cancelPull", { name }, `cancel the download of ${name}`);
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

  async function recheckRuntime(): Promise<void> {
    const landed = { onResult: (runtime: RuntimeStatus, sync: SyncMetadata | undefined) => { if (newer(RUNTIME, sync)) applyServerEvent({ runtime }); } };
    const asked = getState().unavailable["runtime.retry"]
      ? call("runtime.discover", {}, landed)
      : call("runtime.retry", {}, landed).catch((e: unknown) => (isNA(e) ? call("runtime.status", {}, landed) : Promise.reject(e)));
    const runtime = await asked.catch(() => undefined);
    await refreshModels();
    if (runtime?.state === "ready") void refreshCatalog();
  }

  function runtimeChanged(runtime: Payload<"runtime.changed">): void {
      applyServerEvent({ runtime });
      if (runtime.state === "ready") {
        void refreshModels();
        void refreshCatalog();
      }
  }

  function modelsChanged(models: Payload<"models.changed">): void {
      if (models.length === 0 && !answered(getState().runtime)) return;
      applyServerEvent(withModels(models));
      restoreSaved();
      chooseModel();
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
