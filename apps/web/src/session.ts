// The connection to the Gates Local server and every action the UI takes.
// One WebSocket through createClient; it reconnects after a drop and fetches
// state again. Methods the server answers "not-implemented" are recorded as
// NA so the UI can hide them or say "Not available in this build".
import {
  type Channel,
  type Client,
  type BlockingTurn,
  type ImageChoice,
  type Payload,
} from "@gates-local/contracts";
import { modelChoice as pickChoice, newestOnly } from "./pick.ts";
import { NA, type State, getState, setState } from "./store.ts";
import { createChat } from "./session/chat.ts";
import { createServerState } from "./session/server-state.ts";
import { createSettings } from "./session/settings.ts";
import { chooseModel, createModels, decided, modelChoice, reconcilePulls, settlePulls } from "./session/models.ts";
import { newerTable } from "./fit-table.ts";
import { createThreads, sortThreads, withMessage } from "./session/threads.ts";
import { applyAccent, applyTheme, dataFolder, serverUrl, webServerUrl } from "./session/platform.ts";
import { createSettingsReads } from "./session/settings-reads.ts";
import { createNavigation, enterScreen, exitScreen, onScreenEntry } from "./session/navigation.ts";
import { createUpdates } from "./session/updates.ts";
import { speedsChanged, speedsRead } from "./session/speed.ts";
import { createUsage } from "./session/usage.ts";
import { type ActionResult, codeOf, createConnection, failure, isNA } from "./session/connection.ts";

// Preserve the UI's action imports while implementation moves into session modules.
export { threadMarkdown } from "./session/threads.ts";
export { queueReason, firstPull, cancelStopAsk, canRetry, removeQueued, editQueued } from "./session/chat.ts";
export { type ActionCall, type ActionResult, failure, isNA } from "./session/connection.ts";
export { fileUrl, dataFolder, openDataFolder, canOpenFolder, canUpdateHere } from "./session/platform.ts";
export { threadFromHash } from "./session/navigation.ts";

export const applyServerEvent = createServerState(getState, setState);

const connection = createConnection({ applyServerEvent,
  serverUrl, webServerUrl, desktopBridge: () => window.gatesLocal, hydrate,
  afterDisconnect: () => {
    // A lost connection withdraws the fit table: until the next server's own table is in, every
    // fit value waits on its placeholder, as before the first table.
    applyServerEvent({ fitTable: undefined });
    settingsSession.disconnected();
    lostTurn();
  },
});
export const { connect, call, libraryRequest } = connection;
const { probe, act } = connection;
export const settingsReads = createSettingsReads({ readImports: () => libraryRequest("sources.imports", {}), readFolder: dataFolder });
const updatesSession = createUpdates({ applyServerEvent, act });
export const { checkForUpdates, downloadUpdate, dismissUpdateResult, readUpdateStatus, updateAndRestart } = updatesSession;
const { updateOrder } = updatesSession;

const threadSession = createThreads({ applyServerEvent,
  call, codeOf, failure,
  openThread: (threadId) => openThread(threadId), newThread: () => newThread(),
  navigationGeneration: () => navigation.generation,
  pendingSettings: () => navigation.pendingSettings,
});
export const { reloadThread, renameThread, deleteThread, waitForThreadDeletion, preloadThread } = threadSession;
const { noteMessage, loadThread, restoreSaved, loading, createThread, untrackedDone, imageSaved } = threadSession;

/**
 * The last fit table stays until a newer reading replaces it; a late push or answer never does.
 * A closed connection rejects its unanswered calls, so nothing it asked for lands after the
 * disconnect has withdrawn the table.
 */
const fitTableArrived = (fitTable: Payload<"fit.changed">) => applyServerEvent((s) => (newerTable(fitTable, s.fitTable) ? { fitTable } : {}));

const chat = createChat({ applyServerEvent,
  call, codeOf,
  createThread,
  creatingDraft: threadSession.creatingDraft,
  loadThread,
  loading,
  noteMessage, withMessage,
  untrackedDone,
  openThread: (threadId) => openThread(threadId), blockingFor,
});
export const { send, confirmStopAsk, stop, retry, sendQueuedNow, cancelQueuedEdit } = chat;
const { onChatEvent, lostTurn, catchUp, activeTurns, flushQueued } = chat;

