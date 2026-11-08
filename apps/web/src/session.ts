// The connection to the Gates Local server and every action the UI takes.
// One WebSocket through createClient; it reconnects after a drop and fetches
// state again. Methods the server answers "not-implemented" are recorded as
// NA so the UI can hide them or say "Not available in this build".
import {
  type Channel,
  type Client,
  type ContextSize,
  type Message,
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
import { describeModel, titleFrom } from "./format.ts";
import { type LiveTurn, NA, type Queued, type Section, type State, chatReady, fitKey, getState, setState, streaming } from "./store.ts";

// ---------------------------------------------------------------- desktop bridge
// The preload's window.gatesLocal (apps/desktop/src/preload.ts). Declared here
// because the web app does not import the desktop package.
type BridgeState =
  | { readonly status: "ready"; readonly serverUrl: string }
  | { readonly status: "idle" | "starting" | "restarting" | "crashed" | "stopping" | "stopped" };

interface DesktopBridge {
  getServerUrl(): Promise<string | null>;
  onState(listener: (state: BridgeState) => void): () => void;
  /** Starts `pnpm run app-update` and quits; missing on desktop builds from before it existed. */
  updateAndRestart?(): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
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
  void loop();
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
    setState({ runtime });
    if (runtime.state === "ready") {
      invalidateFits();
      flushQueued();
    }
  });
  on("models.changed", (models) => {
    setState({ models });
    chooseModel();
    invalidateFits();
    flushQueued();
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
    if (l.state === "ready" || l.state === "unloaded") invalidateFits();
  });
  on("sources.changed", (sources) => setState({ sources }));
  on("image.status", (imageStatus) => setState({ imageStatus }));
  on("image.event", (e) => {
    if (e.state === "done" && e.threadId !== undefined) imageSaved(e.threadId);
  });

  // settings.get is a local store read and the model choice needs only it and
  // the model list, so the runtime dot and a chosen model land in one render:
  // a message typed the moment the dot turns ready sends. gpu.status and the
  // catalog can take a few hundred ms and follow.
  const [runtime, models, threads, settings] = await Promise.all([
    call("runtime.status", {}),
    call("models.list", {}).catch(() => undefined),
    call("threads.list", {}),
    probe("settings.get", {}),
  ]);
  setState((s) => {
    const withSettings = settings === NA || settings === undefined ? { settings } : settingsPatch(s, settings, true);
    const next: State = { ...s, runtime, models: models ?? s.models, threads: sortThreads(threads), fits: {}, ...withSettings };
    const model = modelChoice(next);
    return { ...next, ...(model === undefined ? {} : { model }) };
  });
  applyTheme(settings === NA || settings === undefined ? "system" : settings.theme);
  // the pushes that came during the first batch, in order, in this same task
  release(SECOND_BATCH);

  // update.status reads the .git folder and a local file; the check that
  // fetches runs only from the Check for updates button (checkForUpdates).
  const [gpu, catalog, sources, imageStatus, update] = await Promise.all([
    probe("gpu.status", {}),
    probe("models.catalog", {}),
    probe("sources.list", {}),
    probe("image.status", {}),
    probe("update.status", {}),
  ]);
  setState({ gpu, catalog, sources, imageStatus, update });
  release("none");

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
  const threads = await call("threads.list", {}).catch(() => undefined);
  if (threads === undefined) return;
  setState((s) => {
    const open = s.threadId !== null && threads.some((t) => t.id === s.threadId);
    return { threads: sortThreads(threads), ...(s.view === "thread" && !open ? { view: "new" as const, threadId: null } : {}) };
  });
}

export async function refreshModels(): Promise<void> {
  const models = await call("models.refresh", {}).catch(() => undefined);
  if (models === undefined) return;
  setState({ models });
  chooseModel();
  invalidateFits();
}

function settingsPatch(s: State, settings: Settings, first: boolean): Partial<State> {
  return {
    settings,
    ...(first ? { numCtx: settings.defaultNumCtx, think: settings.thinking } : {}),
    ...(first && settings.defaultModel !== undefined && s.model === undefined ? { model: settings.defaultModel } : {}),
    ...(!settings.imageGen ? { image: false } : {}),
  };
}

function applySettings(settings: Settings, first = false): void {
  setState((s) => settingsPatch(s, settings, first));
  applyTheme(settings.theme);
}

/** Dark or light on the root; "system" removes the attribute so the OS decides (styles.css). */
function applyTheme(theme: Settings["theme"]): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** Keep the chat model valid: the settings default, else the smallest installed model (the fastest that fits). */
function chooseModel(): void {
  const model = modelChoice(getState());
  if (model !== undefined) setState({ model });
}

/** The model chooseModel would switch to, or undefined when the current one stays (or none is installed). */
function modelChoice(s: State): string | undefined {
  const models = s.models ?? [];
  if (models.length === 0) return undefined;
  if (s.model !== undefined && models.some((m) => m.name === s.model)) return undefined;
  const def = s.settings !== NA ? s.settings?.defaultModel : undefined;
  return (models.find((m) => m.name === def) ?? models.toSorted((a, b) => a.sizeBytes - b.sizeBytes)[0])?.name;
}

