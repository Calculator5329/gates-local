// The connection to the Gates Local server and every action the UI takes.
// One WebSocket through createClient; it reconnects after a drop and fetches
// state again. Methods the server answers "not-implemented" are recorded as
// NA so the UI can hide them or say "Not available in this build".
import {
  type Channel,
  type Client,
  type ContextSize,
  type FitReport,
  type GpuStatus,
  type BlockingTurn,
  type Payload,
  type ResultOf,
  type Settings,
  type SettingsPatch,
  type ModelSettingsPatch,
} from "@gates-local/contracts";
import { noGpu } from "./format.ts";
import { type ModelDecision, modelChoice as pickChoice, modelNameKey, newestOnly } from "./pick.ts";
import { NA, type State, chatReady, fitKey, getState, setState, streaming } from "./store.ts";
import { createChat } from "./session/chat.ts";
import { createThreads, sortThreads, withMessage } from "./session/threads.ts";
import { applyTextSize, applyTheme, serverUrl, webServerUrl } from "./session/platform.ts";
import { createNavigation } from "./session/navigation.ts";
import { type ActionResult, codeOf, createConnection, failure, isNA } from "./session/connection.ts";

// Preserve the UI's action imports while implementation moves into session modules.
export { threadMarkdown } from "./session/threads.ts";
export { queueReason, firstPull, cancelStopAsk, canRetry, removeQueued, editQueued } from "./session/chat.ts";
export { type ActionResult, failure, isNA } from "./session/connection.ts";
export { fileUrl, dataFolder, openDataFolder, canOpenFolder, canUpdateHere, updateAndRestart } from "./session/platform.ts";
export { threadFromHash } from "./session/navigation.ts";

const chat = createChat({
  call: (method, params) => call(method, params), codeOf,
  createThread: (content, model) => createThread(content, model),
  creatingDraft: (version) => threadSession.creatingDraft(version),
  loadThread: (threadId, force) => loadThread(threadId, force),
  loading: (threadId) => loading(threadId),
  noteMessage: (threadId, message) => noteMessage(threadId, message), withMessage,
  untrackedDone: (threadId, message) => untrackedDone(threadId, message),
  openThread: (threadId) => openThread(threadId), blockingFor, invalidateFits,
});
export const { send, confirmStopAsk, repliesInProgress, stop, retry, sendQueuedNow, cancelQueuedEdit } = chat;
const { onChatEvent, lostTurn, bringBack, flushQueued } = chat;

const threadSession = createThreads({
  call: (method, params) => call(method, params), codeOf, failure,
  openThread: (threadId) => openThread(threadId), newThread: () => newThread(),
  navigationGeneration: () => navigation.generation,
  pendingSettings: () => navigation.pendingSettings,
});
export const { reloadThread, renameThread, deleteThread } = threadSession;
const { refreshThreads, noteMessage, loadThread, restoreSaved, loading, createThread, untrackedDone, imageSaved } = threadSession;

const connection = createConnection({
  serverUrl, webServerUrl, desktopBridge: () => window.gatesLocal, hydrate,
  beforeDisconnect: markFitsStale,
  afterDisconnect: () => {
    voiceWrites.clear();
    receivedVoiceUrl = undefined;
    lostTurn();
  },
});
export const { connect, call, libraryRequest } = connection;
const { probe, act } = connection;

// ---------------------------------------------------------------- hydrate and pushes

/** Channels whose snapshot the second hydrate batch reads (gpu.status, sources.list, image.status). */
const SECOND_BATCH: ReadonlySet<Channel> = new Set<Channel>(["gpu.changed", "sources.changed", "image.status"]);