const modelsSession = createModels({ applyServerEvent,
  call, probe, act, isNA, restoreSaved, flushQueued,
  blockingFor,
});
export const { refreshModels, pickModel, pull, cancelPull, removeModel, recheckRuntime } = modelsSession;
const { modelsOrder, runtimeOrder, catalogOrder, catalogLands } = modelsSession;

// Image generation turning on (or a new address) reads the file list too: Make images left unset is
// on once a setup there can run, and the server learns that from the same read.
const settingsSession = createSettings({ applyServerEvent, authority: applyServerEvent.settings, sync: () => connection.sync, act, applyTheme, applyAccent, refreshImageStatus: () => { probeImageStatus(); void loadImagePresets(); } });
export const { setContext, updateSettings, updateModelSettings, resetSettings } = settingsSession;
const { settingsPatch } = settingsSession;

// ---------------------------------------------------------------- hydrate and pushes

/** Channels whose snapshot the second hydrate batch reads (gpu.status, sources.list, models.speed). */
const SECOND_BATCH: ReadonlySet<Channel> = new Set<Channel>(["gpu.changed", "fit.changed", "sources.changed", "update.changed", "models.speed"]);

async function hydrate(c: Client): Promise<void> {
  settingsSession.beginHydration();
  // A push is newer than any snapshot whose request started before it. While
  // a batch is in flight, its channels' pushes wait here and replay in order
  // right after its snapshots land, so a snapshot never undoes a push (W-03).
  // The first batch holds every channel: a ready push then publishes in the
  // same update as the model the snapshot chose.
  let held: ReadonlySet<Channel> | "all" | "none" = "all";
  const waiting: Array<() => void> = [];
  const release = (next: ReadonlySet<Channel> | "none") => {
    held = next;
    for (const run of waiting.splice(0)) applyServerEvent(run);
  };
  const dispatch = (channel: Channel, run: () => void) => {
    if (held === "all" || (held !== "none" && held.has(channel))) waiting.push(run);
    else applyServerEvent(run);
  };
  const on = <C extends Channel>(channel: C, handler: (p: Payload<C>) => void) =>
    c.subscribe(channel, (p) => applyServerEvent(() => dispatch(channel, () => handler(p))));
  c.subscribe("settings.changed", (payload, metadata) => applyServerEvent(() => settingsSession.receiveSettings(payload, (run) => dispatch("settings.changed", run), metadata)));
  c.subscribe("image.status", (imageStatus) => applyServerEvent(() => {
    imageOrder.next(); // Receipt supersedes probes even while hydration buffers application.
    dispatch("image.status", () => applyServerEvent({ imageStatus }));
    // ComfyUI coming up, or image generation turning off, changes which presets it has the files for; a job's busy and ready again does not
    if ((imageStatus.state === "ready" || imageStatus.state === "off") && imageStatus.state !== presetsAt) {
      presetsAt = imageStatus.state;
      void loadImagePresets();
    }
  }));
  settingsReads.begin();
  try {
    await hydrateWith(on, release, c.negotiate);
  } finally {
    settingsSession.releasePresentation();
    release("none");
    settingsReads.end();
  }
}

