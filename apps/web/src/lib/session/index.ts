// The connection to the Gates Local server and every action the UI takes.
// One WebSocket through createClient; it reconnects after a drop and fetches
// state again. Methods the server answers "not-implemented" are recorded as
// NA so the UI can hide them or say "Not available in this build".
import {
  type Channel,
  type Client,
  type BlockingTurn,
  type ImageChoice,
  type ImageSetupProgress,
  type ModelMeasure,
  type Payload,
  type SyncMetadata,
  type SyncRow,
  PROTOCOL_VERSION,
  methodSync,
  pushSync,
} from "@gates-local/contracts";
import { runPages } from "../../measure/measure-pages.ts";
import { imagesUnset, runKey } from "../../image/image-choice.ts";
import { closePop } from "../ui/ui.tsx";
import { NA, type State, getState, overChat, setState } from "../store/store.ts";
import { createChat } from "../../composer/chat.ts";
import { KEEP_EVERY_MS, keepHeldFiles, setFileCalls } from "../../composer/file-holds.ts";
import { createServerState } from "./server-state.ts";
import { createSettings } from "../../settings/settings.ts";
import { CATALOG, RUNTIME, answered, chooseModel, createModels, decided, memoryChanged, modelChoice, newChatModel, reconcilePulls, residentChat, settlePulls } from "../../models/models.ts";
import { createThreads, withMessage } from "../../thread/threads.ts";
import { applyAccent, applyTheme, dataFolder, serverUrl, webServerUrl } from "./platform.ts";
import { createSettingsReads } from "../../settings/settings-reads.ts";
import { createNavigation, enterScreen, exitScreen, onScreenEntry } from "../../app/navigation.ts";
import { createUpdates } from "../../updates/updates.ts";
import { speedsChanged, speedsRead } from "../../models/speed.ts";
import { measureRefused, measureStarted, measuresChanged, measuresRead, measuringChanged } from "../../measure/measures.ts";
import { setPageReads } from "../../pages/pages.ts";
import { createUsage } from "../../usage/usage.ts";
import { createPictures } from "../../pictures/pictures.ts";
import { type ActionResult, codeOf, createConnection, failure, isNA } from "./connection.ts";

// Preserve the UI's action imports while implementation moves into session modules.
export { threadMarkdown } from "../../thread/threads.ts";
export { sendsBeforeReady, firstPull, cancelStopAsk, canRetry, removeQueued, editQueued, editedElsewhere, chooseForQueued } from "../../composer/chat.ts";
export { type ActionCall, type ActionResult, failure, isNA } from "./connection.ts";
export { fileUrl, dataFolder, openDataFolder, canOpenFolder, canUpdateHere, canShowUpdate, showUpdate, folderDialog } from "./platform.ts";
export { threadFromHash } from "../../app/navigation.ts";

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
const { probe, act, reply } = connection;
setFileCalls(call);
let keeping: ReturnType<typeof setInterval> | undefined;

// Every kind arrives numbered: an answer or a push applies when its number is newer than the one
// the window last applied, in whatever order they come.
const ordering = applyServerEvent.ordering;
function rowOf(row: SyncRow | undefined): SyncRow {
  if (row === undefined) throw new Error("This channel or method is not one of an ordered kind.");
  return row;
}
const LIBRARY = rowOf(methodSync("sources.list"));
const IMPORTS = rowOf(methodSync("sources.imports"));
const UPDATE = rowOf(methodSync("update.status"));
const newer = (row: SyncRow, sync: SyncMetadata | undefined) => ordering.accept(row, sync);
const onArrival = (row: SyncRow, apply: () => void) => (sync: SyncMetadata | undefined) => { if (ordering.accept(row, sync)) apply(); };
/**
 * A read the hydrate's batch applies together with the others (the runtime dot and the chosen model
 * in one render): its number is taken as it arrives, so an older push after it is dropped, and the
 * batch applies it only while nothing newer landed since.
 */