async function hydrate(c: Client): Promise<void> {
  const current = getState().settings;
  receivedVoiceUrl = current === NA ? undefined : current?.whisperUrl;
  // A push is newer than any snapshot whose request started before it. While
  // a batch is in flight, its channels' pushes wait here and replay in order
  // right after its snapshots land, so a snapshot never undoes a push (W-03).
  // The first batch holds every channel: a ready push then publishes in the
  // same update as the model the snapshot chose.
  let held: ReadonlySet<Channel> | "all" | "none" = "all";
  const waiting: Array<() => void> = [];
  const release = (next: ReadonlySet<Channel> | "none") => {
    held = next;
    for (const run of waiting.splice(0)) run();
  };
  const dispatch = (channel: Channel, run: () => void) => {
    if (held === "all" || (held !== "none" && held.has(channel))) waiting.push(run);
    else run();
  };
  const on = <C extends Channel>(channel: C, handler: (p: Payload<C>) => void) =>
    c.subscribe(channel, (p) => dispatch(channel, () => handler(p)));
  c.subscribe("settings.changed", ({ voiceChange, ...settings }) => {
    settingsReceipt++;
    // Apply intent ordering at receipt, before a pending health check can
    // finish. Only the settings themselves wait behind hydration snapshots.
    const own = voiceChange !== undefined && voiceWrites.delete(voiceChange);
    const changed = receivedVoiceUrl !== settings.whisperUrl;
    receivedVoiceUrl = settings.whisperUrl;
    if (!own && changed) {
      setState((s) => ({ voiceConnectionVersion: s.voiceConnectionVersion + 1 }));
    }
    dispatch("settings.changed", () => {
      receivedVoiceUrl = settings.whisperUrl;
      applySettings(settings, false, true);
    });
  });
  c.subscribe("image.status", (imageStatus) => {
    imageOrder.next(); // Receipt supersedes probes even while hydration buffers application.
    dispatch("image.status", () => setState({ imageStatus }));
  });
  try {
    await hydrateWith(on, release);
  } finally {
    release("none");
  }
}