async function hydrateWith(
  on: <C extends Channel>(channel: C, handler: (p: Payload<C>) => void) => void,
  release: (next: ReadonlySet<Channel> | "none") => void,
  negotiate: Client["negotiate"],
): Promise<void> {
  on("chat.event", onChatEvent);
  on("runtime.changed", modelsSession.runtimeChanged);
  on("models.changed", modelsSession.modelsChanged);
  on("threads.changed", ({ threadId }) => threadSession.threadsChanged(threadId));
  on("gpu.changed", (gpu) => applyServerEvent({ gpu }));
  on("fit.changed", fitTableArrived);
  on("models.pull", modelsSession.pullChanged);
  on("models.load", modelsSession.loadChanged);
  on("models.speed", (list) => applyServerEvent((s) => speedsChanged(s, list)));
  on("sources.changed", (sources) => applyServerEvent({ sources }));
  on("update.changed", updatesSession.receiveUpdate);
  on("usage.changed", () => usageSession.usageChanged());
  on("image.event", (e) => {
    if (e.threadId !== undefined) imageSaved(e.threadId);
    // the job settled to other files than the button names: the server read ComfyUI's list again
    if (e.sent !== undefined && !settledJobs.has(e.jobId)) { settledJobs.add(e.jobId); void loadImagePresets(); }
  });
  // a setup's download: its last word reads the list again, so a row whose files are all in turns ready
  on("image.download", (imageDownload) => {
    applyServerEvent({ imageDownload });
    if (imageDownload.ended === true) void loadImagePresets();
  });
  // Install every receipt handler first. Ordered domains stay disabled until
  // their full migration lands; unsupported servers continue in legacy mode.
  const negotiated = await negotiate();
  settingsSession.ready();
  const orderedSettings = negotiated.mode === "ordered" && negotiated.domains.includes("settings");

  // settings.get is a local store read and the model choice needs only it and
  // the model list, so the runtime dot and a chosen model land in one render:
  // a message typed the moment the dot turns ready sends. gpu.status and the
  // catalog can take a few hundred ms and follow. The list takes a ticket like
  // any other answer, so one that lands after a newer push is dropped (MP2-02).
  const ticket = modelsOrder.next();
  const statusTicket = runtimeOrder.next();
  const listTicket = threadSession.listOrder.next();
  const [status, listed, threads, snapshot, active, pendingPulls] = await Promise.all([
    call("runtime.status", {}),
    call("models.list", {}).catch(() => undefined),
    call("threads.list", {}),
    // Ordered snapshots are required; protocol rejection must fail bootstrap,
    // rather than become an optional unavailable read and reset retry backoff.
    orderedSettings
      ? call("settings.get", {}, { onResult: settingsSession.acceptSettings })
      : probe("settings.get", {}, { onResult: settingsSession.acceptSettings }),
    call("turns.active", {}),
    probe("models.pulls", {}),
  ]);
  const models = modelsOrder.current(ticket) ? listed : undefined;
  const runtime = runtimeOrder.current(statusTicket) ? status : undefined;
  const settings = settingsSession.endHydration(snapshot);
  settingsSession.noteVoiceSnapshot(settings);
  applyServerEvent((s) => {
    const withSettings = settings === NA || settings === undefined ? { settings } : settingsPatch(s, settings, true);
    const ordered = threadSession.listOrder.current(listTicket) ? sortThreads(threads) : s.threads;
    const next: State = { ...s, runtime: runtime ?? s.runtime, models: models ?? s.models, pulls: settlePulls(reconcilePulls(s.pulls, pendingPulls), models ?? s.models), threads: ordered, ...activeTurns(s, active), ...withSettings };
    return { ...next, ...decided(modelChoice(next)) };
  });
  if (settings !== NA && settings !== undefined) settingsSession.seedContext();
  restoreSaved();
  applyTheme(settings === NA || settings === undefined ? "system" : settings.theme);
  applyAccent(settings === NA || settings === undefined ? undefined : settings.accent);
  // the pushes that came during the first batch, in order, in this same task
  release(SECOND_BATCH);

  const catalogTicket = catalogOrder.next();
  const updateTicket = updateOrder.next();
  // The fit table waits for nothing and nothing waits for it: until it lands every fit value is a
  // skeleton, and a pushed table that is newer wins whichever arrives first.
  void probe("fit.table", {}).then((fitTable) => { if (fitTable !== undefined && fitTable !== NA) fitTableArrived(fitTable); });
  // update.status reads local files; the desktop server owns automatic checks.
  // Measured speeds are a saved-reply read the model list's first frame never waits on.
  // The image reads wait for nothing and nothing waits for them: both ask ComfyUI first (and the
  // status asks systemctl), which may be a minute away or never answer, and the page is ready
  // without them. A push that lands first takes the status's ticket, so the older read drops.
  probeImageStatus();
  const presetsTicket = presetsOrder.next();
  void probe("image.presets", {}).then((imagePresets) => {
    if (imagePresets === undefined || !presetsOrder.current(presetsTicket)) return;
    // A download push from before the reconnect may be stale (its server restarted, or its end missed): the list says what runs now.
    applyServerEvent({ imagePresets, ...imagePresets === NA ? {} : { imageDownload: imagePresets.download } });
  });
  const [gpu, catalog, sources, update, speeds] = await Promise.all([
    probe("gpu.status", {}),
    probe("models.catalog", {}),
    probe("sources.list", {}),
    probe("update.status", {}),
    probe("models.speed", {}),
  ]);
  applyServerEvent((s) => ({ gpu, sources, ...(updateOrder.current(updateTicket) ? { update } : {}), ...(catalogLands(catalogTicket) ? { catalog } : {}), ...speedsRead(s, speeds) }));
  release("none");
  void settingsReads.read();
  // A model's thoughts take minutes in system memory, so Thinking starts off with no GPU; the composer's button still turns it on.
  // Read after the release: a GPU push held behind gpu.status is the newer answer.
  settingsSession.seedThinking();

  const s = getState();
  if (s.view === "new" && threads.length === 0 && !firstRunDone()) setState({ view: "firstrun" });
  // Anything cached from before this connection may be out of date: other
  // threads reload on their next visit, the open one now (W-04).
  threadSession.markOtherThreadsStale(s);
  if (s.threadId !== null) await loadThread(s.threadId, true);
  flushQueued();
  // turns may have ended while the connection was down
  usageSession.usageChanged();
}