function batched(row: SyncRow) {
  let sync: SyncMetadata | undefined;
  let took = false;
  return {
    arrived(metadata: SyncMetadata | undefined, take = true) {
      sync = metadata;
      took = take && ordering.accept(row, metadata);
    },
    lands: () => took && ordering.newest(row, sync),
  };
}
const MEMORY = rowOf(methodSync("memory.status"));
const SUGGESTED = rowOf(methodSync("models.suggested"));
const PULLS = rowOf(methodSync("models.pulls"));
const GPU = rowOf(methodSync("gpu.status"));
const FIT_TABLE = rowOf(methodSync("fit.table"));
const SPEEDS = rowOf(methodSync("models.speed"));
const MEASURES = rowOf(methodSync("models.measures"));
const IMAGE_STATUS = rowOf(methodSync("image.status"));
const IMAGE_PRESETS = rowOf(pushSync("image.presets"));
const IMAGE_DOWNLOAD = rowOf(pushSync("image.download"));
const IMAGE_SETUP = rowOf(pushSync("image.setup"));

/** The samples and imports Library shows. Its pushes keep them current; this read is the hydrate's one. */
const readImports = () => probe("sources.imports", {}, { onResult: (sourceImports, sync) => { if (newer(IMPORTS, sync)) applyServerEvent({ sourceImports }); } })
  .then((answer) => { if (answer === NA) applyServerEvent({ sourceImports: NA }); });
/** The data folder does not change while the window is open: one read from the desktop bridge, kept in the store. */
let folderRead: Promise<void> | undefined;
const readFolder = () => folderRead ??= dataFolder().then((folder) => { setState({ dataFolder: folder }); }, () => { folderRead = undefined; });
export const settingsReads = createSettingsReads({ readImports, readFolder, readSetup: () => loadImageSetup() });
/** Library's Retry after the samples could not be read: the placeholder while the read goes again. */
export const retryImports = () => { applyServerEvent({ sourceImports: undefined }); return readImports(); };
const updatesSession = createUpdates({ applyServerEvent, act, newer: sync => newer(UPDATE, sync) });
export const { checkForUpdates, downloadUpdate, dismissUpdateResult, readUpdateStatus, updateAndRestart } = updatesSession;

const threadSession = createThreads({ applyServerEvent,
  call, codeOf, failure,
  openThread: (threadId) => openThread(threadId), newThread: () => newThread(),
  navigationGeneration: () => navigation.generation,
  pendingSettings: () => navigation.pendingSettings,
});
export const { reloadThread, renameThread, deleteThread, waitForThreadDeletion, preloadThread, loadEarlier, earlierOf, onEarlier } = threadSession;
const { noteMessage, rowsSaved, loadThread, restoreSaved, loading, createThread, untrackedDone, imageSaved } = threadSession;


const chat = createChat({ applyServerEvent,
  reply, codeOf,
  createThread,
  creatingDraft: threadSession.creatingDraft,
  loadThread,
  loading,
  noteMessage, rowsSaved, withMessage,
  untrackedDone,
  openThread: (threadId) => openThread(threadId), blockingFor,
});
export const { send, confirmStopAsk, stop, retry, sendQueuedNow, cancelQueuedEdit } = chat;
const { onWords, lostTurn, catchUp, connected, recordChanged, replyListed, editEnded } = chat;

const modelsSession = createModels({ applyServerEvent,
  call, probe, act, isNA, restoreSaved,
  blockingFor, newer,
});
export const { refreshModels, pickModel, typedInComposer, pull, cancelPull, removeModel, recheckRuntime } = modelsSession;
/** A typed name's size and fit before its download; undefined when the server cannot say. */
export const estimateModel = (name: string, numCtx: number) => call("models.estimate", { name, numCtx }).catch(() => undefined);

const settingsSession = createSettings({ applyServerEvent, authority: applyServerEvent.settings, sync: () => connection.sync, act, applyTheme, applyAccent });
export const { setContext, updateSettings, updateModelSettings, resetSettings } = settingsSession;
const { settingsPatch } = settingsSession;