async function hydrateWith(
  on: <C extends Channel>(channel: C, handler: (p: Payload<C>) => void) => void,
  release: (next: ReadonlySet<Channel> | "none") => void,
): Promise<void> {
  on("chat.event", onChatEvent);
  on("runtime.changed", (runtime) => {
    // A list asked before the change describes the runtime before it (MP2-02); ask again.
    modelsOrder.next();
    runtimeOrder.next(); // and a runtime.status asked before it is older than this (MP4-03)
    setState({ runtime });
    if (runtime.state === "ready") {
      invalidateFits();
      flushQueued();
      void refreshModels();
    }
  });
  on("models.changed", (models) => {
    modelsOrder.next();
    const previous = getState().models;
    // Saving context changes pick advice, not the files the fit answers describe.
    const filesChanged = previous?.length !== models.length || models.some(m => {
      const old = previous?.find(p => p.name === m.name);
      return !old || old.digest !== m.digest || old.sizeBytes !== m.sizeBytes || old.maxContext !== m.maxContext;
    });
    setState((s) => ({ models, pulls: settlePulls(s.pulls, models) }));
    restoreSaved();
    chooseModel();
    if (filesChanged) invalidateFits();
    flushQueued();
    // The catalog's Installed marks follow the list: a removal or a runtime
    // switch (the app's own copy has its own models) must not leave them stale.
    void refreshCatalog();
  });
  on("threads.changed", () => void refreshThreads());
  on("gpu.changed", (gpu) => {
    const retain = onlyIdleOwnedModelsChanged(getState(), gpu);
    setState({ gpu });
    invalidateFits(!retain);
  });
  on("models.pull", (p) => {
    setState((s) => ({ pulls: settlePulls({ ...s.pulls, [p.name]: p }, s.models) }));
    if (p.state === "done") void refreshModels();
  });
  on("models.load", (l) => {
    setState((s) => ({ loads: { ...s.loads, [l.model]: l } }));
    // a failed load may have freed what it took, so it changes memory too
    if (l.state === "ready" || l.state === "unloaded" || l.state === "error") invalidateFits(false);
  });
  on("sources.changed", (sources) => setState({ sources }));
  on("image.event", (e) => {
    if (e.threadId !== undefined) imageSaved(e.threadId);
  });

  // settings.get is a local store read and the model choice needs only it and
  // the model list, so the runtime dot and a chosen model land in one render:
  // a message typed the moment the dot turns ready sends. gpu.status and the
  // catalog can take a few hundred ms and follow. The list takes a ticket like
  // any other answer, so one that lands after a newer push is dropped (MP2-02).
  const ticket = modelsOrder.next();
  const statusTicket = runtimeOrder.next();
  const listTicket = threadSession.listOrder.next();
  const [status, listed, threads, settings, active, pendingPulls] = await Promise.all([
    call("runtime.status", {}),
    call("models.list", {}).catch(() => undefined),
    call("threads.list", {}),
    probe("settings.get", {}),
    call("turns.active", {}),
    probe("models.pulls", {}),
  ]);
  const models = modelsOrder.current(ticket) ? listed : undefined;
  const runtime = runtimeOrder.current(statusTicket) ? status : undefined;
  markFitsStale();
  receivedVoiceUrl = settings === NA ? undefined : settings?.whisperUrl;
  setState((s) => {
    const withSettings = settings === NA || settings === undefined ? { settings } : settingsPatch(s, settings, true);
    const ordered = threadSession.listOrder.current(listTicket) ? sortThreads(threads) : s.threads;
    const next: State = { ...s, runtime: runtime ?? s.runtime, models: models ?? s.models, pulls: settlePulls(reconcilePulls(s.pulls, pendingPulls), models ?? s.models), threads: ordered, runningTurns: Object.fromEntries(active.map(({ threadId, turnId }) => [threadId, turnId])), fits: { ...s.fits }, staleFits: staleFitReports(s), fitStatus: staleFitStatus(s), ...withSettings };
    return { ...next, ...decided(modelChoice(next)) };
  });
  if (settings !== NA && settings !== undefined) contextSeeded = true;
  ensureFit(getState().model, getState().numCtx);
  restoreSaved();
  applyTheme(settings === NA || settings === undefined ? "system" : settings.theme);
  applyTextSize(settings === NA || settings === undefined ? undefined : settings.textSize);
  // the pushes that came during the first batch, in order, in this same task
  release(SECOND_BATCH);

  const catalogTicket = catalogOrder.next();
  const updateTicket = updateOrder.next();
  // update.status reads the .git folder and a local file; the check that
  // fetches runs only from the Check for updates button (checkForUpdates).
  const [gpu, catalog, sources, imageStatus, update] = await Promise.all([
    probe("gpu.status", {}),
    probe("models.catalog", {}),
    probe("sources.list", {}),
    probe("image.status", {}),
    probe("update.status", {}),
  ]);
  setState({ gpu, sources, imageStatus, ...(updateOrder.current(updateTicket) ? { update } : {}), ...(catalogLands(catalogTicket) ? { catalog } : {}) });
  release("none");
  // A model's thoughts take minutes in system memory, so Thinking starts off with no GPU; the composer's button still turns it on.
  // Read after the release: a GPU push held behind gpu.status is the newer answer.
  const startsOff = !thinkSeeded && noGpu(getState().gpu);
  thinkSeeded = true;
  if (startsOff) setState({ think: false });

  const s = getState();
  if (s.view === "new" && threads.length === 0 && !firstRunDone()) setState({ view: "firstrun" });
  // Anything cached from before this connection may be out of date: other
  // threads reload on their next visit, the open one now (W-04).
  threadSession.markOtherThreadsStale(s);
  if (s.threadId !== null) await loadThread(s.threadId, true);
  flushQueued();
}

const modelsOrder = newestOnly();
const runtimeOrder = newestOnly();
// A catalog asked before a later models.changed describes the list before it: only the newest lands.
const catalogOrder = newestOnly();
const imageOrder = newestOnly();
const updateOrder = newestOnly();
/** Thinking is set from settings and the GPU once per page load; after that a reconnect leaves the person's choice alone. */
let thinkSeeded = false;
/** A context choice belongs to this page session, including reconnects. */
let contextSeeded = false;

