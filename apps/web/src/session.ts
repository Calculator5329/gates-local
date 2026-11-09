// The connection to the Gates Local server and every action the UI takes.
// One WebSocket through createClient; it reconnects after a drop and fetches
// state again. Methods the server answers "not-implemented" are recorded as
// NA so the UI can hide them or say "Not available in this build".
import {
  type Channel,
  type Client,
  type ContextSize,
  type Message,
  type BlockingTurn,
  type MethodName,
  type Params,
  type Payload,
  type ResultOf,
  type Settings,
  type SettingsPatch,
  type ToolStep,
  WireError,
  createClient,
} from "@gates-local/contracts";
import { ctxFor, describeModel, k, noGpu, titleFrom } from "./format.ts";
import { type ModelDecision, choosable, firstChatPull, modelChoice as pickChoice, newestOnly, sendableModel } from "./pick.ts";
import { type LiveTurn, NA, type Queued, type Section, type State, type StopAsk, chatReady, fitKey, getState, setState, streaming, streamingHere } from "./store.ts";
import { settingsScreen } from "./screen-loaders.ts";
import { syncTitleBar } from "./titlebar.ts";

// ---------------------------------------------------------------- desktop bridge
// The preload's window.gatesLocal (apps/desktop/src/preload.ts). Declared here
// because the web app does not import the desktop package.
type BridgeState =
  | { readonly status: "ready"; readonly serverUrl: string }
  | { readonly status: "idle" | "starting" | "restarting" | "crashed" | "stopping" | "stopped" };

interface DesktopBridge {
  /** Native control colours, resolved from the page's theme tokens. */
  syncTitleBar?(colors: { color: string; symbolColor: string }): Promise<void>;
  getServerUrl(): Promise<string | null>;
  onState(listener: (state: BridgeState) => void): () => void;
  /** Starts `pnpm run app-update` and quits; missing on desktop builds from before it existed. */
  updateAndRestart?(): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** The folder the app keeps its data in; missing on desktop builds from before it existed. */
  dataFolder?(): Promise<string>;
  /** Opens that folder in the file manager; a sentence if it could not. */
  openDataFolder?(): Promise<string | null>;
}

declare global {
  interface Window {
    gatesLocal?: DesktopBridge;
    /**
     * Counters the performance spec reads. terminalFlush is that spec's
     * negative control (test/e2e/perf.spec.ts): the done event makes one
     * extra store publish of the live turn before the saved row replaces it.
     */
    glPerf?: { deltas: number; flushes: number; terminalFlush?: boolean };
  }
}

const perf: NonNullable<Window["glPerf"]> = { deltas: 0, flushes: 0 };
window.glPerf = perf;

/**
 * Where the server is: the desktop bridge, else ?server= or
 * VITE_GATES_LOCAL_SERVER, else this page's own host when the server served
 * the page (the phone listener injects the gates-local-server meta).
 */
async function serverUrl(): Promise<string | null> {
  if (window.gatesLocal) return window.gatesLocal.getServerUrl();
  return webServerUrl();
}

/** Browser configuration is synchronous, so No Server can cover the first render. */
function webServerUrl(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("server");
  const fromEnv: unknown = import.meta.env["VITE_GATES_LOCAL_SERVER"];
  const configured = fromQuery ?? (typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : null);
  if (configured !== null) return configured;
  if (document.querySelector('meta[name="gates-local-server"]')?.getAttribute("content") === "same-origin") {
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  }
  return null;
}

/** A /files/ URL on the server; the token rides along only when the socket URL had one. */
export function fileUrl(origin: string, token: string | null, path: string): string {
  return `${origin}/files/${path.split("/").map(encodeURIComponent).join("/")}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/** Resolves on the bridge's next ready state, or after ms when there is no bridge. */
function nextChance(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const bridge = window.gatesLocal;
    const timer = setTimeout(done, ms);
    const off = bridge?.onState((s) => {
      if (s.status === "ready") done();
    });
    function done() {
      clearTimeout(timer);
      off?.();
      resolve();
    }
  });
}

let client: Client | null = null;
let stopped = false;

/** Start the connection loop. Called once at boot; the returned function ends it (the session tests use it). */
export function connect(): () => void {
  stopped = false;
  if (!window.gatesLocal && webServerUrl() === null) setState({ conn: { kind: "no-server" } });
  else void loop();
  return () => {
    stopped = true;
    client?.close();
  };
}

async function loop(): Promise<void> {
  let delay = 250;
  for (;;) {
    if (stopped) return;
    const url = await serverUrl().catch(() => null);
    if (url === null) {
      if (!window.gatesLocal) return setState({ conn: { kind: "no-server" } });
      await nextChance(60_000);
      continue;
    }
    const parsed = new URL(url);
    // Image URLs follow the socket's scheme: wss gives https.
    setState({ serverOrigin: `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`, fileToken: parsed.searchParams.get("token") });
    const ws = new WebSocket(url);
    const c = createClient(ws, { onProtocolError: (e) => console.warn(`[gates-local] ${e.code}`) });
    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => resolve(true));
      ws.addEventListener("close", () => resolve(false));
    });
    if (opened && stopped) {
      c.close();
      return;
    }
    if (opened) {
      client = c;
      delay = 250;
      setState({ conn: { kind: "open" } });
      await hydrate(c).catch(() => undefined);
      await c.closed;
      client = null;
      lostTurn();
    }
    setState((s) => ({ conn: s.conn.kind === "down" ? s.conn : { kind: "down", since: Date.now() } }));
    await nextChance(delay);
    delay = Math.min(delay * 2, 4000);
  }
}

/** Call a server method; rejects with WireError("closed") while disconnected. */
export function call<M extends MethodName>(method: M, params: Params<M>): Promise<ResultOf<M>> {
  if (client === null) return Promise.reject(new WireError("closed", `not connected; ${method} not sent`));
  return client.call(method, params);
}

export const isNA = (e: unknown): boolean => e instanceof WireError && e.code === "not-implemented";
const codeOf = (e: unknown): string => (e instanceof WireError ? e.code : "internal");

/** A v2 read: its result, NA when the server lacks it, undefined on any other failure. */
async function probe<M extends MethodName>(method: M, params: Params<M>): Promise<ResultOf<M> | typeof NA | undefined> {
  try {
    return await call(method, params);
  } catch (e) {
    return isNA(e) ? NA : undefined;
  }
}

/**
 * What an action hands back to the control that ran it: null when it worked,
 * else one calm sentence saying what failed and what to do, shown beside it.
 */
export type ActionResult = string | null;

type Acted<M extends MethodName> = { readonly ok: true; readonly value: ResultOf<M> } | { readonly ok: false; readonly message: string };

/** Run an action method; NA marks it unavailable for the rest of the session. `what` completes "Couldn't …". */
async function act<M extends MethodName>(method: M, params: Params<M>, what: string, todo = "try again"): Promise<Acted<M>> {
  try {
    return { ok: true, value: await call(method, params) };
  } catch (e) {
    if (isNA(e)) setState((s) => ({ unavailable: { ...s.unavailable, [method]: true } }));
    return { ok: false, message: failure(what, e, todo) };
  }
}

/** "Couldn't <what> because <reason>; <todo>." in plain words, never the raw stack. */
export function failure(what: string, e: unknown, todo = "try again"): string {
  const code = codeOf(e);
  if (code === "closed") return `Couldn't ${what} because Gates Local isn't connected; try again once it reconnects.`;
  if (code === "timeout") return `Couldn't ${what} because Gates Local didn't answer in time; ${todo}.`;
  if (code === "not-implemented") return `Couldn't ${what} because this build can't do that yet.`;
  return `Couldn't ${what} because ${reasonOf(e instanceof Error ? e.message : String(e))}; ${todo}.`;
}