async function hydrate(c: Client): Promise<void> {
  settingsSession.beginHydration();
  const on = <C extends Channel>(channel: C, handler: (p: Payload<C>) => void) =>
    c.subscribe(channel, (p) => applyServerEvent(() => handler(p)));
  // why: one sent before this socket's negotiation has no number; the reads after it are newer
  const numbered = <C extends Channel>(channel: C, apply: (p: Payload<C>) => void) => {
    const row = rowOf(pushSync(channel));
    c.subscribe(channel, (p, sync) => applyServerEvent(() => { if (ordering.accept(row, sync)) apply(p); }));
  };
  numbered("sources.changed", (sources) => applyServerEvent({ sources }));
  numbered("sources.imports", (sourceImports) => applyServerEvent({ sourceImports }));
  numbered("update.changed", updatesSession.receiveUpdate);
  numbered("runtime.changed", modelsSession.runtimeChanged);
  numbered("models.changed", modelsSession.modelsChanged);
  // A newer chat list arrived with the update check: its makers and names, then the catalog it changes.
  numbered("models.suggested", (suggested) => { applyServerEvent({ suggested }); void modelsSession.refreshCatalog(); });
  numbered("gpu.changed", (gpu) => {
    const was = getState().gpu;
    const before = was === undefined || was === NA ? undefined : was.vendor;
    applyServerEvent({ gpu });
    // What Set up images would fetch depends on the card, and nothing pushes it: a card put in or
    // taken out is read once, when the server first sees it.
    if (before !== undefined && before !== gpu.vendor) void loadImageSetup();
  });
  numbered("fit.changed", (fitTable) => applyServerEvent({ fitTable }));
  numbered("models.pull", modelsSession.pullChanged);
  numbered("models.load", modelsSession.loadChanged);
  numbered("memory.changed", memoryChanged);
  numbered("models.speed", (list) => applyServerEvent((s) => speedsChanged(s, list)));
  numbered("models.measures", (list) => {
    applyServerEvent(measuresChanged(list));
    runMeasurePages(list);
  });
  numbered("models.measuring", (run) => applyServerEvent((s) => measuringChanged(s, run)));
  c.subscribe("settings.changed", (payload, metadata) => applyServerEvent(() => settingsSession.receiveSettings(payload, metadata)));
  // The server sends the presets to every window whenever they change (ComfyUI's state, a job
  // settling to other files, a download, image settings), so no window reads them again for that.
  numbered("image.status", (imageStatus) => applyServerEvent({ imageStatus }));
  numbered("image.presets", (imagePresets) => applyServerEvent({ imagePresets }));
  numbered("image.event", (e) => {
    if (e.threadId !== undefined) imageSaved(e.threadId);
    if (e.state !== "done") return;
    void pictures.finished();
    // the newest picture of its setup and size: its time is the count menu's from here on
    if (e.runMs !== undefined && e.choice !== undefined) {
      const key = runKey(e.choice), ms = e.runMs;
      applyServerEvent((s) => ({ imageRuns: { ...s.imageRuns, [key]: ms } }));
    }
  });
  numbered("image.download", (imageDownload) => applyServerEvent({ imageDownload }));
  numbered("image.setup", setupSaid);
  c.subscribe("threads.changed", (p, sync) => applyServerEvent(() => threadSession.rowPushed(p, sync)));
  settingsReads.begin();
  // the bridge answers without the server, so the folder is in even when the hydrate never reaches its reads
  void readFolder();
  try {
    await hydrateWith(on, c.negotiate);
  } finally {
    settingsSession.releasePresentation();
    settingsReads.end();
  }
  // Chat row 35: the files this window's drafts and queue name stay on the server past a day.
  void keepHeldFiles();
  // oxlint-disable-next-line gates/timer-needs-reason -- the server forgets an unsent file after a day; every six hours this window says again which ones its drafts and queue still hold
  keeping ??= setInterval(() => void keepHeldFiles(), KEEP_EVERY_MS);
}