/** The newest answer lands; an older one only while there is nothing to show, since the newer question may have failed (W1-02). */
const catalogLands = (ticket: number): boolean => catalogOrder.current(ticket) || getState().catalog === undefined;

async function refreshCatalog(): Promise<void> {
  if (getState().catalog === NA) return;
  const ticket = catalogOrder.next();
  const catalog = await probe("models.catalog", {});
  if (catalog !== undefined && catalogLands(ticket)) setState({ catalog });
}

/** First-batch hydration holds all pushes until this snapshot lands. */
function reconcilePulls(pulls: State["pulls"], pending: ResultOf<"models.pulls"> | typeof NA | undefined): State["pulls"] {
  if (pending === NA || pending === undefined) return pulls;
  const terminal = Object.entries(pulls).filter(([, p]) => p.state !== "queued" && p.state !== "downloading" && p.state !== "verifying");
  return { ...Object.fromEntries(terminal), ...Object.fromEntries(pending.map((p) => [p.name, p])) };
}

/** Completed progress bridges the list handoff, then retires so Remove cannot revive it. */
function settlePulls(pulls: State["pulls"], models: State["models"]): State["pulls"] {
  const installed = new Set(models?.map((m) => modelNameKey(m.name)));
  return Object.fromEntries(Object.entries(pulls).filter(([name, p]) => p.state !== "done" || !installed.has(modelNameKey(name))));
}

export async function refreshModels(): Promise<void> {
  const ticket = modelsOrder.next();
  const models = await call("models.refresh", {}).catch(() => undefined);
  if (models === undefined || !modelsOrder.current(ticket)) return;
  setState((s) => ({ models, pulls: settlePulls(s.pulls, models) }));
  restoreSaved();
  chooseModel();
  invalidateFits();
  if (getState().catalog === undefined) void refreshCatalog();
}

// The default model is not applied here: the server's pick (pick.ts) already honours it when it can chat.
function settingsPatch(_s: State, settings: Settings, first: boolean): Partial<State> {
  return {
    settings,
    ...(first && !contextSeeded ? { numCtx: settings.defaultNumCtx } : {}),
    ...(first && !thinkSeeded ? { think: settings.thinking } : {}),
    ...(!settings.imageGen ? { image: false } : {}),
  };
}

// Match local saves at receipt; compare foreign speech against the received
// stream, which can be ahead of displayed settings during hydration. Snapshots
// reset that baseline and replay restores the newer buffered settings.
const voiceWrites = new Set<string>();
let receivedVoiceUrl: string | undefined;
// Full-settings pushes are authoritative even while hydration buffers them.
// A response to an earlier request must not replace a newer received snapshot.
let settingsReceipt = 0;

function applySettings(settings: Settings, first = false, preserveVoiceIntent = false): void {
  setState((s) => ({ ...settingsPatch(s, settings, first),
    ...(preserveVoiceIntent ? { voiceConnectionVersion: s.voiceConnectionVersion } : {}),
  }));
  applyTheme(settings.theme);
  applyTextSize(settings.textSize);
}

/** Keep the chat model valid: the settings default, else the smallest installed model (the fastest that fits). */
function chooseModel(): void {
  setState(decided(modelChoice(getState())));
}

/**
 * Keep, switch to the server's pick (pick.ts), or clear when no model can chat.
 * An open thread's model counts as chosen, so a recommendation never moves it;
 * only a new chat the user has not picked for follows the pick (MP-02).
 */
function modelChoice(s: State): ModelDecision {
  return pickChoice(s.models, s.model, s.threadId === null ? s.chosen : (s.threadModels[s.threadId] ?? s.model));
}

const decided = (d: ModelDecision): Partial<State> => (d.kind === "keep" ? {} : { model: d.kind === "set" ? d.model : undefined });

