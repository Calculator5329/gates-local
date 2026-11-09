// Thread creation, cached history, snapshot reconciliation and index actions.
import type { Message, MethodName, Params, ResultOf } from "@gates-local/contracts";
import { describeModel, titleFrom } from "../format.ts";
import { choosable, newestOnly } from "../pick.ts";
import { type LiveTurn, NA, type State, getState, setState } from "../store.ts";

interface ThreadEffects {
  readonly applyServerEvent: typeof setState;
  readonly call: <M extends MethodName>(method: M, params: Params<M>) => Promise<ResultOf<M>>;
  readonly codeOf: (error: unknown) => string;
  readonly failure: (what: string, error: unknown, todo?: string) => string;
  readonly openThread: (threadId: string) => void;
  readonly newThread: () => void;
  readonly navigationGeneration: () => number;
  readonly pendingSettings: () => number | null;
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

export function sortThreads<T extends { updatedAt: number }>(threads: readonly T[]): T[] {
  return threads.toSorted((a, b) => b.updatedAt - a.updatedAt);
}


function upsertMessage(list: readonly Message[], msg: Message): readonly Message[] {
  const i = list.findIndex((m) => m.id === msg.id);
  return i < 0 ? [...list, msg] : list.map((m, j) => (j === i ? msg : m));
}

/** The cache with msg added to its thread, or put in place of the copy with its id. */
export function withMessage(s: State, threadId: string, msg: Message): State["messages"] {
  return { ...s.messages, [threadId]: upsertMessage(s.messages[threadId] ?? [], msg) };
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

/** An ended live turn whose reply the server saved after all (it finished while the socket was down): showing both would duplicate it. */
function savedReplyFor(live: LiveTurn | null, threadId: string, messages: readonly Message[]): boolean {
  if (live === null || live.threadId !== threadId || live.end === undefined || live.userMessageId === undefined) return false;
  const i = messages.findIndex((m) => m.id === live.userMessageId);
  return i >= 0 && messages.slice(i + 1).some((m) => m.role === "assistant");
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

/** Navigation and RPC operations are wired by session.ts; history guards stay with their loads. */
export function createThreads({ applyServerEvent, call, codeOf, failure, openThread, newThread, navigationGeneration, pendingSettings }: ThreadEffects) {
  function setLoadError(threadId: string, message: string | null): void {
    if ((getState().loadErrors[threadId] ?? null) === message) return;
    applyServerEvent((s) => {
      const { [threadId]: _old, ...rest } = s.loadErrors;
      return { loadErrors: message === null ? rest : { ...rest, [threadId]: message } };
    });
  }

  // A thread list asked before a newer one, or before a local create or delete, is out of date (MP5-01).
  const threadsOrder = newestOnly();

  /** Threads cached before the last reconnect: the next visit reloads them. */
  const stale = new Set<string>();

  /**
   * Thread loads in flight, each with the messages that reached its thread
   * after it was sent: they are newer than its snapshot and replay over it by
   * id, so a reply saved meanwhile is not lost (WF-02).
   */
  const loads = new Set<{ readonly threadId: string; readonly seq: number; readonly since: Message[]; readonly preload?: Preload | undefined }>();

  /** Each thread load's ticket, in the order they were sent. */
  let loadSeq = 0;
  /** Per thread, the ticket of the newest load whose snapshot landed: an older load's answer, snapshot or failure, never replaces it. */
  const landed = new Map<string, number>();

  /** Threads whose history landed before any model list: their saved model is decided when one lands (MP5-02). */
  const unrestored = new Set<string>();

  const creatingDrafts = new Set<number>();
  // Speculation never enters the displayed store. Two histories, 4,000
  // messages and one million serialized characters bound what hover retains.
  const previews = new Map<string, { messages: readonly Message[]; size: number }>();
  interface Preload {
    readonly threadId: string;
    cancelled: boolean;
    used: boolean;
    navigation?: number;
    completion: Promise<void>;
  }
  let preloading: Preload | null = null;
  let intent: ReturnType<typeof setTimeout> | undefined;

  function invalidatePreload(threadId: string): void {
    previews.delete(threadId);
    if (preloading !== null && preloading.threadId === threadId) preloading.cancelled = true;
  }

  function keepPreview(threadId: string, messages: readonly Message[]): void {
    if (messages.length > 4000) return;
    const size = JSON.stringify(messages).length;
    if (size > 1_000_000) return;
    previews.delete(threadId);
    previews.set(threadId, { messages, size });
    while (previews.size > 2 || [...previews.values()].reduce((n, p) => n + p.size, 0) > 1_000_000 ||
      [...previews.values()].reduce((n, p) => n + p.messages.length, 0) > 4000) {
      const oldest = previews.keys().next().value;
      if (oldest === undefined) break;
      previews.delete(oldest);
    }
  }

  /** Leaving cancels intent and discards an unused result. A sent RPC drains
   * in its single slot: the wire has no cancellation method for reads. */
  function preloadThread(threadId: string | null): void {
    clearTimeout(intent);
    if (preloading !== null && !preloading.used && preloading.threadId !== threadId) preloading.cancelled = true;
    if (threadId === null) return;
    const ready = () => {
      const s = getState();
      return s.conn.kind === "open" && s.threadId !== threadId &&
        !(s.messages[threadId] !== undefined && !stale.has(threadId)) && !previews.has(threadId);
    };
    if (!ready()) return;
    intent = setTimeout(() => {
      if (!ready() || preloading !== null) return;
      const p: Preload = { threadId, cancelled: false, used: false, completion: Promise.resolve() };
      preloading = p;
      p.completion = fetchThread(threadId, p);
    }, 160);
  }

  function installHistory(threadId: string, messages: readonly Message[]): void {
    stale.delete(threadId);
    applyServerEvent((s) => ({
      messages: { ...s.messages, [threadId]: messages },
      ...(savedReplyFor(s.live, threadId, messages) ? { live: null } : {}),
      ...savedModel(s, threadId, messages),
    }));
    if (getState().models === undefined) unrestored.add(threadId);
    setLoadError(threadId, null);
  }

  async function refreshThreads(): Promise<void> {
    const ticket = threadsOrder.next();
    const threads = await call("threads.list", {}).catch(() => undefined);
    if (threads === undefined || !threadsOrder.current(ticket)) return;
    for (const id of previews.keys()) if (!threads.some(t => t.id === id)) invalidatePreload(id);
    applyServerEvent((s) => {
      const open = s.threadId !== null && threads.some((t) => t.id === s.threadId);
      const threadModels = Object.fromEntries(Object.entries(s.threadModels).filter(([id]) => threads.some((t) => t.id === id)));
      return { threads: sortThreads(threads), threadModels, ...(s.view === "thread" && !open ? { view: "new" as const, threadId: null } : {}) };
    });
  }

  /** A message this client learned outside a thread load: the loads in flight for its thread replay it. */
  function noteMessage(threadId: string, msg: Message): void {
    previews.delete(threadId);
    for (const l of loads) if (l.threadId === threadId) l.since.push(msg);
  }

  async function loadThread(threadId: string, force = false): Promise<void> {
    if (!force && getState().messages[threadId] !== undefined && !stale.has(threadId)) return;
    if (!force) {
      const preview = previews.get(threadId);
      if (preview !== undefined) {
        previews.delete(threadId);
        installHistory(threadId, preview.messages);
        return;
      }
      const p = preloading;
      if (p?.threadId === threadId && !p.cancelled) {
        p.used = true;
        p.navigation = navigationGeneration();
        setLoadError(threadId, null);
        await p.completion;
        // A change received during that read invalidates it, even after a
        // click joined it. Fetch current truth instead of publishing the old snapshot.
        if (p.cancelled) await loadThread(threadId);
        return;
      }
    }
    await fetchThread(threadId);
  }

  async function fetchThread(threadId: string, preload?: Preload): Promise<void> {
    const nav = navigationGeneration();
    const req = { threadId, seq: ++loadSeq, since: [] as Message[], preload };
    loads.add(req);
    if (preload === undefined || preload.used) setLoadError(threadId, null);
    const older = () => preload?.cancelled === true || req.seq < (landed.get(threadId) ?? 0);
    try {
      const { messages: snapshot } = await call("threads.get", { threadId });
      if (older()) return;
      landed.set(threadId, req.seq);
      const messages = req.since.reduce(upsertMessage, snapshot);
      if (preload !== undefined && !preload.used) keepPreview(threadId, messages);
      else installHistory(threadId, messages);
    } catch (e) {
      if (older()) return;
      if (preload !== undefined && !preload.used) return;
      // a failure lands too: an older answer that comes after it must not clear or replace its error
      landed.set(threadId, req.seq);
      // a cached thread keeps its content; either way the open thread says why and offers Retry
      setLoadError(threadId, failure("load this conversation", e));
      // a thread that is gone leaves the screen, only while it is still on screen and nobody navigated since (Settings over it counts, loaded or still loading)
      const s = getState();
      if (codeOf(e) === "thread-not-found" && (preload?.navigation ?? nav) === navigationGeneration() && pendingSettings() === null && s.view === "thread" && s.threadId === threadId) applyServerEvent({ view: "new", threadId: null });
    } finally {
      loads.delete(req);
      if (preload !== undefined && preloading === preload) preloading = null;
    }
  }

  function restoreSaved(): void {
    if (unrestored.size === 0 || getState().models === undefined) return;
    const ids = [...unrestored];
    unrestored.clear();
    setState((s) => ids.reduce<Partial<State>>((acc, id) => ({ ...acc, ...savedModel({ ...s, ...acc }, id, s.messages[id] ?? []) }), {}));
  }

  /** Retry beside a failed load: fetch the thread again. */
  function reloadThread(threadId: string): void {
    void loadThread(threadId, true);
  }

  function loading(threadId: string): boolean {
    return [...loads].some((l) => l.threadId === threadId && (l.preload === undefined || l.preload.used));
  }

  let actionNotice: { readonly key: string; readonly message: string } | undefined;

  /** A retry clears only its still-current failure; a missing thread confirms a delete. */
  async function threadAction(action: "rename" | "delete", threadId: string, send: () => Promise<unknown>): Promise<boolean> {
    const key = action + threadId;
    const previous = actionNotice?.key === key ? actionNotice : undefined;
    try {
      await send();
    } catch (e) {
      if (action !== "delete" || codeOf(e) !== "thread-not-found") {
        const message = failure(`${action} this conversation`, e);
        actionNotice = { key, message };
        applyServerEvent({ notice: message });
        return false;
      }
    }
    if (previous !== undefined && actionNotice === previous) {
      actionNotice = undefined;
      if (getState().notice === previous.message) applyServerEvent({ notice: null });
    }
    return true;
  }

  async function renameThread(threadId: string, title: string): Promise<void> {
    const t = title.trim();
    if (t !== "") await threadAction("rename", threadId, () => call("threads.rename", { threadId, title: t }));
  }

  async function deleteThread(threadId: string): Promise<void> {
    if (!await threadAction("delete", threadId, () => call("threads.delete", { threadId }))) return;
    invalidatePreload(threadId);
    // A snapshot sent before this confirmed deletion cannot resurrect it.
    landed.set(threadId, ++loadSeq);
    threadsOrder.next();
    applyServerEvent((s) => {
      const { [threadId]: _gone, ...messages } = s.messages;
      const { [threadId]: _model, ...threadModels } = s.threadModels;
      const { [threadId]: _error, ...loadErrors } = s.loadErrors;
      return { messages, threadModels, loadErrors, threads: s.threads.filter((t) => t.id !== threadId), queued: s.queued.filter((q) => q.threadId !== threadId) };
    });
    if (getState().threadId === threadId) {
      const notice = getState().notice;
      newThread();
      if (notice !== null) applyServerEvent({ notice });
    }
  }

  /** A new chat for this message; null, with the text back in the box, when the server does not answer. */
  async function createThread(content: string, model: string | undefined): Promise<string | null> {
    const version = getState().draftVersion;
    if (creatingDrafts.has(version)) return null;
    creatingDrafts.add(version);
    try {
      const t = await call("threads.create", { title: titleFrom(content) || "Attached images" });
      // Its history is known empty, so loadThread never runs for it: record the model it starts on here.
      const own = model === undefined ? {} : { threadModels: { ...getState().threadModels, [t.id]: model } };
      threadsOrder.next();
      applyServerEvent((st) => ({ threads: sortThreads([t, ...st.threads.filter((x) => x.id !== t.id)]), messages: { ...st.messages, [t.id]: [] }, ...own }));
      openThread(t.id);
      return t.id;
    } catch {
      applyServerEvent({ notice: "The message didn't send. Gates Local isn't answering; your words are still in the composer." });
      return null;
    } finally { creatingDrafts.delete(version); }
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
    invalidatePreload(threadId);
    const s = getState();
    if (s.messages[threadId] !== undefined || s.threadId === threadId || loading(threadId)) void loadThread(threadId, true);
  }

  return {
    refreshThreads, noteMessage, loadThread, restoreSaved, reloadThread, loading,
    preloadThread,
    threadsChanged(threadId: string) { invalidatePreload(threadId); void refreshThreads(); },
    renameThread, deleteThread, createThread, untrackedDone, imageSaved,
    creatingDraft: (version: number) => creatingDrafts.has(version),
    listOrder: threadsOrder,
    markOtherThreadsStale(s: State) {
      previews.clear();
      if (preloading !== null) preloading.cancelled = true;
      for (const id of Object.keys(s.messages)) if (id !== s.threadId) stale.add(id);
    },
  };
}