async function hydrateWith(
  on: <C extends Channel>(channel: C, handler: (p: Payload<C>) => void) => void,
  negotiate: Client["negotiate"],
): Promise<void> {
  // why: what this window holds of the records is from before this connection, until its list
  connected();
  on("reply.words", onWords);
  on("reply.changed", (change) => recordChanged(change));
  on("usage.changed", () => usageSession.usageChanged());
  const negotiated = await negotiate();
  if (negotiated.protocol !== undefined && negotiated.protocol !== PROTOCOL_VERSION) setState({ outdated: true });
  settingsSession.ready();
  threadSession.connected(negotiated.epoch);

  // settings.get is a local store read and the model choice needs only it and
  // the model list, so the runtime dot and a chosen model land in one render:
  // a message typed the moment the dot turns ready sends. gpu.status and the
  // catalog can take a few hundred ms and follow. Each of the models kind's
  // reads takes its number as it lands, and the batch applies it only while it
  // is still the newest: one that lands after a newer push is dropped.
  const statusRead = batched(RUNTIME);
  const listRuntime = batched(RUNTIME);
  const listModels = batched(rowOf(methodSync("models.list")));
  const suggestedRead = batched(SUGGESTED);
  const memoryRead = batched(MEMORY);
  const [status, listed, threads, snapshot, pendingPulls, suggested, memory, replies] = await Promise.all([
    call("runtime.status", {}, { onResult: (_, sync) => statusRead.arrived(sync) }),
    // The list's runtime is the one it was read beside; the newer of it and the status shows.
    // Its models say what is installed only beside a ready runtime (answered).
    call("models.list", {}, { onResult: (list, sync) => { listRuntime.arrived(sync); listModels.arrived(sync, answered(list.runtime)); } }).catch(() => undefined),
    // The list applies as it lands, keeping a row pushed after it was read.
    call("threads.list", {}, { onResult: threadSession.listArrived }),
    // why: a refused settings read fails the bootstrap, so its retry backs off instead of resetting
    call("settings.get", {}, { onResult: settingsSession.acceptSettings }),
    // Every download's progress, a whole the models.pull pushes are parts of: it applies as it
    // lands, so a newer push after it applies on top.
    probe("models.pulls", {}, { onResult: (pending, sync) => onArrival(PULLS, () => applyServerEvent((s) => ({ pulls: reconcilePulls(s.pulls, pending) })))(sync) }),
    // The makers and example names come with the models, so a maker mark never draws "?" first.
    probe("models.suggested", {}, { onResult: (_, sync) => suggestedRead.arrived(sync) }),
    // What is in memory: a new chat's button starts on its chat model (memory.changed keeps it current).
    probe("memory.status", {}, { onResult: (_, sync) => memoryRead.arrived(sync) }),
    probe("reply.list", {}),
  ]);
  // a list read while no Ollama answered says nothing: the store keeps what it had
  const models = listed !== undefined && answered(listed.runtime) && listModels.lands() ? listed.models : undefined;
  const runtime = statusRead.lands() ? status : listed !== undefined && listRuntime.lands() ? listed.runtime : undefined;
  const settings = settingsSession.endHydration(snapshot);
  applyServerEvent((s) => {
    const withSettings = settings === NA || settings === undefined ? { settings } : settingsPatch(s, settings, true);
    const held = memory === NA || memory === undefined || !memoryRead.lands() ? {} : { memory, ...(s.threadId === null && !s.newChatPicked ? { newChatResident: residentChat({ memory }) } : {}) };
    const pulls = pendingPulls === NA ? reconcilePulls(s.pulls, pendingPulls) : s.pulls;
    const next: State = { ...s, suggested: suggestedRead.lands() || suggested === NA ? suggested ?? s.suggested : s.suggested, runtime: runtime ?? s.runtime, models: models ?? s.models, pulls: settlePulls(pulls, models ?? s.models), ...withSettings, ...held };
    return { ...next, ...decided(modelChoice(next)) };
  });
  if (settings !== NA && settings !== undefined) settingsSession.seedContext();
  if (replies !== undefined && replies !== NA) replyListed(replies);
  restoreSaved();
  applyTheme(settings === NA || settings === undefined ? "system" : settings.theme);
  applyAccent(settings === NA || settings === undefined ? undefined : settings.accent);

  // The fit table waits for nothing and nothing waits for it: until it lands every fit value is a
  // skeleton, and of it and a pushed table the newer number wins whichever arrives first. A closed
  // connection rejects its unanswered calls, so nothing it asked for lands after the disconnect
  // has withdrawn the table.
  void probe("fit.table", {}, { onResult: (fitTable, sync) => { if (newer(FIT_TABLE, sync)) applyServerEvent({ fitTable }); } });
  // Settings › Tools opens with Run commands' own word: the sandbox probe runs now, not on the first
  // visit, so the row never says Checking and then changes its words (nothing arrives late).
  checkShell();
  // update.status reads local files; the desktop server owns automatic checks.
  // Measured speeds are a saved-reply read the model list's first frame never waits on.
  // The image reads wait for nothing and nothing waits for them: both ask ComfyUI first (and the
  // status asks systemctl), which may be a minute away or never answer, and the page is ready
  // without them. Each read takes its numbers as it starts, so a push that lands first is newer and
  // the read's older value is dropped.
  probeImageStatus();
  // The list carries the download running now: a download push from before the reconnect may be
  // stale (its server restarted, or its end was missed), and the read's number says whether it is.
  void probe("image.presets", {}, { onResult: (imagePresets, sync) => applyServerEvent(() => {
    if (newer(IMAGE_PRESETS, sync)) applyServerEvent({ imagePresets });
    if (newer(IMAGE_DOWNLOAD, sync)) applyServerEvent({ imageDownload: imagePresets.download });
  }) }).then((imagePresets) => { if (imagePresets === NA) applyServerEvent({ imagePresets }); });
  const [gpu, catalog, , update, speeds, measures] = await Promise.all([
    probe("gpu.status", {}, { onResult: (read, sync) => onArrival(GPU, () => applyServerEvent({ gpu: read }))(sync) }),
    probe("models.catalog", {}, { onResult: (read, sync) => onArrival(CATALOG, () => applyServerEvent({ catalog: read }))(sync) }),
    probe("sources.list", {}, { onResult: (list, sync) => onArrival(LIBRARY, () => applyServerEvent({ sources: list }))(sync) }),
    probe("update.status", {}, { onResult: (read, sync) => onArrival(UPDATE, () => applyServerEvent({ update: read }))(sync) }),
    probe("models.speed", {}, { onResult: (read, sync) => onArrival(SPEEDS, () => applyServerEvent((s) => speedsRead(s, read)))(sync) }),
    probe("models.measures", {}, { onResult: (read, sync) => onArrival(MEASURES, () => applyServerEvent(measuresRead(read)))(sync) }),
  ]);
  // Each read applied itself on arrival; only "this build cannot say" is left for the batch.
  applyServerEvent((s) => ({
    ...(gpu === NA ? { gpu } : {}), ...(update === NA ? { update } : {}),
    ...(catalog === NA ? { catalog } : {}), ...(speeds === NA ? speedsRead(s, speeds) : {}), ...(measures === NA ? measuresRead(measures) : {}),
  }));
  if (measures !== undefined && measures !== NA) runMeasurePages(measures.measures);
  void settingsReads.read();
  // A model's thoughts take minutes in system memory, so Thinking starts off with no GPU; the composer's button still turns it on.
  settingsSession.seedThinking();

  const s = getState();
  if (s.view === "new" && threads.length === 0 && !firstRunDone()) setState({ view: "firstrun" });
  // A chat cached from before this connection is read again only if its number moved (after the
  // server restarted, every one has): the open one now, the others on their next visit (W-04).
  if (s.threadId !== null) await loadThread(s.threadId);
  // turns may have ended while the connection was down
  usageSession.usageChanged();
}