// ---------------------------------------------------------------- fit checks

// A report remains readable while its replacement is measured. The epoch also
// stops an answer started before a memory change from becoming current.
const fitChecks = new Map<string, number>();
let fitEpoch = 0;
const staleFits = new WeakSet<FitReport>();
const answeredAt = new WeakMap<FitReport, number>();

function markFitsStale(): void {
  fitEpoch++;
  const s = getState();
  for (const r of Object.values(s.fits)) if (r !== undefined && r !== "error") staleFits.add(r);
  if (s.catalog !== NA) for (const c of s.catalog ?? []) if (c.fit) staleFits.add(c.fit);
  setState(state => ({ fitStatus: staleFitStatus(state) }));
}

const ownedChatModel = (o: GpuStatus["occupants"][number]) => o.kind === "chat-model" && !o.protected;
const gpuOccupantKey = (g: GpuStatus, owned: boolean) => g.occupants.filter(o => ownedChatModel(o) === owned)
  .map(o => JSON.stringify([o.kind, o.label, Math.round(o.bytes / 1024 ** 2), o.protected])).toSorted().join("|");

/** Only decides whether old words stay on screen; every pick still needs a current fit.check answer. */
function onlyIdleOwnedModelsChanged(s: State, next: GpuStatus): boolean {
  const before = s.gpu;
  if (!before || before === NA || before.vendor !== "nvidia" || next.vendor !== "nvidia" ||
    before.name !== next.name || before.totalBytes !== next.totalBytes || before.detail !== next.detail ||
    before.freeBytes === undefined || next.freeBytes === undefined || streaming(s) || Object.keys(s.runningTurns).length > 0 ||
    Object.values(s.loads).some(load => load.state === "loading")) return false;
  if (gpuOccupantKey(before, true) === gpuOccupantKey(next, true) || gpuOccupantKey(before, false) !== gpuOccupantKey(next, false)) return false;
  const beforeOwned = before.occupants.filter(ownedChatModel).reduce((sum, o) => sum + o.bytes, 0);
  const nextOwned = next.occupants.filter(ownedChatModel).reduce((sum, o) => sum + o.bytes, 0);
  // nvidia-smi rounds free memory to MiB; a larger unexplained loss is an external change.
  return Math.abs(before.freeBytes + beforeOwned - next.freeBytes - nextOwned) <= 1024 ** 2;
}

/** Memory details must wait for this reading instead of claiming an old report still fits. */
export function currentFit(report: FitReport | "error" | undefined): FitReport | "error" | undefined {
  return report !== undefined && report !== "error" && staleFits.has(report) ? undefined : report;
}

export const fitIsCurrent = (r: FitReport | "error" | undefined) =>
  r !== undefined && r !== "error" && answeredAt.get(r) === fitEpoch;

/** Check once per memory reading; keep the previous report until it answers. */
export function ensureFit(model: string | undefined, numCtx: number): void {
  if (model === undefined) return;
  const key = fitKey(model, numCtx);
  const s = getState();
  if (fitChecks.get(key) === fitEpoch || !chatReady(s)) return;
  checkFit(model, numCtx, key, 0);
}

/** A failed check is asked again after this, doubling to FIT_RETRY_MAX_MS, until it answers or memory changes. */
const FIT_RETRY_MS = 2000;
const FIT_RETRY_MAX_MS = 30_000;