function reasonOf(message: string): string {
  if (/\bENOENT\b|no such file/i.test(message)) return "nothing is at that path";
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(message)) return "Gates Local isn't allowed to read it";
  const kind = /must be a (folder|file)/i.exec(message)?.[1];
  if (kind) return `that path is not a ${kind}`;
  if (/own data directory/i.test(message)) return "it holds Gates Local's own data";
  const short = message.replace(/^\w*Error:\s*/, "").replace(/[.\s]+$/, "");
  return `Gates Local refused it (${short.length > 120 ? `${short.slice(0, 117)}…` : short})`;
}

// ---------------------------------------------------------------- hydrate and pushes

/** Channels whose snapshot the second hydrate batch reads (gpu.status, sources.list, image.status). */
const SECOND_BATCH: ReadonlySet<Channel> = new Set<Channel>(["gpu.changed", "sources.changed", "image.status"]);

async function hydrate(c: Client): Promise<void> {
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
  const on = <C extends Channel>(channel: C, handler: (p: Payload<C>) => void) =>
    c.subscribe(channel, (p) => {
      if (held === "all" || (held !== "none" && held.has(channel))) waiting.push(() => handler(p));
      else handler(p);
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
    setState({ models });
    restoreSaved();
    chooseModel();
    invalidateFits();
    flushQueued();
    // The catalog's Installed marks follow the list: a removal or a runtime
    // switch (the app's own copy has its own models) must not leave them stale.
    void refreshCatalog();
  });
  on("threads.changed", () => void refreshThreads());
  on("settings.changed", applySettings);
  on("gpu.changed", (gpu) => {
    setState({ gpu });
    invalidateFits();
  });
  on("models.pull", (p) => {
    setState((s) => ({ pulls: { ...s.pulls, [p.name]: p } }));
    if (p.state === "done") void refreshModels();
  });
  on("models.load", (l) => {
    setState((s) => ({ loads: { ...s.loads, [l.model]: l } }));
    // a failed load may have freed what it took, so it changes memory too
    if (l.state === "ready" || l.state === "unloaded" || l.state === "error") invalidateFits();
  });
  on("sources.changed", (sources) => setState({ sources }));
  on("image.status", (imageStatus) => setState({ imageStatus }));
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
  const listTicket = threadsOrder.next();
  const [status, listed, threads, settings] = await Promise.all([
    call("runtime.status", {}),
    call("models.list", {}).catch(() => undefined),
    call("threads.list", {}),
    probe("settings.get", {}),
  ]);
  const models = modelsOrder.current(ticket) ? listed : undefined;
  const runtime = runtimeOrder.current(statusTicket) ? status : undefined;
  setState((s) => {
    const withSettings = settings === NA || settings === undefined ? { settings } : settingsPatch(s, settings, true);
    const ordered = threadsOrder.current(listTicket) ? sortThreads(threads) : s.threads;
    const next: State = { ...s, runtime: runtime ?? s.runtime, models: models ?? s.models, threads: ordered, fits: {}, ...withSettings };
    return { ...next, ...decided(modelChoice(next)) };
  });
  restoreSaved();
  applyTheme(settings === NA || settings === undefined ? "system" : settings.theme);
  applyTextSize(settings === NA || settings === undefined ? undefined : settings.textSize);
  // the pushes that came during the first batch, in order, in this same task
  release(SECOND_BATCH);

  const catalogTicket = catalogOrder.next();
  // update.status reads the .git folder and a local file; the check that
  // fetches runs only from the Check for updates button (checkForUpdates).
  const [gpu, catalog, sources, imageStatus, update] = await Promise.all([
    probe("gpu.status", {}),
    probe("models.catalog", {}),
    probe("sources.list", {}),
    probe("image.status", {}),
    probe("update.status", {}),
  ]);
  setState({ gpu, sources, imageStatus, update, ...(catalogLands(catalogTicket) ? { catalog } : {}) });
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
  for (const id of Object.keys(s.messages)) if (id !== s.threadId) stale.add(id);
  if (s.threadId !== null) await loadThread(s.threadId, true);
  flushQueued();
}

function sortThreads<T extends { updatedAt: number }>(threads: readonly T[]): T[] {
  return threads.toSorted((a, b) => b.updatedAt - a.updatedAt);
}

async function refreshThreads(): Promise<void> {
  const ticket = threadsOrder.next();
  const threads = await call("threads.list", {}).catch(() => undefined);
  if (threads === undefined || !threadsOrder.current(ticket)) return;
  setState((s) => {
    const open = s.threadId !== null && threads.some((t) => t.id === s.threadId);
    const threadModels = Object.fromEntries(Object.entries(s.threadModels).filter(([id]) => threads.some((t) => t.id === id)));
    return { threads: sortThreads(threads), threadModels, ...(s.view === "thread" && !open ? { view: "new" as const, threadId: null } : {}) };
  });
}

const modelsOrder = newestOnly();
const runtimeOrder = newestOnly();
// A catalog asked before a later models.changed describes the list before it: only the newest lands.
const catalogOrder = newestOnly();
/** Thinking is set from settings and the GPU once per page load; after that a reconnect leaves the person's choice alone. */
let thinkSeeded = false;
// A thread list asked before a newer one, or before a local create or delete, is out of date (MP5-01).
const threadsOrder = newestOnly();

/** The newest answer lands; an older one only while there is nothing to show, since the newer question may have failed (W1-02). */
const catalogLands = (ticket: number): boolean => catalogOrder.current(ticket) || getState().catalog === undefined;

async function refreshCatalog(): Promise<void> {
  if (getState().catalog === NA) return;
  const ticket = catalogOrder.next();
  const catalog = await probe("models.catalog", {});
  if (catalog !== undefined && catalogLands(ticket)) setState({ catalog });
}

export async function refreshModels(): Promise<void> {
  const ticket = modelsOrder.next();
  const models = await call("models.refresh", {}).catch(() => undefined);
  if (models === undefined || !modelsOrder.current(ticket)) return;
  setState({ models });
  restoreSaved();
  chooseModel();
  invalidateFits();
  if (getState().catalog === undefined) void refreshCatalog();
}

// The default model is not applied here: the server's pick (pick.ts) already honours it when it can chat.
function settingsPatch(_s: State, settings: Settings, first: boolean): Partial<State> {
  return {
    settings,
    ...(first ? { numCtx: settings.defaultNumCtx, ...(thinkSeeded ? {} : { think: settings.thinking }) } : {}),
    ...(!settings.imageGen ? { image: false } : {}),
  };
}

function applySettings(settings: Settings, first = false): void {
  setState((s) => settingsPatch(s, settings, first));
  applyTheme(settings.theme);
  applyTextSize(settings.textSize);
}

/** "small" or "large" on the root; the default has no attribute (styles.css --chat-fs). */
function applyTextSize(size: Settings["textSize"]): void {
  const root = document.documentElement;
  if (size === undefined || size === "default") root.removeAttribute("data-text");
  else root.setAttribute("data-text", size);
}

/** Dark or light on the root; "system" removes the attribute so the OS decides (styles.css). */
function applyTheme(theme: Settings["theme"]): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  syncTitleBar();
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

const inflight = new Set<string>();

/** Fetch the fit report for a model at a context once; the store caches it. */
export function ensureFit(model: string | undefined, numCtx: number): void {
  if (model === undefined) return;
  const key = fitKey(model, numCtx);
  const s = getState();
  if (s.fits[key] !== undefined || inflight.has(key) || !chatReady(s)) return;
  checkFit(model, numCtx, key, 0);
}

