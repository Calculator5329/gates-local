// The connection to the Gates Local server and every action the UI takes.
// One WebSocket through createClient; it reconnects after a drop and fetches
// state again. Methods the server answers "not-implemented" are recorded as
// NA so the UI can hide them or say "Not available in this build".
import {
  type Channel,
  type Client,
  type BlockingTurn,
  type Payload,
} from "@gates-local/contracts";
import { modelChoice as pickChoice, newestOnly } from "./pick.ts";
import { NA, type State, getState, setState } from "./store.ts";
import { createChat } from "./session/chat.ts";
import { createServerState } from "./session/server-state.ts";
import { createSettings } from "./session/settings.ts";
import { chooseModel, createModels, decided, modelChoice, reconcilePulls, settlePulls } from "./session/models.ts";
import { createFit, staleFitReports, staleFitStatus } from "./session/fit.ts";
import { createThreads, sortThreads, withMessage } from "./session/threads.ts";
import { applyTextSize, applyTheme, serverUrl, webServerUrl } from "./session/platform.ts";
import { createNavigation } from "./session/navigation.ts";
import { createUpdates } from "./session/updates.ts";
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
  beforeDisconnect: () => markFitsStale(),
  afterDisconnect: () => {
    settingsSession.disconnected();
    lostTurn();
  },
});
export const { connect, call, libraryRequest } = connection;
const { probe, act } = connection;
const updatesSession = createUpdates({ applyServerEvent, act });
export const { checkForUpdates, downloadUpdate, dismissUpdateResult, updateAndRestart } = updatesSession;
const { updateOrder } = updatesSession;

const threadSession = createThreads({ applyServerEvent,
  call, codeOf, failure,
  openThread: (threadId) => openThread(threadId), newThread: () => newThread(),
  navigationGeneration: () => navigation.generation,
  pendingSettings: () => navigation.pendingSettings,
});
export const { reloadThread, renameThread, deleteThread, waitForThreadDeletion, preloadThread } = threadSession;
const { noteMessage, loadThread, restoreSaved, loading, createThread, untrackedDone, imageSaved } = threadSession;

const fitSession = createFit({ applyServerEvent, call, blockingFor, isStopped: () => connection.stopped });
export const { currentFit, fitIsCurrent, ensureFit } = fitSession;
const { markFitsStale, invalidateFits } = fitSession;

const chat = createChat({ applyServerEvent,
  call, codeOf,
  createThread,
  creatingDraft: threadSession.creatingDraft,
  loadThread,
  loading,
  noteMessage, withMessage,
  untrackedDone,
  openThread: (threadId) => openThread(threadId), blockingFor, invalidateFits,
});
export const { send, confirmStopAsk, stop, retry, sendQueuedNow, cancelQueuedEdit } = chat;
const { onChatEvent, lostTurn, catchUp, activeTurns, flushQueued } = chat;

const modelsSession = createModels({ applyServerEvent,
  call, probe, act, isNA, restoreSaved, invalidateFits, flushQueued,
  blockingFor,
});
export const { refreshModels, pickModel, pull, cancelPull, removeModel, recheckRuntime } = modelsSession;
const { modelsOrder, runtimeOrder, catalogOrder, catalogLands } = modelsSession;

const settingsSession = createSettings({ applyServerEvent, authority: applyServerEvent.settings, sync: () => connection.sync, act, applyTheme, applyTextSize, refreshImageStatus: probeImageStatus });
export const { setContext, updateSettings, updateModelSettings, resetSettings } = settingsSession;
const { settingsPatch } = settingsSession;

// ---------------------------------------------------------------- hydrate and pushes

/** Channels whose snapshot the second hydrate batch reads (gpu.status, sources.list, image.status). */
const SECOND_BATCH: ReadonlySet<Channel> = new Set<Channel>(["gpu.changed", "sources.changed", "image.status", "update.changed"]);

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
  }));
  try {
    await hydrateWith(on, release, c.negotiate);
  } finally {
    settingsSession.releasePresentation();
    release("none");
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
  on("gpu.changed", fitSession.gpuChanged);
  on("models.pull", modelsSession.pullChanged);
  on("models.load", modelsSession.loadChanged);
  on("sources.changed", (sources) => applyServerEvent({ sources }));
  on("update.changed", updatesSession.receiveUpdate);
  on("image.event", (e) => {
    if (e.threadId !== undefined) imageSaved(e.threadId);
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
  markFitsStale();
  const settings = settingsSession.endHydration(snapshot);
  settingsSession.noteVoiceSnapshot(settings);
  applyServerEvent((s) => {
    const withSettings = settings === NA || settings === undefined ? { settings } : settingsPatch(s, settings, true);
    const ordered = threadSession.listOrder.current(listTicket) ? sortThreads(threads) : s.threads;
    const next: State = { ...s, runtime: runtime ?? s.runtime, models: models ?? s.models, pulls: settlePulls(reconcilePulls(s.pulls, pendingPulls), models ?? s.models), threads: ordered, ...activeTurns(s, active), fits: { ...s.fits }, staleFits: staleFitReports(s), fitStatus: staleFitStatus(s), ...withSettings };
    return { ...next, ...decided(modelChoice(next)) };
  });
  if (settings !== NA && settings !== undefined) settingsSession.seedContext();
  ensureFit(getState().model, getState().numCtx);
  restoreSaved();
  applyTheme(settings === NA || settings === undefined ? "system" : settings.theme);
  applyTextSize(settings === NA || settings === undefined ? undefined : settings.textSize);
  // the pushes that came during the first batch, in order, in this same task
  release(SECOND_BATCH);

  const catalogTicket = catalogOrder.next();
  const updateTicket = updateOrder.next();
  // update.status reads local files; the desktop server owns automatic checks.
  const [gpu, catalog, sources, imageStatus, update] = await Promise.all([
    probe("gpu.status", {}),
    probe("models.catalog", {}),
    probe("sources.list", {}),
    probe("image.status", {}),
    probe("update.status", {}),
  ]);
  applyServerEvent({ gpu, sources, imageStatus, ...(updateOrder.current(updateTicket) ? { update } : {}), ...(catalogLands(catalogTicket) ? { catalog } : {}) });
  release("none");
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
}

const imageOrder = newestOnly();

const navigation = createNavigation({
  flushQueued, catchUp, chooseModel, loadThread, loading,
  newChatModel: (s) => decided(pickChoice(s.models, s.model, undefined)),
});
export const { openThread, newThread, openSettings, leaveSettings, cancelPendingSettings, initialView, finishFirstRun } = navigation;
const { firstRunDone } = navigation;

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