function checkFit(model: string, numCtx: number, key: string, failures: number): void {
  const epoch = fitEpoch;
  fitChecks.set(key, epoch);
  setState(s => ({ fitStatus: { ...s.fitStatus, [key]: failures > 0 ? "error" : currentFit(s.fits[key]) === undefined || s.fits[key] === "error" ? "checking" : s.fitStatus[key] ?? "fresh" } }));
  call("fit.check", { model, numCtx })
    .then(async (r) => {
      // the verdict never counts memory a running reply holds: refused may only mean "stop that reply first"
      const frees = r.verdict === "refuse" && (await blockingFor(model, numCtx)).length > 0;
      if (epoch !== fitEpoch) return;
      answeredAt.set(r, epoch);
      setState((st) => {
        const { [key]: _old, ...stopFrees } = st.stopFrees;
        const { [key]: _stale, ...remainingStale } = st.staleFits;
        const { [key]: _history, ...history } = st.fitHistory;
        return { fits: { ...st.fits, [key]: r }, fitStatus: { ...st.fitStatus, [key]: "fresh" as const }, fitHistory: history, staleFits: remainingStale, stopFrees: frees ? { ...stopFrees, [key]: true as const } : stopFrees };
      });
    })
    .catch(() => {
      if (epoch !== fitEpoch) return;
      setState((st) => {
        const { [key]: _stale, ...remainingStale } = st.staleFits;
        const previous = st.fits[key];
        return { fits: { ...st.fits, [key]: "error" as const }, fitStatus: { ...st.fitStatus, [key]: "error" as const }, fitHistory: previous !== undefined && previous !== "error" ? { ...st.fitHistory, [key]: previous } : st.fitHistory, staleFits: remainingStale };
      });
      // A failure ends the held verdict; retry while this reading is current.
      setTimeout(() => {
        const s = getState();
        if (!connection.stopped && epoch === fitEpoch && s.fits[key] === "error" && chatReady(s)) checkFit(model, numCtx, key, failures + 1);
      }, Math.min(FIT_RETRY_MAX_MS, FIT_RETRY_MS * 2 ** failures));
    });
}

/** Memory changed: refresh the open chat now and other reports when shown. */
function invalidateFits(hideOld = true): void {
  if (hideOld) markFitsStale();
  else fitEpoch++;
  // A load refreshes the measurement in place. An external GPU/file change
  // withdraws the old advice; a later load must not clear that pending state.
  setState((s) => ({ fits: { ...s.fits }, staleFits: hideOld ? staleFitReports(s) : s.staleFits, fitStatus: hideOld ? staleFitStatus(s) : s.fitStatus }));
  const s = getState();
  ensureFit(s.model, s.numCtx);
}

const staleFitReports = (s: State): State["staleFits"] => {
  const keys = new Set(Object.keys(s.fits));
  if (s.catalog !== NA) for (const c of s.catalog ?? []) if (c.fit) keys.add(fitKey(c.name, c.fit.numCtx));
  return Object.fromEntries([...keys].map(key => [key, true as const]));
};

const staleFitStatus = (s: State): State["fitStatus"] => Object.fromEntries(Object.keys(staleFitReports(s)).map(key => [key, "stale" as const]));

// ---------------------------------------------------------------- threads

const navigation = createNavigation({
  flushQueued, bringBack, chooseModel, loadThread, loading,
  newChatModel: (s) => decided(pickChoice(s.models, s.model, undefined)),
});
export const { openThread, newThread, openSettings, leaveSettings, cancelPendingSettings, initialView, finishFirstRun } = navigation;
const { firstRunDone } = navigation;

/** The running turns this load would have to stop; none when the server cannot say, and the send goes as it always did. */
async function blockingFor(model: string, numCtx: number): Promise<readonly BlockingTurn[]> {
  return call("turns.blocking", { model, numCtx }).catch(() => []);
}

// ---------------------------------------------------------------- composer and models

export function pickModel(model: string): void {
  setState((st) => ({ model, chosen: model, ...(st.threadId === null ? {} : { threadModels: { ...st.threadModels, [st.threadId]: model } }) }));
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
  const live = getState().live;
  if ((live?.model === model && live.end === undefined) || chat.hasParkedModel(model)) return;
  if ((await blockingFor(model, numCtx)).length === 0 && getState().model === model) void act("models.load", { model, numCtx }, `load ${model}`);
}