/**
 * A Set up images step. At its end the server has started the engine it set up and pushed the status
 * and the list; an open "not set up" card closes and Image turns on, as its Check again does. What the
 * setup would fetch changed with it (the engine is in), and nothing pushes that, so it is read once.
 */
function setupSaid(progress: ImageSetupProgress): void {
  applyServerEvent((s) => ({ imageSetup: { ...s.imageSetup, progress } }));
  if (progress.step !== "done" && progress.step !== "error") return;
  if (progress.step === "done" && getState().pop?.id === "unset" && !imagesUnset(getState())) { closePop(); setState({ image: true }); }
  void loadImageSetup();
}

/** The Pictures screen's list and selection (session/pictures.ts). */
export const pictures = createPictures({ list: (params) => call("pictures.list", params) });

const navigation = createNavigation({
  editEnded, catchUp, chooseModel, loadThread, loading,
  settingsData: () => settingsReads.ready(),
  picturesData: () => pictures.enter(),
  // usageSession is made below; this runs only on a navigation, long after
  dropPendingPanel: () => usageSession.dropPendingOpen(),
  newChatModel,
  // Tools asks the sandbox probe each time it shows: the server keeps a passed probe and asks a failed one again
  sectionShown: (section) => { if (section === "tools") checkShell(); },
});
export const { openThread, newThread, openSettings, leaveSettings, closeSettings, toggleSettings, toggleModels, cancelPendingSettings, initialView, finishFirstRun, leavePictures, togglePictures } = navigation;
export { spareScreenEntry } from "../../app/navigation.ts";
const { firstRunDone } = navigation;