/** A failed check is asked again after this, doubling to FIT_RETRY_MAX_MS, until it answers or memory changes. */
const FIT_RETRY_MS = 2000;
const FIT_RETRY_MAX_MS = 30_000;

function checkFit(model: string, numCtx: number, key: string, failures: number): void {
  inflight.add(key);
  call("fit.check", { model, numCtx })
    .then(async (r) => {
      // the verdict never counts memory a running reply holds: refused may only mean "stop that reply first"
      const frees = r.verdict === "refuse" && (await blockingFor(model, numCtx)).length > 0;
      setState((st) => {
        const { [key]: _old, ...stopFrees } = st.stopFrees;
        return { fits: { ...st.fits, [key]: r }, stopFrees: frees ? { ...stopFrees, [key]: true as const } : stopFrees };
      });
    })
    .catch(() => {
      setState((st) => ({ fits: { ...st.fits, [key]: "error" as const } }));
      // "error" is shown, not kept: an invalidation clears it, and otherwise the check is retried
      setTimeout(() => {
        const s = getState();
        if (s.fits[key] === "error" && !inflight.has(key) && chatReady(s)) checkFit(model, numCtx, key, failures + 1);
      }, Math.min(FIT_RETRY_MAX_MS, FIT_RETRY_MS * 2 ** failures));
    })
    .finally(() => inflight.delete(key));
}

/** Memory changed (a load, a push, a finished turn): every verdict is checked again when next shown. */
function invalidateFits(): void {
  setState({ fits: {} });
}

// ---------------------------------------------------------------- threads

/** The open thread lives in the URL hash: #thread=<id>. */
export function threadFromHash(): string | null {
  const m = /^#thread=(.+)$/.exec(location.hash);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function setHash(threadId: string | null): void {
  const next = threadId === null ? " " : `#thread=${encodeURIComponent(threadId)}`;
  if (location.hash !== next.trim()) history.replaceState(null, "", threadId === null ? location.pathname + location.search : next);
}

/** Threads cached before the last reconnect: the next visit reloads them. */
const stale = new Set<string>();

/**
 * Thread loads in flight, each with the messages that reached its thread
 * after it was sent: they are newer than its snapshot and replay over it by
 * id, so a reply saved meanwhile is not lost (WF-02).
 */
const loads = new Set<{ readonly threadId: string; readonly seq: number; readonly since: Message[] }>();

/** Each thread load's ticket, in the order they were sent. */
let loadSeq = 0;
/** Per thread, the ticket of the newest load whose snapshot landed: an older load's answer, snapshot or failure, never replaces it. */
const landed = new Map<string, number>();

/** Bumped by each navigation, Settings in and out included: a thread load's failure moves the view only if none happened since it was sent (WF-03). */
let navGen = 0;
let pendingSettings: number | null = null;

/** Every destination invalidates an older deferred request. */
function beginNavigation(): number {
  pendingSettings = null;
  return ++navGen;
}

/** Escape and destinations outside the main view can dismiss a deferred request. */
export function cancelPendingSettings(): boolean {
  if (pendingSettings !== navGen) return false;
  beginNavigation();
  return true;
}

function setLoadError(threadId: string, message: string | null): void {
  if ((getState().loadErrors[threadId] ?? null) === message) return;
  setState((s) => {
    const { [threadId]: _old, ...rest } = s.loadErrors;
    return { loadErrors: message === null ? rest : { ...rest, [threadId]: message } };
  });
}

/** A message this client learned outside a thread load: the loads in flight for its thread replay it. */
function noteMessage(threadId: string, msg: Message): void {
  for (const l of loads) if (l.threadId === threadId) l.since.push(msg);
}

function upsertMessage(list: readonly Message[], msg: Message): readonly Message[] {
  const i = list.findIndex((m) => m.id === msg.id);
  return i < 0 ? [...list, msg] : list.map((m, j) => (j === i ? msg : m));
}

/** The cache with msg added to its thread, or put in place of the copy with its id. */
function withMessage(s: State, threadId: string, msg: Message): State["messages"] {
  return { ...s.messages, [threadId]: upsertMessage(s.messages[threadId] ?? [], msg) };
}

async function loadThread(threadId: string, force = false): Promise<void> {
  if (!force && getState().messages[threadId] !== undefined && !stale.has(threadId)) return;
  const nav = navGen;
  const req = { threadId, seq: ++loadSeq, since: [] as Message[] };
  loads.add(req);
  setLoadError(threadId, null);
  const older = () => req.seq < (landed.get(threadId) ?? 0);
  try {
    const { messages: snapshot } = await call("threads.get", { threadId });
    if (older()) return;
    landed.set(threadId, req.seq);
    stale.delete(threadId);
    const messages = req.since.reduce(upsertMessage, snapshot);
    setState((s) => ({
      messages: { ...s.messages, [threadId]: messages },
      ...(savedReplyFor(s.live, threadId, messages) ? { live: null } : {}),
      ...savedModel(s, threadId, messages),
    }));
    if (getState().models === undefined) unrestored.add(threadId);
    setLoadError(threadId, null);
  } catch (e) {
    if (older()) return;
    // a failure lands too: an older answer that comes after it must not clear or replace its error
    landed.set(threadId, req.seq);
    // a cached thread keeps its content; either way the open thread says why and offers Retry
    setLoadError(threadId, failure("load this conversation", e));
    // a thread that is gone leaves the screen, only while it is still on screen and nobody navigated since (Settings over it counts, loaded or still loading)
    const s = getState();
    if (codeOf(e) === "thread-not-found" && nav === navGen && pendingSettings === null && s.view === "thread" && s.threadId === threadId) setState({ view: "new", threadId: null });
  } finally {
    loads.delete(req);
  }
}

/**
 * A thread restored from storage takes the model of its latest saved reply (MP4-04), unless a
 * pick made in it this session is already recorded. A saved model that is not installed, or is
 * known not to chat (MP5-03), is not taken, and nothing is recorded: the composer keeps the
 * app's choice, which the person never made. With no model list yet, unrestored decides later.
 */
function savedModel(s: State, threadId: string, messages: State["messages"][string]): Partial<State> {
  if (s.threadModels[threadId] !== undefined || s.models === undefined) return {};
  const saved = messages.findLast((m) => m.role === "assistant" && m.model !== undefined)?.model;
  const m = s.models.find((x) => x.name === saved);
  if (m === undefined || !choosable(m)) return {};
  return { threadModels: { ...s.threadModels, [threadId]: m.name }, ...(s.threadId === threadId ? { model: m.name } : {}) };
}

/** Threads whose history landed before any model list: their saved model is decided when one lands (MP5-02). */
const unrestored = new Set<string>();

function restoreSaved(): void {
  if (unrestored.size === 0 || getState().models === undefined) return;
  const ids = [...unrestored];
  unrestored.clear();
  setState((s) => ids.reduce<Partial<State>>((acc, id) => ({ ...acc, ...savedModel({ ...s, ...acc }, id, s.messages[id] ?? []) }), {}));
}

/** Retry beside a failed load: fetch the thread again. */
export function reloadThread(threadId: string): void {
  void loadThread(threadId, true);
}

/** An ended live turn whose reply the server saved after all (it finished while the socket was down): showing both would duplicate it. */
function savedReplyFor(live: LiveTurn | null, threadId: string, messages: readonly Message[]): boolean {
  if (live === null || live.threadId !== threadId || live.end === undefined || live.userMessageId === undefined) return false;
  const i = messages.findIndex((m) => m.id === live.userMessageId);
  return i >= 0 && messages.slice(i + 1).some((m) => m.role === "assistant");
}