export function setContext(numCtx: ContextSize): void {
  contextSeeded = true;
  setState({ numCtx });
}

const SETTING_WORDS: Record<keyof SettingsPatch, string> = {
  defaultModel: "save the default model",
  defaultNumCtx: "save the default context window",
  thinking: "save the thinking setting",
  theme: "save the theme",
  runtimeMode: "save the Ollama choice",
  tools: "save the tools setting",
  imageGen: "save image generation",
  comfyUrl: "save the ComfyUI address",
  whisperUrl: "save voice to text",
  updateEveryChange: "save the update setting",
  textSize: "save the text size",
  systemPrompt: "save the system prompt",
  modelSettings: "reset model settings",
};

/** Save settings; null on success, else the sentence to show beside the control. Nothing changes locally until the server agrees. */
export async function updateSettings(patch: SettingsPatch, options: { voiceActionStarted?: boolean } = {}): Promise<ActionResult> {
  const keys = Object.keys(patch) as Array<keyof SettingsPatch>;
  const what = keys.length === 1 && keys[0] !== undefined ? SETTING_WORDS[keys[0]] : "save these settings";
  const voiceChange = "whisperUrl" in patch ? crypto.randomUUID() : undefined;
  if (voiceChange !== undefined) {
    if (!options.voiceActionStarted) setState((s) => ({ voiceConnectionVersion: s.voiceConnectionVersion + 1 }));
    voiceWrites.add(voiceChange);
  }
  let saved = false;
  const received = settingsReceipt;
  try {
    const r = await act("settings.update", { ...patch, ...(voiceChange === undefined ? {} : { voiceChange }) }, what);
    if (!r.ok) return r.message;
    saved = true;
    if (received === settingsReceipt) applySettings(r.value, false, voiceChange !== undefined);
    // the server reads ComfyUI only when asked: after these two, ask, so Settings says what it found
    if ("imageGen" in patch || "comfyUrl" in patch) {
      const ticket = imageOrder.next();
      void probe("image.status", {}).then((imageStatus) => {
        if (imageStatus !== undefined && imageOrder.current(ticket)) setState({ imageStatus });
      });
    }
    return null;
  } finally { if (!saved && voiceChange !== undefined) voiceWrites.delete(voiceChange); }
}

/** Save or reset one model; apply only the settings the server accepted. */
export async function updateModelSettings(model: string, patch: ModelSettingsPatch | null): Promise<ActionResult> {
  const received = settingsReceipt;
  const r = await act("settings.model.update", { model, patch }, "save model settings");
  if (!r.ok) return r.message;
  if (received === settingsReceipt) applySettings(r.value);
  return null;
}

/** What a new install starts with. Who runs Ollama stays as it is: switching it stops models and can download. */
const RESET_SETTINGS = {
  defaultModel: null,
  defaultNumCtx: 16384,
  thinking: true,
  theme: "dark",
  tools: true,
  imageGen: false,
  comfyUrl: null,
  whisperUrl: null,
  updateEveryChange: false,
  textSize: "default",
  systemPrompt: null,
  modelSettings: null,
} as const satisfies SettingsPatch;

export async function resetSettings(): Promise<ActionResult> {
  const failed = await updateSettings(RESET_SETTINGS);
  if (failed !== null) return failed;
  setContext(RESET_SETTINGS.defaultNumCtx);
  setState({ think: RESET_SETTINGS.thinking });
  return null;
}

/** Ask ComfyUI again, so Settings says what it finds now. */
export async function checkImageStatus(): Promise<ActionResult> {
  const ticket = imageOrder.next();
  const r = await act("image.status", {}, "check ComfyUI");
  if (!r.ok) return r.message;
  if (imageOrder.current(ticket)) setState({ imageStatus: r.value });
  return null;
}

export async function retryImage(threadId: string, prompt: string, retryOf: string): Promise<{ jobId: string } | string> {
  const result = await act("image.generate", { threadId, prompt, retryOf }, "make the image");
  if (!result.ok) return result.message;
  imageSaved(threadId);
  return result.value;
}