const usageSession = createUsage({
  read: () => call("usage.read", { since: 0 }),
  beforeOpen: () => { if (overChat(getState().view)) closeSettings(); },
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
  if (overChat(s.view)) closeSettings();
}

/** The running turns this load would have to stop; none when the server cannot say, and the send goes as it always did. */
async function blockingFor(model: string, numCtx: number): Promise<readonly BlockingTurn[]> {
  return call("turns.blocking", { model, numCtx }).catch(() => []);
}

/** The hydrate's engine status: it applies only while no newer push came. */
function probeImageStatus(): void {
  void probe("image.status", {}, { onResult: (imageStatus, sync) => { if (newer(IMAGE_STATUS, sync)) applyServerEvent({ imageStatus }); } })
    .then((imageStatus) => { if (imageStatus === NA) applyServerEvent({ imageStatus }); });
}

/** Settings › Tools: Run commands says Ready only after the server's sandbox probe ran a command. Windows has no such sandbox, and Tools says so itself. */
export function checkShell(): void {
  if (/\bWindows\b/.test(globalThis.navigator?.userAgent ?? "")) return;
  void probe("tools.shell", {}).then((shellStatus) => {
    if (shellStatus !== undefined) applyServerEvent({ shellStatus });
  });
}

/** Ask ComfyUI again, so Settings says what it finds now. */
export async function checkImageStatus(): Promise<ActionResult> {
  const r = await act("image.status", {}, "check ComfyUI", undefined, { onResult: (imageStatus, sync) => { if (newer(IMAGE_STATUS, sync)) applyServerEvent({ imageStatus }); } });
  return r.ok ? null : r.message;
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
    // the answer is the chat's row at the pick's number, applied as a pushed row is
    const r = await act("threads.setImageChoice", { threadId, choice }, "save the image model", undefined, { onResult: threadSession.rowAnswered });
    if (!r.ok) return r.message;
  }
  // the phone cannot write Settings: its pick is the thread's alone, or the new thread's until its first send
  if (getState().unavailable["settings.update"] === true) {
    if (threadId === null) applyServerEvent({ imagePick: choice });
    return null;
  }
  return updateSettings({ imageChoice: choice });
}

/** The count menu's pick: the open thread makes this many from now on; a new thread's first send carries it. */
export async function pickImageCount(count: number): Promise<ActionResult> {
  const s = getState();
  const threadId = s.view === "thread" ? s.threadId : null;
  if (threadId === null) {
    setState({ imageCountNew: count });
    return null;
  }
  const r = await act("threads.setImageCount", { threadId, count }, "save the picture count", undefined, { onResult: threadSession.rowAnswered });
  return r.ok ? null : r.message;
}

/**
 * A setup and size no done push has named yet: ComfyUI's time for this computer's newest picture of
 * it, read once into the store (State.imageRuns). Nothing to read when the store has one; a push
 * that lands while this reads is newer and stays. No picture (or no kept time) leaves it unset.
 */
export async function readImageRun(choice: ImageChoice): Promise<void> {
  const key = runKey(choice);
  if (getState().imageRuns[key] !== undefined) return;
  try {
    const { pictures: list } = await call("pictures.list", { setup: choice.preset, limit: 20 });
    const ms = list.find((p) => p.runMs !== undefined && p.width === choice.width && p.height === choice.height)?.runMs;
    if (ms !== undefined && getState().imageRuns[key] === undefined) setState((s) => ({ imageRuns: { ...s.imageRuns, [key]: ms } }));
  } catch { /* no answer: the menu's rows show no times, as with no picture */ }
}

/** The picker's image actions say the server's own words (they are written to be shown), the connection's when it failed. */
async function imageAct<T>(what: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try { return { ok: true, value: await run() }; }
  catch (e) {
    const code = codeOf(e);
    return { ok: false, message: code.startsWith("image") && e instanceof Error ? e.message : failure(what, e) };
  }
}

/** What Set up images would fetch on this computer, or why it cannot run here. */
export async function loadImageSetup(): Promise<ActionResult> {
  // What it would fetch is a look at this computer and always applies; its step is numbered, and a
  // newer step pushed while the read was out stays.
  const r = await imageAct("read the image setup", () => call("image.setupInfo", {}, { onResult: (info, sync) => {
    const { progress: _read, ...look } = info;
    applyServerEvent((s) => ({ imageSetup: newer(IMAGE_SETUP, sync) ? info : { ...look, ...s.imageSetup?.progress === undefined ? {} : { progress: s.imageSetup.progress } } }));
  } }));
  return r.ok ? null : r.message;
}

/** Set up images: the engine, then the recommended setup, as one download; image.setup pushes say how it goes. */
export async function startImageSetup(): Promise<ActionResult> {
  const r = await imageAct("set up images", () => call("image.setup", {}));
  return r.ok ? null : r.message;
}