/** Leaving a chat ends an edit, which frees its message. After this task: flushQueued itself opens threads, and its own send starts first. */
function wakeAfterEdit(): void {
  if (getState().editingQueued !== null) queueMicrotask(flushQueued);
}

export function openThread(threadId: string): void {
  beginNavigation();
  wakeAfterEdit();
  setState((s) => {
    // Back on the model last used in this thread; a thread not yet loaded takes its saved one in loadThread.
    const model = s.threadModels[threadId] ?? s.model;
    return { view: "thread", threadId, addPage: false, ownerConfirm: false, ...leavingChat(s), ...(model === undefined ? {} : { model }) };
  });
  bringBack(threadId);
  chooseModel();
  setHash(threadId);
  void loadThread(threadId);
}

export function newThread(): void {
  beginNavigation();
  wakeAfterEdit();
  // A new chat is the app's choice again: it starts on the pick and follows it if the pick lands later (MP-05).
  setState((s) => ({ view: "new", threadId: null, chosen: undefined, ...leavingChat(s), ...decided(pickChoice(s.models, s.model, undefined)) }));
  setHash(null);
}

/** What belongs to the chat being left: its notice, its warning, and a queued message open for editing. */
function leavingChat(s: State): Partial<State> {
  return { notice: null, stopAsk: null, ...(s.editingQueued === null ? {} : { editingQueued: null, draft: "" }) };
}

export function openSettings(section?: Section, addPage = false): void {
  const nav = beginNavigation();
  const show = () => {
    if (nav !== navGen) return;
    pendingSettings = null;
    setState((s) => ({ view: "settings", section: section ?? s.section, addPage, ownerConfirm: false }));
  };
  // The visible composer must still send into its visible thread while a chunk
  // loads. Commit the navigation only when the screen (or its error) can render.
  if (settingsScreen.get().kind === "pending") {
    pendingSettings = nav;
    void settingsScreen.load().then(show);
  } else show();
}

export function leaveSettings(): void {
  beginNavigation();
  const s = getState();
  setState({ view: s.threadId !== null ? "thread" : "new" });
  // back to a thread with nothing on screen whose load failed meanwhile: try again
  const id = s.threadId;
  if (id !== null && !loading(id)) void loadThread(id);
}

function loading(threadId: string): boolean {
  return [...loads].some((l) => l.threadId === threadId);
}

export async function renameThread(threadId: string, title: string): Promise<void> {
  const t = title.trim();
  if (t === "") return;
  await call("threads.rename", { threadId, title: t }).catch(() => undefined);
}

export async function deleteThread(threadId: string): Promise<void> {
  await call("threads.delete", { threadId }).catch(() => undefined);
  threadsOrder.next();
  setState((s) => {
    const { [threadId]: _gone, ...messages } = s.messages;
    const { [threadId]: _model, ...threadModels } = s.threadModels;
    const { [threadId]: _error, ...loadErrors } = s.loadErrors;
    return { messages, threadModels, loadErrors, threads: s.threads.filter((t) => t.id !== threadId), queued: s.queued.filter((q) => q.threadId !== threadId) };
  });
  if (getState().threadId === threadId) newThread();
}