// ---------------------------------------------------------------- fit checks

const inflight = new Set<string>();

/** Fetch the fit report for a model at a context once; the store caches it. */
export function ensureFit(model: string | undefined, numCtx: number): void {
  if (model === undefined) return;
  const key = fitKey(model, numCtx);
  const s = getState();
  if (s.fits[key] !== undefined || inflight.has(key) || !chatReady(s)) return;
  inflight.add(key);
  call("fit.check", { model, numCtx })
    .then((r) => setState((st) => ({ fits: { ...st.fits, [key]: r } })))
    .catch(() => setState((st) => ({ fits: { ...st.fits, [key]: "error" as const } })))
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
    setState((s) => ({ messages: { ...s.messages, [threadId]: messages }, ...(savedReplyFor(s.live, threadId, messages) ? { live: null } : {}) }));
    setLoadError(threadId, null);
  } catch (e) {
    if (older()) return;
    // a failure lands too: an older answer that comes after it must not clear or replace its error
    landed.set(threadId, req.seq);
    // a cached thread keeps its content; either way the open thread says why and offers Retry
    setLoadError(threadId, failure("load this conversation", e));
    // a thread that is gone leaves the screen, only while it is still on screen and nobody navigated since (Settings over it counts)
    const s = getState();
    if (codeOf(e) === "thread-not-found" && nav === navGen && s.view === "thread" && s.threadId === threadId) setState({ view: "new", threadId: null });
  } finally {
    loads.delete(req);
  }
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

export function openThread(threadId: string): void {
  navGen++;
  setState({ view: "thread", threadId, notice: null, addPage: false, ownerConfirm: false });
  setHash(threadId);
  void loadThread(threadId);
}

export function newThread(): void {
  navGen++;
  setState({ view: "new", threadId: null, notice: null });
  setHash(null);
}

export function openSettings(section?: Section, addPage = false): void {
  navGen++;
  setState((s) => ({ view: "settings", section: section ?? s.section, addPage, ownerConfirm: false }));
}

export function leaveSettings(): void {
  navGen++;
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
  setState((s) => {
    const { [threadId]: _gone, ...messages } = s.messages;
    const { [threadId]: _error, ...loadErrors } = s.loadErrors;
    return { messages, loadErrors, threads: s.threads.filter((t) => t.id !== threadId), queued: s.queued.filter((q) => q.threadId !== threadId) };
  });
  if (getState().threadId === threadId) newThread();
}

/** The open thread as Markdown, for "Export as Markdown". */
export function threadMarkdown(threadId: string): string {
  const s = getState();
  const t = s.threads.find((x) => x.id === threadId);
  const lines = [`# ${t?.title ?? "Thread"}`, ""];
  for (const m of s.messages[threadId] ?? []) {
    lines.push(m.role === "user" ? "## You" : `## ${describeModel(m.model ?? "", catalogOf(s)).name || "Reply"}`, "", m.content, "");
  }
  return lines.join("\n");
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

// ---------------------------------------------------------------- chat

/** Whether a message typed now would wait in the thread instead of sending. */
export function queueReason(s: State): Queued["waitFor"] | null {
  if (s.conn.kind !== "open") return null;
  if (s.runtime?.state === "installing") return "setup";
  const first = firstPull(s);
  if (s.runtime?.state === "ready" && first !== undefined) return "download";
  return null;
}

/** The download that will become the first model, while none is installed. */
export function firstPull(s: State): string | undefined {
  if ((s.models?.length ?? 0) > 0) return undefined;
  return Object.values(s.pulls).find((p) => p.state === "downloading" || p.state === "queued" || p.state === "verifying")?.name;
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
function retire(live: LiveTurn | null): void {
  if (live !== null && live.turnId !== null) oldTurns.add(live.turnId);
}

/** Events that came while the live turn waited for chat.send to give its id; the answer replays them (WF-01). */
let early: Array<Payload<"chat.event">> = [];

export async function send(text: string, opts: { reuseThread?: boolean } = {}): Promise<void> {
  const content = text.trim();
  const s = getState();
  if (content === "" || streaming(s)) return;
  const wait = queueReason(s);
  if (!chatReady(s) && wait === null) return;
  const model = s.model;
  if (model === undefined && wait === null) return;

  let threadId = s.view === "thread" || opts.reuseThread ? s.threadId : null;
  retire(s.live);
  setState({ draft: "", notice: null, live: null });
  if (threadId === null) {
    try {
      const t = await call("threads.create", { title: titleFrom(content) });
      threadId = t.id;
      setState((st) => ({ threads: sortThreads([t, ...st.threads.filter((x) => x.id !== t.id)]), messages: { ...st.messages, [t.id]: [] } }));
      openThread(t.id);
    } catch {
      setState({ draft: content, notice: "The message didn't send. Gates Local isn't answering; try again in a moment." });
      return;
    }
  }
  if (wait !== null) {
    const q: Queued = { id: `q${Date.now()}`, threadId, text: content, at: Date.now(), waitFor: wait };
    setState((st) => ({ queued: [...st.queued, q] }));
    return;
  }
  await startTurn(threadId, content, model ?? "");
}

async function startTurn(threadId: string, content: string, model: string): Promise<void> {
  const s = getState();
  retire(s.live);
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
    });
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
    setState((st) => {
      if (st.live === null || st.live.gen !== gen) return {};
      // a stopped turn that never started has nothing left to wait for
      if (st.live.end !== undefined) return { live: { ...st.live, pendingUser: null, ending: undefined } };
      return { live: null, draft: content, notice: refusal(codeOf(e), model) };
    });
    // a turn another client started meanwhile (turn-active) now streams here
    if (mine) replayEarly();
  }
}