const imageOrder = newestOnly();
const presetsOrder = newestOnly();
/** The ComfyUI state the presets were last read again for. */
let presetsAt: string | undefined;
/** Image jobs that settled to another choice than they were sent with; each reads the presets again once. */
const settledJobs = new Set<string>();

/** Read the image models ComfyUI has every file for again: the picker opening, Image turning on, ComfyUI's state changing. */
export function loadImagePresets(): Promise<void> {
  const ticket = presetsOrder.next();
  return probe("image.presets", {}).then((imagePresets) => {
    if (imagePresets !== undefined && presetsOrder.current(ticket)) applyServerEvent({ imagePresets });
  });
}

const navigation = createNavigation({
  flushQueued, catchUp, chooseModel, loadThread, loading,
  settingsData: () => settingsReads.ready(),
  // usageSession is made below; this runs only on a navigation, long after
  dropPendingPanel: () => usageSession.dropPendingOpen(),
  newChatModel: (s) => decided(pickChoice(s.models, s.model, s.chosen)),
});
export const { openThread, newThread, openSettings, leaveSettings, closeSettings, toggleSettings, toggleModels, cancelPendingSettings, initialView, finishFirstRun } = navigation;
export { spareScreenEntry } from "./session/navigation.ts";
const { firstRunDone } = navigation;

const usageSession = createUsage({
  read: () => call("usage.read", { since: 0 }),
  beforeOpen: () => { if (getState().view === "settings") closeSettings(); },
  asked: () => void cancelPendingSettings(),
  enter: enterScreen,
  exit: exitScreen,
});
export const { openUsage, closeUsage, toggleUsage, usageData } = usageSession;

/** Back left a screen's history entry: close the screen it was made for. */
export function onScreenPop(): void {
  if (onScreenEntry()) return;
  const s = getState();
  if (s.panel !== null) usageSession.closeUsage(true, true);
  if (s.view === "settings") closeSettings();
}

/** The running turns this load would have to stop; none when the server cannot say, and the send goes as it always did. */
async function blockingFor(model: string, numCtx: number): Promise<readonly BlockingTurn[]> {
  return call("turns.blocking", { model, numCtx }).catch(() => []);
}

/** A settings save rechecks image status with the same receipt guard as explicit probes. */
function probeImageStatus(): void {
  const ticket = imageOrder.next();
  void probe("image.status", {}).then((imageStatus) => {
    if (imageStatus !== undefined && imageOrder.current(ticket)) applyServerEvent({ imageStatus });
  });
}