/** A thread as Markdown, for "Export as Markdown", from the messages the server just gave. */
export function threadMarkdown(threadId: string, messages: readonly Message[]): string {
  const s = getState();
  const t = s.threads.find((x) => x.id === threadId);
  const lines = [`# ${t?.title ?? "Thread"}`, ""];
  for (const m of messages) {
    lines.push(m.role === "user" ? "## You" : `## ${describeModel(m.model ?? "", catalogOf(s)).name || "Reply"}`, "", m.content, "");
  }
  return lines.join("\n");
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

// ---------------------------------------------------------------- chat

/** Whether a message typed now would wait for setup or the first download instead of sending. */
export function queueReason(s: State): "setup" | "download" | null {
  if (s.conn.kind !== "open") return null;
  if (s.runtime?.state === "installing") return "setup";
  const first = firstPull(s);
  if (s.runtime?.state === "ready" && first !== undefined) return "download";
  return null;
}

/** The download that will become the first chat model, while none is installed (an embedding model does not count). */
export function firstPull(s: State): string | undefined {
  return firstChatPull(s.models, s.pulls);
}

/** Turns started this session; each live turn carries its number (LiveTurn.gen). */
let turnGen = 0;
/**
 * Turn ids the client stopped or replaced. Until their terminal event, their
 * events reach only the live turn that still carries their id, never a newer
 * turn that is waiting for its own id (W-02).
 */
const oldTurns = new Set<string>();

/**
 * Before a live turn is replaced: its id, when known, is retired, so its late
 * events (after a reconnect its server turn may still run) never reach the
 * turn that replaces it (WF-01).
 */
function retire(live: LiveTurn | null, keepWords = true): void {
  if (live === null) return;
  if (live.turnId !== null) oldTurns.add(live.turnId);
  if (keepWords) keepStoppedWords(live);
}

/** Events that came while the live turn waited for chat.send to give its id; the answer replays them (WF-01). */
let early: Array<Payload<"chat.event">> = [];

let queueSeq = 0;

export async function send(text: string, opts: { reuseThread?: boolean } = {}): Promise<void> {
  const content = text.trim();
  const s = getState();
  if (content === "" || asking) return;
  if (s.editingQueued !== null) {
    const id = s.editingQueued;
    setState((st) => ({ queued: st.queued.map((q) => (q.id === id ? { ...q, text: content } : q)), editingQueued: null, draft: "", notice: null }));
    flushQueued();
    return;
  }
  const wait = queueReason(s) ?? (streamingHere(s) ? "reply" : null);
  if (!chatReady(s) && wait === null) return;
  const model = sendableModel(s.models, s.model);
  if (model === undefined && wait === null) return;

  const threadId = s.view === "thread" || opts.reuseThread ? s.threadId : null;
  if (wait === null) return admit({ content, model: model ?? "", threadId, keepDraft: false });
  setState({ ...settled(), draft: "", notice: null, stopAsk: null });
  const queueIn = threadId ?? (await createThread(content, model));
  if (queueIn === null) return;
  const q: Queued = { id: `q${++queueSeq}`, threadId: queueIn, text: content, at: Date.now(), waitFor: wait, ...(model === undefined ? {} : { model }) };
  setState((st) => ({ queued: [...st.queued, q] }));
}

/**
 * The live slot, cleared of a turn that has ended; a reply still being written
 * keeps it until another turn needs it. A stopped reply's words stay in its
 * chat, unless this is a Retry in that chat, which is asking to replace them.
 */
function settled(regenerating?: string): Partial<State> {
  const s = getState();
  if (streaming(s)) return {};
  retire(s.live, s.live?.threadId !== regenerating);
  return { live: null };
}

/** A new chat for this message; null, with the text back in the box, when the server does not answer. */
async function createThread(content: string, model: string | undefined): Promise<string | null> {
  try {
    const t = await call("threads.create", { title: titleFrom(content) });
    // Its history is known empty, so loadThread never runs for it: record the model it starts on here.
    const own = model === undefined ? {} : { threadModels: { ...getState().threadModels, [t.id]: model } };
    threadsOrder.next();
    setState((st) => ({ threads: sortThreads([t, ...st.threads.filter((x) => x.id !== t.id)]), messages: { ...st.messages, [t.id]: [] }, ...own }));
    openThread(t.id);
    return t.id;
  } catch {
    setState({ draft: content, notice: "The message didn't send. Gates Local isn't answering; try again in a moment." });
    return null;
  }
}

const STOP_OTHERS_KEY = "gates-local.stop-others-ok";

function stopOthersOk(): boolean {
  try {
    return localStorage.getItem(STOP_OTHERS_KEY) === "1";
  } catch {
    return false;
  }
}

/** The running turns this load would have to stop; none when the server cannot say, and the send goes as it always did. */
async function blockingFor(model: string, numCtx: number): Promise<readonly BlockingTurn[]> {
  return call("turns.blocking", { model, numCtx }).catch(() => []);
}

/** The server is being asked what a send would stop; a second Enter in that moment is the same send. */
let asking = false;

type Outgoing = Omit<StopAsk, "blocking">;

/** Every send from the person goes through here: the server says whether it would stop another chat, and the warning asks once. */
async function admit(out: Outgoing): Promise<void> {
  if (asking) return;
  asking = true;
  const blocking = await blockingFor(out.model, getState().numCtx);
  asking = false;
  if (gone(out)) return;
  if (blocking.length > 0 && !stopOthersOk()) {
    setState({ stopAsk: { ...out, blocking }, notice: null });
    return;
  }
  await launch(out, blocking.length > 0);
}

/** A Send now waits on the server and on the warning: meanwhile the person may have removed its message or opened it for editing. */
function gone(out: Outgoing): boolean {
  const s = getState();
  return out.queuedId !== undefined && (s.editingQueued === out.queuedId || !s.queued.some((q) => q.id === out.queuedId));
}

/** A queued message on its way to the server, and the ones that were ahead of it: a refused send puts it back at its place. */
interface Leaving {
  readonly q: Queued;
  readonly ahead: ReadonlySet<string>;
}

function leaving(queued: readonly Queued[], q: Queued): Leaving {
  return { q, ahead: new Set(queued.slice(0, queued.indexOf(q)).map((x) => x.id)) };
}

function putBack(queued: readonly Queued[], { q, ahead }: Leaving): Queued[] {
  const { now: _now, ...rest } = q;
  const at = queued.findLastIndex((x) => ahead.has(x.id)) + 1;
  // reply, even if it waited for setup: that wait is over, and Send now on this row is how it goes
  return [...queued.slice(0, at), { ...rest, waitFor: "reply" as const, held: true as const }, ...queued.slice(at)];
}

/** `stopTurns`: the turns a warning named and the person agreed to; without it, standing consent. */
async function launch(out: Outgoing, stopOthers: boolean, stopTurns?: readonly string[]): Promise<void> {
  if (gone(out)) return setState({ stopAsk: null });
  const { queued } = getState();
  const q = queued.find((x) => x.id === out.queuedId);
  const from = q === undefined ? undefined : leaving(queued, q);
  const slot = settled(out.regenerate === true ? (out.threadId ?? undefined) : undefined);
  setState((s) => ({
    ...slot,
    notice: null,
    stopAsk: null,
    ...(out.keepDraft ? {} : { draft: "" }),
    ...(out.queuedId === undefined ? {} : { queued: s.queued.filter((x) => x.id !== out.queuedId) }),
  }));
  const threadId = out.threadId ?? (await createThread(out.content, out.model));
  if (threadId !== null) await startTurn(threadId, out.content, out.model, { stopOthers, stopTurns, from, out });
}

/** The warning's action. `dontShowAgain` is saved only here, so a Cancel with the box ticked changes nothing. */
export function confirmStopAsk(dontShowAgain: boolean): void {
  const ask = getState().stopAsk;
  if (ask === null) return;
  if (dontShowAgain) {
    try {
      localStorage.setItem(STOP_OTHERS_KEY, "1");
    } catch {
      // private windows may refuse storage; the warning shows again next time
    }
  }
  void launch(ask, true, stopOthersOk() ? undefined : ask.blocking.flatMap((t) => t.turnId ?? []));
}

export function cancelStopAsk(): void {
  setState({ stopAsk: null });
}

/**
 * Turns still running on the server for chats not on screen, kept out of the
 * store so their words cost no render. openThread puts one back in the live
 * slot with everything it wrote meanwhile.
 */
let parked: LiveTurn[] = [];

/** The live slot is about to hold a turn in `threadId`: a reply running in another chat keeps running behind it. */
function setAside(threadId: string): void {
  const live = getState().live;
  if (live !== null && live.end === undefined && live.threadId !== threadId) {
    // its waiting words are its own, not the next turn's
    flushDeltas();
    const now = getState().live;
    if (now !== null) parked.push(now);
    return;
  }
  retire(live);
}

function bringBack(threadId: string): void {
  const i = parked.findIndex((t) => t.threadId === threadId);
  const back = parked[i];
  if (back === undefined) return;
  flushDeltas();
  parked.splice(i, 1);
  const s = getState();
  if (streaming(s) && s.live !== null) parked.push(s.live);
  else retire(s.live);
  setState({ live: back });
}

/** The server saves nothing for a reply the person stopped: its words live only in the live turn, so they move into its chat before anything takes the slot. */
function keepStoppedWords(l: LiveTurn): void {
  if (l.end?.kind !== "stopped" || l.text === "") return;
  const { threadId } = l;
  const msg: Message = { id: `stopped-${l.gen}`, threadId, role: "assistant", content: l.text, ...(l.thinking === "" ? {} : { thinking: l.thinking }), model: l.model, createdAt: Date.now() };
  const note = `Stopped after ${l.end.secs} s.`;
  setState((s) => ({ messages: withMessage(s, threadId, msg), stopNotes: { ...s.stopNotes, [msg.id]: note } }));
}

/** Sends Stop reached before the server gave them an id: the live slot that showed it may belong to another chat by the time the answer comes. */
const stoppedAtAdmission = new Set<number>();

interface TurnOptions {
  readonly stopOthers?: boolean;
  readonly stopTurns?: readonly string[] | undefined;
  /** It left the queue for this send. */
  readonly from?: Leaving | undefined;
  /** The person is waiting on it, so a reply in the way can still get the warning; queued messages that go on their own have none. */
  readonly out?: Outgoing;
}

async function startTurn(threadId: string, content: string, model: string, opts: TurnOptions = {}): Promise<void> {
  setAside(threadId);
  const s = getState();
  const gen = ++turnGen;
  setState({ live: { gen, threadId, turnId: null, model, startedAt: Date.now(), thinking: "", text: "", tools: [], pendingUser: content } });
  try {
    const r = await call("chat.send", {
      threadId,
      content,
      model,
      numCtx: s.numCtx,
      think: s.think,
      ...(s.image ? { image: true } : {}),
      ...(opts.stopOthers ? { stopOthers: true, ...(opts.stopTurns === undefined ? {} : { stopTurns: opts.stopTurns }) } : opts.out === undefined ? {} : { askFirst: true }),
    });
    const away = parked.findIndex((t) => t.gen === gen);
    if (away >= 0) {
      // the person moved on before the id came, and another chat's turn took the slot: this one runs on behind it
      parked[away] = { ...(parked[away] as LiveTurn), turnId: r.turnId, userMessageId: r.userMessage.id, pendingUser: null };
      noteMessage(threadId, r.userMessage);
      setState((st) => ({ messages: withMessage(st, threadId, r.userMessage) }));
      const theirs = early.filter((p) => p.turnId === r.turnId);
      early = early.filter((p) => p.turnId !== r.turnId);
      for (const p of theirs) onChatEvent(p);
      return;
    }
    const now = getState().live;
    const mine = now !== null && now.gen === gen;
    noteMessage(threadId, r.userMessage);
    setState((st) => ({
      messages: withMessage(st, threadId, r.userMessage),
      ...(st.live !== null && st.live.gen === gen ? { live: { ...st.live, turnId: r.turnId, userMessageId: r.userMessage.id, pendingUser: null } } : {}),
    }));
    // stopped before its id was known, or replaced by a newer turn: end it on the server too
    if (!mine || now.end !== undefined) {
      oldTurns.add(r.turnId);
      void call("chat.cancel", { turnId: r.turnId }).catch(() => undefined);
    }
    if (mine) {
      // this turn's own early events land now; any other turn's go where they would have
      replayEarly();
    } else {
      const theirs = early.filter((p) => p.turnId === r.turnId);
      early = early.filter((p) => p.turnId !== r.turnId);
      for (const p of theirs) if (p.event.type === "done") untrackedDone(p.threadId, p.event.message);
    }
  } catch (e) {
    const mine = getState().live?.gen === gen;
    parked = parked.filter((t) => t.gen !== gen);
    notSent(e, gen, threadId, content, model, opts);
    // a turn another client started meanwhile (turn-active) now streams here
    if (mine) replayEarly();
    flushQueued();
  } finally {
    stoppedAtAdmission.delete(gen);
  }
}

/**
 * chat.send was refused, so nothing was saved: the words go where the person
 * will find them, whoever holds the live slot now. A queued message goes back
 * to its place. Other words go back in the box if it is on screen and empty,
 * else on hold in their own chat's queue. A Retry's are already in the chat.
 * A reply in the way that the preflight missed gets the usual warning, when
 * the person is still there to answer it.
 */
function notSent(e: unknown, gen: number, threadId: string, content: string, model: string, { from, out }: TurnOptions): void {
  const st = getState();
  const code = codeOf(e);
  const owner = st.live?.gen === gen ? st.live : null;
  const halted = owner?.end !== undefined || stoppedAtAdmission.has(gen);
  const here = st.view === "thread" && st.threadId === threadId;
  const where = out?.regenerate === true ? null : from === undefined && here && st.draft === "" ? "box" : "queue";
  const blocking = e instanceof WireError ? e.blocking : undefined;
  // halted: the person has already said no; a message that went to the queue instead of the box would warn about words not in view
  const ask = code === "would-stop" && blocking !== undefined && out !== undefined && here && !halted && (from !== undefined || where !== "queue") ? { ...out, threadId, blocking } : null;
  const typed: Queued = { id: `q${++queueSeq}`, threadId, text: content, at: Date.now(), waitFor: "reply", model, held: true };
  const consented = ask !== null && stopOthersOk();
  setState({
    ...(owner === null ? {} : { live: halted ? { ...owner, pendingUser: null, ending: undefined } : null }),
    ...(where === "box" ? { draft: content } : {}),
    ...(where === "queue" ? { queued: from === undefined ? [...st.queued, typed] : putBack(st.queued, from) } : {}),
    ...(ask === null || consented ? {} : { stopAsk: ask, notice: null }),
    ...(ask === null && !halted ? { notice: where === "queue" && !here ? elsewhereNotice(st, threadId) : refusal(code, model, where) } : {}),
  });
  if (consented) void launch(ask, true);
  // what waited behind it does not overtake it
  else if (ask === null && from !== undefined) holdQueue(from.q.threadId);
}

function replayEarly(): void {
  const all = early;
  early = [];
  for (const p of all) onChatEvent(p);
}

function elsewhereNotice(s: State, threadId: string): string {
  const title = s.threads.find((t) => t.id === threadId)?.title;
  return `A message in ${title === undefined || title === "" ? "another chat" : `“${title}”`} didn't send. It's on hold in that chat.`;
}

/** Plain words for a refused send; `where` is where its words went (null: they were already in the chat). */
function refusal(code: string, model: string, where: "box" | "queue" | null): string {
  const name = describeModel(model, catalogOf(getState())).name;
  const back = where === null ? "" : ` Your message is back in the ${where}.`;
  switch (code) {
    case "wont-fit":
      return `${name} doesn't fit in memory at ${k(ctxFor(getState().numCtx, getState().models, model))}. Pick a smaller model or context.`;
    case "turn-active":
      return "A reply is still being written in this thread. Stop it or wait.";
    case "would-stop":
      return `Another chat's reply is using the memory ${name} needs.${back}`;
    case "runtime-not-ready":
      return `Chat starts when Ollama is ready.${back}`;
    case "closed":
    case "timeout":
      return `Gates Local stopped answering.${back}`;
    default:
      return "The message didn't send. Try again.";
  }
}

export function stop(): void {
  const live = getState().live;
  if (live === null || live.end !== undefined) return;
  flushDeltas();
  // after the flush, on the state it left: the words that were waiting for a frame stay (W-05)
  const secs = Math.round((Date.now() - live.startedAt) / 1000);
  setState((s) => (s.live !== null && s.live.gen === live.gen && s.live.end === undefined ? { live: { ...s.live, end: { kind: "stopped", secs }, ending: true } } : {}));
  if (live.turnId !== null) {
    oldTurns.add(live.turnId);
    void call("chat.cancel", { turnId: live.turnId }).catch(() => undefined);
    return;
  }
  // without an id yet, startTurn cancels it once chat.send answers; until then another chat's
  // send can take the slot, and another chat finishing can wake the queue
  stoppedAtAdmission.add(live.gen);
  holdQueue(live.threadId);
}

/** Retry stays off while a stopped turn has not ended on the server: the server refuses a second turn in a thread, and the old turn's events must not land on the new one. */
export function canRetry(s: State): boolean {
  return s.threadId !== null && !streamingHere(s) && !(s.live?.threadId === s.threadId && s.live.ending === true);
}

/** Retry or Regenerate: send the thread's last user message again. The server keeps both copies (no regenerate method yet). */
export function retry(): void {
  const s = getState();
  if (s.threadId === null || !canRetry(s)) return;
  const last = (s.messages[s.threadId] ?? []).findLast((m) => m.role === "user");
  if (!last) return;
  void admit({ content: last.content, model: s.model ?? last.model ?? "", threadId: s.threadId, keepDraft: true, regenerate: true });
}

/** A dropped connection loses the live turn's stream; the server may still save it. */
function lostTurn(): void {
  flushDeltas();
  // the words of a turn behind another chat stop too; the next visit to its thread reloads what was saved
  parked = [];
  // the old socket's terminal events will not come; a stopped turn stops waiting for them
  setState((s) =>
    s.live === null
      ? {}
      : s.live.end === undefined
        ? { live: { ...s.live, end: { kind: "error", code: "closed", message: "The connection dropped while this reply was being written." } } }
        : s.live.ending
          ? { live: { ...s.live, ending: undefined } }
          : {},
  );
}

// Deltas batch into one store update per animation frame.
let pendText = "";
let pendThinking = "";
let raf = 0;

function flushDeltas(): void {
  if (raf !== 0) cancelAnimationFrame(raf);
  raf = 0;
  if (pendText === "" && pendThinking === "") return;
  const text = pendText;
  const thinking = pendThinking;
  pendText = "";
  pendThinking = "";
  perf.flushes++;
  setState((s) => {
    if (s.live === null || s.live.end !== undefined) return {};
    const now = Date.now();
    const l = s.live;
    return {
      live: {
        ...l,
        text: l.text + text,
        thinking: l.thinking + thinking,
        ...(text !== "" && l.firstTokenAt === undefined ? { firstTokenAt: now } : {}),
        ...(text !== "" && l.thinking + thinking !== "" && l.thinkingSecs === undefined ? { thinkingSecs: Math.max(1, Math.round((now - l.startedAt) / 1000)) } : {}),
      },
    };
  });
}

function dropDeltas(): void {
  if (raf !== 0) cancelAnimationFrame(raf);
  raf = 0;
  pendText = "";
  pendThinking = "";
}

function queueDelta(kind: "text" | "thinking", t: string): void {
  perf.deltas++;
  if (kind === "text") pendText += t;
  else pendThinking += t;
  if (raf === 0) raf = requestAnimationFrame(flushDeltas);
}

function onChatEvent(p: Payload<"chat.event">): void {
  const { turnId, threadId, event } = p;
  const live = getState().live;
  // a live turn still waiting for chat.send's answer (pendingUser goes when it comes, or when the send
  // fails): events in its thread, except a retired turn's, wait for that answer
  if (live !== null && live.threadId === threadId && live.turnId === null && live.pendingUser !== null && !oldTurns.has(turnId)) {
    early.push(p);
    return;
  }
  const terminal = event.type === "done" || event.type === "error";
  const ours = live !== null && live.threadId === threadId && live.turnId === turnId;
  if (terminal) oldTurns.delete(turnId);
  const away = parked.findIndex((t) => t.turnId === turnId);
  if (away >= 0) return parkedEvent(away, event);
  if (!ours) return otherTurn(p);
  // the stopped turn has ended on the server: Retry may send again
  if (terminal && live.ending) setState((s) => (s.live?.gen === live.gen ? { live: { ...s.live, ending: undefined } } : {}));
  switch (event.type) {
    case "start":
      noteMessage(threadId, event.userMessage);
      return setState((s) => ({ messages: withMessage(s, threadId, event.userMessage) }));
    case "delta":
      return queueDelta("text", event.text);
    case "thinking":
      return queueDelta("thinking", event.text);
    case "tool":
      flushDeltas();
      return setState((s) => (s.live ? { live: { ...s.live, tools: upsertStep(s.live.tools, event.step) } } : {}));
    case "done": {
      // the saved message has every word: drop the waiting ones instead of
      // publishing them a moment before the row that replaces them (W-09)
      if (window.glPerf?.terminalFlush === true) {
        perf.flushes++;
        setState((s) => ({ live: s.live === null ? null : { ...s.live } }));
      }
      const firstWordsWaiting = pendText !== "";
      dropDeltas();
      const msg = event.message;
      noteMessage(threadId, msg);
      setState((s) => {
        const l = s.live;
        const firstAt = l?.firstTokenAt ?? (firstWordsWaiting ? Date.now() : undefined);
        const ft = l !== null && firstAt !== undefined ? { [msg.id]: firstAt - l.startedAt } : {};
        return {
          messages: withMessage(s, threadId, msg),
          firstToken: { ...s.firstToken, ...ft },
          live: null,
        };
      });
      invalidateFits();
      flushQueued();
      return;
    }
    case "error": {
      flushDeltas();
      holdQueue(threadId);
      const why = stopReason(event);
      if (event.code === "cancelled") {
        setState((s) =>
          s.live && s.live.end === undefined ? { live: { ...s.live, end: { kind: "stopped", secs: Math.round((Date.now() - s.live.startedAt) / 1000) } } } : {},
        );
      } else if (event.partial !== undefined) {
        // the saved partial has every word the live turn showed: it takes the live turn's place
        dropDeltas();
        const { partial } = event;
        noteMessage(threadId, partial);
        setState((s) => ({ messages: withMessage(s, threadId, partial), live: null, ...(why === undefined ? {} : { stopNotes: { ...s.stopNotes, [partial.id]: why } }) }));
      } else {
        setState((s) => (s.live ? { live: { ...s.live, end: { kind: "error", code: event.code, message: why ?? event.message } } } : {}));
      }
      flushQueued();
      return;
    }
  }
}

/** One plain sentence for a reply the server stopped to make way for something else. */
function stopReason(event: { readonly code: string; readonly neededBy?: string | undefined }): string | undefined {
  if (event.code === "runtime-changed") return "Stopped when the Ollama runtime changed.";
  if (event.code !== "preempted") return undefined;
  const by = event.neededBy === undefined ? "another model" : describeModel(event.neededBy, catalogOf(getState())).name;
  return `Stopped so ${by} could load.`;
}

/** The reply these messages waited for stopped or failed: they wait for Send now instead of going out on their own. */
function holdQueue(threadId: string): void {
  const waiting = (q: Queued) => q.threadId === threadId && q.waitFor === "reply" && q.now !== true;
  setState((s) => (s.queued.some(waiting) ? { queued: s.queued.map((q) => (waiting(q) ? { ...q, held: true as const } : q)) } : {}));
}

type ChatEvent = Payload<"chat.event">["event"];

/** An event of a turn running behind another chat: its words wait outside the store for openThread. */
function parkedEvent(i: number, event: ChatEvent): void {
  const t = parked[i] as LiveTurn;
  const first = t.firstTokenAt === undefined ? { firstTokenAt: Date.now() } : {};
  switch (event.type) {
    case "delta":
      parked[i] = { ...t, ...first, text: t.text + event.text };
      return;
    case "thinking":
      parked[i] = { ...t, thinking: t.thinking + event.text };
      return;
    case "tool":
      parked[i] = { ...t, tools: upsertStep(t.tools, event.step) };
      return;
    case "done":
      parked.splice(i, 1);
      untrackedDone(t.threadId, event.message);
      invalidateFits();
      flushQueued();
      return;
    case "error":
      parked.splice(i, 1);
      holdQueue(t.threadId);
      if (event.code !== "cancelled") keepStopped(t.threadId, t.userMessageId, event);
      flushQueued();
      return;
  }
}

/** A turn that ended without being on screen: what it saved goes into its thread, with why it stopped under it. */
function keepStopped(threadId: string, userMessageId: string | undefined, event: Extract<ChatEvent, { type: "error" }>): void {
  const { partial } = event;
  if (partial !== undefined) noteMessage(threadId, partial);
  const why = stopReason(event) ?? "The reply didn't finish.";
  const on = partial?.id ?? userMessageId;
  setState((s) => ({
    ...(partial !== undefined && s.messages[threadId] !== undefined ? { messages: withMessage(s, threadId, partial) } : {}),
    ...(on === undefined ? {} : { stopNotes: { ...s.stopNotes, [on]: why } }),
  }));
}

/**
 * An event of a turn this client is not showing. A turn begun in the open
 * thread by another client (the same thread open on the phone and the
 * desktop) becomes the live turn here too and streams (PH-02); a client that
 * opened the thread after the start sees the reply when it is saved.
 */
function otherTurn({ turnId, threadId, event }: Payload<"chat.event">): void {
  if (event.type === "done") return untrackedDone(threadId, event.message);
  // a partial saved by a turn stopped elsewhere; a turn this client stopped itself reloads on its next visit
  if (event.type === "error" && event.partial !== undefined) return keepStopped(threadId, undefined, event);
  if (event.type !== "start") return;
  noteMessage(threadId, event.userMessage);
  const s = getState();
  const adopt = s.threadId === threadId && !oldTurns.has(turnId) && (s.live === null || (s.live.end !== undefined && s.live.ending !== true));
  const gen = adopt ? ++turnGen : 0;
  if (adopt) {
    retire(s.live);
    dropDeltas();
  }
  const start = Date.now();
  setState((st) => ({
    ...(st.messages[threadId] !== undefined ? { messages: withMessage(st, threadId, event.userMessage) } : {}),
    ...(adopt
      ? { live: { gen, threadId, turnId, userMessageId: event.userMessage.id, model: event.model, startedAt: start, thinking: "", text: "", tools: [], pendingUser: null } }
      : {}),
  }));
}

/**
 * A reply saved by a turn this client does not track: loads in flight for its
 * thread replay it over their older snapshots (WF-02), then the thread reloads.
 * A turn the server halted saves a partial instead; keepStopped takes that one.
 */
function untrackedDone(threadId: string, message: Message): void {
  noteMessage(threadId, message);
  void loadThread(threadId, true);
}

/**
 * The image module saved its message into a thread outside chat events, and
 * image.event names the thread but not the message. A thread this client
 * has, shows or is loading reloads; the load tickets keep an older snapshot
 * in flight from replacing the one with the image (WF3-01).
 */
function imageSaved(threadId: string): void {
  const s = getState();
  if (s.messages[threadId] !== undefined || s.threadId === threadId || loading(threadId)) void loadThread(threadId, true);
}

function upsertStep(steps: readonly ToolStep[], step: ToolStep): ToolStep[] {
  const i = steps.findIndex((x) => x.callId === step.callId);
  return i < 0 ? [...steps, step] : steps.map((x, j) => (j === i ? step : x));
}

/**
 * Send the next waiting message, oldest first, once nothing is in its way: one
 * at a time for this client, never past a message on hold or being edited
 * unless Send now asked for it.
 */
function flushQueued(): void {
  const s = getState();
  if (!chatReady(s) || queueReason(s) !== null || streaming(s) || s.live?.ending === true || parked.length > 0) return;
  const next = s.queued.find((q) => q.id !== s.editingQueued && (q.now === true || q.held !== true));
  const model = next?.model ?? s.model;
  if (next === undefined || model === undefined) return;
  const from = leaving(s.queued, next);
  setState((st) => ({ queued: st.queued.filter((q) => q.id !== next.id) }));
  // setup and the first download are the whole app waiting; a queue behind a reply stays out of the way
  if (next.waitFor !== "reply" && getState().threadId !== next.threadId) openThread(next.threadId);
  void startTurn(next.threadId, next.text, model, { from });
}

/**
 * Send now, T3 Code's interrupt: a reply running in this message's chat stops,
 * and the message goes first once that has ended. With nothing running there
 * it goes at once, through the same warning as any other send.
 */
export function sendQueuedNow(id: string): void {
  const s = getState();
  const q = s.queued.find((x) => x.id === id);
  if (!q || q.waitFor !== "reply") return;
  const here = s.live?.threadId === q.threadId;
  if (here && (streaming(s) || s.live?.ending === true)) {
    const { held: _held, ...rest } = q;
    setState({ queued: [{ ...rest, now: true }, ...s.queued.filter((x) => x.id !== id)] });
    stop();
    return;
  }
  void admit({ content: q.text, model: q.model ?? s.model ?? "", threadId: q.threadId, keepDraft: true, queuedId: q.id });
}

/** Remove: the message is gone. Edit is the way to get its words back. */
export function removeQueued(id: string): void {
  setState((s) => ({
    queued: s.queued.filter((q) => q.id !== id),
    ...(s.editingQueued === id ? { editingQueued: null, draft: "" } : {}),
    ...(s.stopAsk?.queuedId === id ? { stopAsk: null } : {}),
  }));
}

/** Edit: the words go in the composer and the message keeps its place until the next Send updates it. */
export function editQueued(id: string): void {
  const q = getState().queued.find((x) => x.id === id);
  if (q) setState({ editingQueued: id, draft: q.text, notice: null, stopAsk: null });
}

export function cancelQueuedEdit(): void {
  setState({ editingQueued: null, draft: "" });
  flushQueued();
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
  if ((await blockingFor(model, numCtx)).length === 0 && getState().model === model) void act("models.load", { model, numCtx }, `load ${model}`);
}

export function setContext(numCtx: ContextSize): void {
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
  updateEveryChange: "save the update setting",
  textSize: "save the text size",
};

/** Save settings; null on success, else the sentence to show beside the control. Nothing changes locally until the server agrees. */
export async function updateSettings(patch: SettingsPatch): Promise<ActionResult> {
  const keys = Object.keys(patch) as Array<keyof SettingsPatch>;
  const what = keys.length === 1 && keys[0] !== undefined ? SETTING_WORDS[keys[0]] : "save these settings";
  const r = await act("settings.update", patch, what);
  if (!r.ok) return r.message;
  applySettings(r.value);
  // the server reads ComfyUI only when asked: after these two, ask, so Settings says what it found
  if ("imageGen" in patch || "comfyUrl" in patch) {
    void probe("image.status", {}).then((imageStatus) => {
      if (imageStatus !== undefined) setState({ imageStatus });
    });
  }
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
  updateEveryChange: false,
  textSize: "default",
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
  const r = await act("image.status", {}, "check ComfyUI");
  if (!r.ok) return r.message;
  setState({ imageStatus: r.value });
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

/** The app's data folder, or null outside the desktop window. */
export async function dataFolder(): Promise<string | null> {
  return (await window.gatesLocal?.dataFolder?.()) ?? null;
}

export async function openDataFolder(): Promise<ActionResult> {
  return (await window.gatesLocal?.openDataFolder?.()) ?? null;
}

export async function pull(name: string): Promise<ActionResult> {
  const tag = name.trim();
  if (tag === "") return null;
  setState((s) => ({ pulls: { ...s.pulls, [tag]: { name: tag, state: "queued", completedBytes: 0 } } }));
  const r = await act("models.pull", { name: tag }, `start downloading ${tag}`);
  if (r.ok) return null;
  setState((s) => {
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
  setState((s) => ({
    updateChecking: false,
    ...(r.ok && s.update !== undefined && s.update !== NA ? { update: { ...s.update, lastCheck: r.value } } : {}),
  }));
  return r.ok ? null : r.message;
}

/** Hide the last update's result; the server forgets it too, so other windows lose it on their next start. */
export async function dismissUpdateResult(): Promise<void> {
  setState((s) => (s.update === undefined || s.update === NA ? {} : { update: { ...s.update, result: null } }));
  await act("update.dismissResult", {}, "hide the update note");
}

/** True in the desktop app, which can quit, update and open again; phones and browsers only check. */
export function canUpdateHere(): boolean {
  return typeof window.gatesLocal?.updateAndRestart === "function";
}

/** The Update and restart button: the desktop starts the updater and quits; null when it is on its way. */
export async function updateAndRestart(): Promise<ActionResult> {
  const bridge = window.gatesLocal;
  if (bridge?.updateAndRestart === undefined) return "Updating from here needs the desktop app. Run pnpm run app-update in the Gates Local folder instead.";
  try {
    const r = await bridge.updateAndRestart();
    return r.ok ? null : r.message;
  } catch (e) {
    return `Couldn't start the update (${e instanceof Error ? e.message : String(e)}). Run pnpm run app-update in the Gates Local folder instead.`;
  }
}

// ---------------------------------------------------------------- first run

const FIRST_RUN_KEY = "gates-local.first-run-done";

/** First run is a covered screen before hydration or its UI chunk can arrive. */
export function initialView(threadId: string | null): Pick<State, "view" | "threadId"> {
  return { view: threadId !== null ? "thread" : firstRunDone() ? "new" : "firstrun", threadId };
}

function firstRunDone(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_KEY) === "1";
  } catch {
    return false;
  }
}

export function finishFirstRun(next: "chat" | Section = "chat"): void {
  try {
    localStorage.setItem(FIRST_RUN_KEY, "1");
  } catch {
    // private windows may refuse storage; first run shows again next launch
  }
  if (next === "chat") newThread();
  else openSettings(next);
}