export async function cancelImage(jobId: string): Promise<ActionResult> {
  const result = await act("image.cancel", { jobId }, "cancel the image");
  return result.ok ? null : result.message;
}

export async function pull(name: string): Promise<ActionResult> {
  const tag = name.trim();
  if (tag === "") return null;
  const queued = { name: tag, state: "queued", completedBytes: 0 } satisfies Payload<"models.pull">;
  setState((s) => ({ pulls: { ...s.pulls, [tag]: queued } }));
  const r = await act("models.pull", { name: tag }, `start downloading ${tag}`);
  if (r.ok) return null;
  setState((s) => {
    if (s.pulls[tag] !== queued) return {}; // A push or newer attempt already owns the row.
    const { [tag]: _gone, ...pulls } = s.pulls;
    return { pulls };
  });
  return r.message;
}

export async function cancelPull(name: string): Promise<ActionResult> {
  const r = await act("models.cancelPull", { name }, `cancel the download of ${name}`);
  // a cancel the server never heard leaves the download running, and its row stays
  if (!r.ok) return r.message;
  setState((s) => {
    const { [name]: _gone, ...pulls } = s.pulls;
    return { pulls };
  });
  return null;
}

export async function removeModel(name: string): Promise<ActionResult> {
  const r = await act("models.remove", { name }, `remove ${name}`);
  if (!r.ok) return r.message;
  await refreshModels();
  return null;
}

const SOURCE_WORDS = { folder: "folder", file: "file", sqlite: "database" } as const;

export async function addSource(kind: "folder" | "file" | "sqlite", path: string): Promise<ActionResult> {
  if (path.trim() === "") return null;
  const r = await act("sources.add", { kind, path: path.trim() }, `add this ${SOURCE_WORDS[kind]}`, "check it and try again");
  return r.ok ? null : r.message;
}

export async function removeSource(id: string): Promise<ActionResult> {
  const r = await act("sources.remove", { id }, "remove this source");
  return r.ok ? null : r.message;
}

export async function refreshSource(id: string): Promise<ActionResult> {
  const r = await act("sources.refresh", { id }, "refresh this source");
  return r.ok ? null : r.message;
}

/**
 * Retry from a runtime banner: the server looks for Ollama again (and starts
 * the app's own copy where it may), then the model list reloads. A server
 * without runtime.retry answers its cached status instead.
 */
export async function recheckRuntime(): Promise<void> {
  const runtime = await call("runtime.retry", {}).catch((e: unknown) => (isNA(e) ? call("runtime.status", {}) : Promise.reject(e))).catch(() => undefined);
  if (runtime !== undefined) setState({ runtime });
  await refreshModels();
}

// ---------------------------------------------------------------- updates

/**
 * The Check for updates button, and nothing else, calls this: the server
 * fetches from the clone's remote. The answer (up to date, the changes, or
 * why it cannot check) lands in update.lastCheck; a failed call comes back
 * as the sentence to show.
 */
export async function checkForUpdates(): Promise<ActionResult> {
  if (getState().updateChecking) return null;
  setState({ updateChecking: true });
  const r = await act("update.check", {}, "check for updates");
  setState((s) => {
    if (r.ok && s.update !== undefined && s.update !== NA) {
      updateOrder.next(); // A completed check is newer than an in-flight hydration snapshot.
      return { updateChecking: false, update: { ...s.update, lastCheck: r.value } };
    }
    return { updateChecking: false };
  });
  return r.ok ? null : r.message;
}

/** Hide the last update's result; the server forgets it too, so other windows lose it on their next start. */
export async function dismissUpdateResult(): Promise<void> {
  setState((s) => {
    if (s.update === undefined || s.update === NA) return {};
    updateOrder.next();
    return { update: { ...s.update, result: null } };
  });
  await act("update.dismissResult", {}, "hide the update note");
}