/** Settings › Tools: Run commands says Ready only after the server's sandbox probe ran a command. */
export function checkShell(): void {
  void probe("tools.shell", {}).then((shellStatus) => {
    if (shellStatus !== undefined) applyServerEvent({ shellStatus });
  });
}

/** Ask ComfyUI again, so Settings says what it finds now. */
export async function checkImageStatus(): Promise<ActionResult> {
  const ticket = imageOrder.next();
  const r = await act("image.status", {}, "check ComfyUI");
  if (!r.ok) return r.message;
  if (imageOrder.current(ticket)) applyServerEvent({ imageStatus: r.value });
  return null;
}

export async function retryImage(threadId: string, prompt: string, retryOf: string): Promise<{ jobId: string } | string> {
  const result = await act("image.generate", { threadId, prompt, retryOf }, "make the image");
  if (!result.ok) return result.message;
  applyServerEvent(() => { imageSaved(threadId); });
  return result.value;
}

export async function cancelImage(jobId: string): Promise<ActionResult> {
  const result = await act("image.cancel", { jobId }, "cancel the image");
  return result.ok ? null : result.message;
}

/**
 * The picker's pick: the open thread sends with it from now on (other threads keep theirs), and it
 * is the app's last pick, which a new thread starts from and its first send carries.
 */
export async function pickImage(choice: ImageChoice): Promise<ActionResult> {
  const s = getState();
  const threadId = s.view === "thread" ? s.threadId : null;
  if (threadId !== null) {
    const r = await act("threads.setImageChoice", { threadId, choice }, "save the image model");
    if (!r.ok) return r.message;
    applyServerEvent((st) => ({ threads: st.threads.map((t) => (t.id === r.value.id ? r.value : t)) }));
  }
  // the phone cannot write Settings: its pick is the thread's alone, or the new thread's until its first send
  if (getState().unavailable["settings.update"] === true) {
    if (threadId === null) applyServerEvent({ imagePick: choice });
    return null;
  }
  return updateSettings({ imageChoice: choice });
}

/** The picker's image actions say the server's own words (they are written to be shown), the connection's when it failed. */
async function imageAct<T>(what: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try { return { ok: true, value: await run() }; }
  catch (e) {
    const code = codeOf(e);
    return { ok: false, message: code.startsWith("image") && e instanceof Error ? e.message : failure(what, e) };
  }
}

/** Fetch the files a setup needs into ComfyUI's folders; its row shows the download at once, then each image.download push. */
export async function downloadImageSetup(preset: string): Promise<ActionResult> {
  const placeholder = { name: preset, preset, file: 1, files: 1, state: "queued" as const, completedBytes: 0 };
  applyServerEvent({ imageDownload: placeholder });
  const r = await imageAct("download the image setup", () => call("image.download", { preset }));
  // a push since has the say; the placeholder alone goes when the download did not start
  if (!r.ok || r.value.files.length === 0) applyServerEvent((s) => s.imageDownload === placeholder ? { imageDownload: undefined } : {});
  if (!r.ok) return r.message;
  if (r.value.files.length === 0) void loadImagePresets();
  return null;
}

export async function stopImageDownload(preset: string): Promise<ActionResult> {
  const r = await imageAct("stop the download", () => call("image.stopDownload", { preset }));
  if (!r.ok) return r.message;
  // nothing of this setup's runs (it ended, or the server restarted): its bar goes and the list says what is there
  if (!r.value.stopped) {
    applyServerEvent((s) => s.imageDownload?.preset === preset ? { imageDownload: undefined } : {});
    void loadImagePresets();
  }
  return null;
}

/** The empty picker's Start ComfyUI (or Check again): starts the app's ComfyUI if it has one, then reads its list. */
export async function startImage(): Promise<ActionResult> {
  const ticket = presetsOrder.next();
  const r = await imageAct("start ComfyUI", () => call("image.start", {}));
  if (!r.ok) return r.message;
  if (presetsOrder.current(ticket)) applyServerEvent({ imagePresets: r.value });
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