function replayEarly(): void {
  const all = early;
  early = [];
  for (const p of all) onChatEvent(p);
}

/** Plain words for a refused send. */
function refusal(code: string, model: string): string {
  const name = describeModel(model, catalogOf(getState())).name;
  switch (code) {
    case "wont-fit":
      return `${name} doesn't fit in memory at ${Math.round(getState().numCtx / 1024)}k. Pick a smaller model or context.`;
    case "turn-active":
      return "A reply is still being written in this thread. Stop it or wait.";
    case "runtime-not-ready":
      return "Chat starts when Ollama is ready. Your message is back in the box.";
    case "closed":
    case "timeout":
      return "Gates Local stopped answering. Your message is back in the box.";
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
  // without an id yet, startTurn cancels it once chat.send answers
  if (live.turnId !== null) {
    oldTurns.add(live.turnId);
    void call("chat.cancel", { turnId: live.turnId }).catch(() => undefined);
  }
}

/** Retry stays off while a stopped turn has not ended on the server: the server refuses a second turn in a thread, and the old turn's events must not land on the new one. */
export function canRetry(s: State): boolean {
  return s.threadId !== null && !streaming(s) && s.live?.ending !== true;
}

/** Retry or Regenerate: send the thread's last user message again. The server keeps both copies (no regenerate method yet). */
export function retry(): void {
  const s = getState();
  if (s.threadId === null || !canRetry(s)) return;
  const last = (s.messages[s.threadId] ?? []).findLast((m) => m.role === "user");
  if (!last) return;
  retire(s.live);
  setState({ live: null });
  void startTurn(s.threadId, last.content, s.model ?? last.model ?? "");
}

/** A dropped connection loses the live turn's stream; the server may still save it. */
function lostTurn(): void {
  flushDeltas();
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
    case "error":
      flushDeltas();
      if (event.code === "cancelled") {
        return setState((s) =>
          s.live && s.live.end === undefined ? { live: { ...s.live, end: { kind: "stopped", secs: Math.round((Date.now() - s.live.startedAt) / 1000) } } } : {},
        );
      }
      return setState((s) => (s.live ? { live: { ...s.live, end: { kind: "error", code: event.code, message: event.message } } } : {}));
  }
}

/**
 * An event of a turn this client is not showing. A turn begun in the open
 * thread by another client (the same thread open on the phone and the
 * desktop) becomes the live turn here too and streams (PH-02); a client that
 * opened the thread after the start sees the reply when it is saved.
 */
function otherTurn({ turnId, threadId, event }: Payload<"chat.event">): void {
  if (event.type === "done") return untrackedDone(threadId, event.message);
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
 * A stopped or failed turn saves nothing on the server, so only done has a
 * message to keep.
 */
function untrackedDone(threadId: string, message: Message): void {
  noteMessage(threadId, message);
  void loadThread(threadId, true);
}

/**
 * The image module saved its message into a thread outside chat events, and
 * image.event done names the thread but not the message. A thread this client
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

/** Send what waited for setup or a download, oldest first, once chat is ready. */
function flushQueued(): void {
  const s = getState();
  if (!chatReady(s) || queueReason(s) !== null || s.model === undefined || streaming(s)) return;
  const next = s.queued[0];
  if (!next) return;
  setState((st) => ({ queued: st.queued.slice(1) }));
  if (getState().threadId !== next.threadId) openThread(next.threadId);
  void startTurn(next.threadId, next.text, s.model);
}

/** Cancel send: the waiting text goes back into the composer. */
export function unqueue(id: string): void {
  const s = getState();
  const q = s.queued.find((x) => x.id === id);
  if (!q) return;
  setState({ queued: s.queued.filter((x) => x.id !== id), draft: q.text });
}

// ---------------------------------------------------------------- composer and models

export function pickModel(model: string): void {
  setState({ model });
  const s = getState();
  if (!s.unavailable["models.load"] && chatReady(s)) void act("models.load", { model, numCtx: s.numCtx }, `load ${model}`);
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