/** Fetch the files a setup needs into ComfyUI's folders; its row shows the download at once, then each image.download push. */
export async function downloadImageSetup(preset: string): Promise<ActionResult> {
  const placeholder = { name: preset, preset, file: 1, files: 1, state: "queued" as const, completedBytes: 0 };
  applyServerEvent({ imageDownload: placeholder });
  const r = await imageAct("download the image setup", () => call("image.download", { preset }));
  // a push since has the say; the placeholder alone goes when the download did not start
  if (!r.ok || r.value.files.length === 0) applyServerEvent((s) => s.imageDownload === placeholder ? { imageDownload: undefined } : {});
  return r.ok ? null : r.message;
}

/**
 * Settings' folder for image downloads (null clears it); the server sends the list again with that
 * folder's free space. Later downloads go there; nothing already downloaded moves.
 */
export const saveImageFolder = (folder: string | null): Promise<ActionResult> => updateSettings({ imageFolder: folder });

export async function stopImageDownload(preset: string): Promise<ActionResult> {
  const r = await imageAct("stop the download", () => call("image.stopDownload", { preset }));
  if (!r.ok) return r.message;
  // nothing of this setup's runs (it ended, or the server restarted): its bar goes
  if (!r.value.stopped) applyServerEvent((s) => s.imageDownload?.preset === preset ? { imageDownload: undefined } : {});
  return null;
}

/** The empty picker's Start ComfyUI (or Check again): starts the app's ComfyUI if it has one, then reads its list. */
export async function startImage(): Promise<ActionResult> {
  const r = await imageAct("start ComfyUI", () => call("image.start", {}, { onResult: (imagePresets, sync) => { if (newer(IMAGE_PRESETS, sync)) applyServerEvent({ imagePresets }); } }));
  return r.ok ? null : r.message;
}

const SOURCE_WORDS = { folder: "folder", file: "file", sqlite: "database" } as const;

export async function addSource(kind: "folder" | "file" | "sqlite", path: string): Promise<ActionResult> {
  if (path.trim() === "") return null;
  const r = await act("sources.add", { kind, path: path.trim() }, `add this ${SOURCE_WORDS[kind]}`, "check it and try again");
  return r.ok ? null : r.message;
}

// A long chat's page list: the pages of the replies before its loaded messages come from the server.
setPageReads({ pages: (threadId, before) => call("threads.pages", { threadId, before }), earlierOf, onEarlier });

/** Measures (model and time) whose pages this window is asking for or running now. */
const pagesHere = new Set<string>();

/**
 * A measure's page checks wait for a window to run them (measure-pages.ts). The server marks pages
 * no run waits for as skipped, so a pending page in a list is the running measure's. Any window
 * that sees them asks the server to hold them (models.measurePagesClaim): the window that started
 * the run is answered first while it is connected, else the first to ask; every other window is
 * refused and runs nothing. The holder runs them once and sends back what they showed. A holder
 * that reloads or closes lets them go and the list is pushed again, so the next window asks.
 */
function runMeasurePages(list: readonly ModelMeasure[]): void {
  const s = getState();
  if (s.unavailable["models.measurePages"] === true || s.unavailable["models.measurePagesClaim"] === true) return;
  for (const m of list) {
    const key = `${m.model}\n${m.at}`;
    if (pagesHere.has(key) || !m.checks.some((c) => c.state === "pending")) continue;
    pagesHere.add(key);
    void (async () => {
      try {
        const r = await act("models.measurePagesClaim", { model: m.model, at: m.at }, `check the pages ${m.model} wrote`);
        if (!r.ok || !r.value.claimed) return;
        const pages = await runPages(m.checks);
        await act("models.measurePages", { model: m.model, at: m.at, pages }, `check the pages ${m.model} wrote`);
      } finally {
        pagesHere.delete(key);
      }
    })();
  }
}

/** Settings › Models, Measure: starts the run; its steps and numbers arrive as pushes, a refusal shows on the row. */
export async function measureModel(name: string): Promise<void> {
  const r = await act("models.measure", { name }, `measure ${name}`);
  applyServerEvent((s) => (r.ok ? measureStarted(s, r.value) : measureRefused(s, name, r.message)));
}

export async function removeSource(id: string): Promise<ActionResult> {
  const r = await act("sources.remove", { id }, "remove this source");
  return r.ok ? null : r.message;
}

export async function refreshSource(id: string): Promise<ActionResult> {
  const r = await act("sources.refresh", { id }, "refresh this source");
  return r.ok ? null : r.message;
}
