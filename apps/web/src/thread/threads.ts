// Thread creation, cached history, snapshot reconciliation and index actions.
import { type CallOptions, type Message, type MethodName, type Params, type Payload, type ResultOf, type SyncMetadata, type Thread, chatScope } from "@gates-local/contracts";
import { describeModel, titleFrom } from "../lib/words/format.ts";
import { choosable } from "../models/pick.ts";
import { type LiveTurn, NA, type State, getState, setState } from "../lib/store/store.ts";
import { dropDraft, getDraft } from "../lib/store/drafts.ts";
import { withTurn } from "./turn.ts";
import { debounce } from "../lib/ui/kit/async.ts";
import { createThreadNumbers } from "./numbers.ts";

interface ThreadEffects {
  readonly applyServerEvent: typeof setState;
  readonly call: <M extends MethodName>(method: M, params: Params<M>, options?: CallOptions<M>) => Promise<ResultOf<M>>;
  readonly codeOf: (error: unknown) => string;
  readonly failure: (what: string, error: unknown, todo?: string) => string;
  readonly openThread: (threadId: string) => void;
  readonly newThread: () => void;
  readonly navigationGeneration: () => number;
  readonly pendingSettings: () => number | null;
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

/** How many messages a thread opens on, and how many each ask for earlier ones brings. */
export const PAGE_MESSAGES = 200;
/** How long a pointer rests on a thread's row before its messages are read ahead. */
const HOVER_INTENT_MS = 160;

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

  /**
   * The list's number and each chat's: a row older than the one shown is dropped, and a cached chat
   * is read again only when a push or a list named a newer number for it than its copy's.
   */
  const numbers = createThreadNumbers();

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

  /**
   * Per thread, how many saved messages come before the ones loaded. A thread opens on its newest
   * page; the server keeps the rest until the reader asks for them, a page at a time.
   */
  const earlierCounts = new Map<string, number>();
  const earlierListeners = new Set<() => void>();
  function setEarlier(threadId: string, count: number): void {
    if ((earlierCounts.get(threadId) ?? 0) === count) return;
    if (count === 0) earlierCounts.delete(threadId);
    else earlierCounts.set(threadId, count);
    for (const listener of earlierListeners) listener();
  }
  /** One page before the loaded messages in flight per thread; a second ask joins it. */
  const fetchingEarlier = new Map<string, Promise<boolean>>();

  /** Threads whose history landed before any model list: their saved model is decided when one lands (MP5-02). */
  const unrestored = new Set<string>();

  const creatingDrafts = new Set<number>();
  // Speculation never enters the displayed store. Two histories, 4,000
  // messages and one million serialized characters bound what hover retains.
  const previews = new Map<string, { messages: readonly Message[]; earlier: number; size: number; at: number }>();
  interface Preload {
    readonly threadId: string;
    cancelled: boolean;
    used: boolean;
    navigation?: number;
    completion: Promise<void>;
  }
  let preloading: Preload | null = null;
  // a pointer that rests on a row this long means to open it: the read starts then
  const intent = debounce((threadId: string, ready: () => boolean) => {
    if (!ready() || preloading !== null) return;
    const p: Preload = { threadId, cancelled: false, used: false, completion: Promise.resolve() };
    preloading = p;
    p.completion = fetchThread(threadId, p);
  }, HOVER_INTENT_MS);

  function invalidatePreload(threadId: string): void {
    previews.delete(threadId);
    if (preloading !== null && preloading.threadId === threadId) preloading.cancelled = true;
  }

  function keepPreview(threadId: string, messages: readonly Message[], earlier: number, at: number): void {
    if (messages.length > 4000) return;
    const size = JSON.stringify(messages).length;
    if (size > 1_000_000) return;
    previews.delete(threadId);
    previews.set(threadId, { messages, earlier, size, at });
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
    intent.cancel();
    if (preloading !== null && !preloading.used && preloading.threadId !== threadId) preloading.cancelled = true;
    if (threadId === null) return;
    const ready = () => {
      const s = getState();
      return s.conn.kind === "open" && s.pop?.id !== "thread" && s.threadId !== threadId &&
        !(s.messages[threadId] !== undefined && numbers.current(threadId)) && !previews.has(threadId);
    };
    if (!ready()) return;
    intent(threadId, ready);
  }

  /** A read of the chat at number `at` becomes what the window shows of it. */
  function installHistory(threadId: string, messages: readonly Message[], earlier: number, at: number): void {
    numbers.hold(threadId, at);
    setEarlier(threadId, earlier);
    applyServerEvent((s) => ({
      messages: { ...s.messages, [threadId]: messages },
      ...(savedReplyFor(s.turns[threadId] ?? null, threadId, messages) ? { turns: withTurn(s.turns, threadId, null) } : {}),
      ...savedModel(s, threadId, messages),
    }));
    if (getState().models === undefined) unrestored.add(threadId);
    setLoadError(threadId, null);
  }

  /**
   * A chat the server says is deleted (a row with no chat, pushed or the answer to this window's
   * delete): its row, cached copy, model, error, preview and draft go. Only this ends a draft here; a
   * list that leaves a chat out (one still being made, or one read before it) never does.
   */
  function forget(threadId: string): void {
    invalidatePreload(threadId);
    dropDraft(threadId);
    // A snapshot sent before this deletion cannot bring it back.
    landed.set(threadId, ++loadSeq);
    setEarlier(threadId, 0);
    numbers.drop(threadId);
    applyServerEvent((s) => {
      const { [threadId]: _gone, ...messages } = s.messages;
      const { [threadId]: _model, ...threadModels } = s.threadModels;
      const { [threadId]: _error, ...loadErrors } = s.loadErrors;
      return { messages, threadModels, loadErrors, threads: s.threads.filter((t) => t.id !== threadId) };
    });
  }

  /** One chat's row as the server has it at this number; null when it was deleted. */
  function applyRow(threadId: string, thread: Thread | null, sync: SyncMetadata | undefined): void {
    if (!numbers.row(threadId, numbers.of(sync, "threads"))) return;
    if (thread === null) {
      forget(threadId);
      // the chat on screen is gone: its screen goes too, as a list without it did
      const s = getState();
      if (s.view === "thread" && s.threadId === threadId) applyServerEvent({ view: "new", threadId: null });
      return;
    }
    applyServerEvent((s) => ({ threads: sortThreads([thread, ...s.threads.filter((t) => t.id !== threadId)]) }));
  }

  /**
   * A push about one chat: its row, and the number of its messages. The open chat is read again when
   * that number is newer than its copy's (a load in flight is compared when it lands); another
   * chat keeps the number and is compared when it is opened.
   */
  function rowPushed({ threadId, thread }: Payload<"threads.changed">, sync: SyncMetadata | undefined): void {
    applyRow(threadId, thread, sync);
    if (thread === null) return;
    // legacy: the push cannot say what changed, so a read ahead of the chat is thrown away, as before
    if (!numbers.ordered()) { invalidatePreload(threadId); return; }
    numbers.announce(threadId, numbers.of(sync, chatScope(threadId)));
    const preview = previews.get(threadId);
    if (preview !== undefined && preview.at < numbers.known(threadId)) previews.delete(threadId);
    if (getState().threadId === threadId && !loading(threadId) && !numbers.current(threadId)) void loadThread(threadId, true);
  }

  /**
   * The hydrate's list read. On an ordered connection it applies as it lands when newer than the list
   * shown, and a chat whose row came after the read keeps that row (or stays deleted); each chat's
   * number is noted, so a cached copy is read again on its next visit only if it moved. Legacy: the
   * hydrate's batch applies the list as read, and every cached copy is read again on its next visit.
   */
  function listArrived(threads: readonly Thread[], sync: SyncMetadata | undefined): void {
    if (!numbers.ordered()) return;
    const newer = numbers.list(numbers.of(sync, "threads"));
    if (newer === undefined) return;
    for (const t of threads) if (!newer.has(t.id)) numbers.announce(t.id, numbers.of(sync, chatScope(t.id)));
    applyServerEvent((s) => {
      const listed = sortThreads([...threads.filter((t) => !newer.has(t.id)), ...s.threads.filter((t) => newer.has(t.id))]);
      // a chat the list no longer has keeps no model pick (its draft stays: see forget)
      const threadModels = Object.fromEntries(Object.entries(s.threadModels).filter(([id]) => listed.some((t) => t.id === id) || id === s.threadId));
      return { threads: listed, threadModels };
    });
  }

  /** A message this client learned outside a thread load: the loads in flight for its thread replay it. */
  function noteMessage(threadId: string, msg: Message): void {
    previews.delete(threadId);
    for (const l of loads) if (l.threadId === threadId) l.since.push(msg);
  }

  async function loadThread(threadId: string, force = false): Promise<void> {
    if (!force && getState().messages[threadId] !== undefined && numbers.current(threadId)) return;
    if (!force) {
      const preview = previews.get(threadId);
      previews.delete(threadId);
      if (preview !== undefined && preview.at >= numbers.known(threadId)) {
        installHistory(threadId, preview.messages, preview.earlier, preview.at);
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

  async function fetchThread(threadId: string, preload?: Preload, again = false): Promise<void> {
    const nav = navigationGeneration();
    const req = { threadId, seq: ++loadSeq, since: [] as Message[], preload };
    loads.add(req);
    if (preload === undefined || preload.used) setLoadError(threadId, null);
    const older = () => preload?.cancelled === true || req.seq < (landed.get(threadId) ?? 0);
    let wider = false;
    let outdated = false;
    // the chat's number this read is at: the answer's own, or (legacy, never compared) the newest named when it was sent
    let at = numbers.asked(threadId);
    try {
      // the newest page, or as many as are already loaded: a reload never takes back what the reader asked for
      const limit = Math.max(PAGE_MESSAGES, getState().messages[threadId]?.length ?? 0);
      const { messages: snapshot, earlier = 0 } = await call("threads.get", { threadId, limit }, { onResult: (_, sync) => { at = numbers.of(sync, chatScope(threadId)) ?? at; } });
      if (older()) return;
      // a change was named for the chat while this read was out: its answer is older than that, and
      // is read again instead of shown (a read ahead nobody opened yet is only dropped)
      if (at < numbers.known(threadId)) {
        outdated = preload === undefined || preload.used;
        return;
      }
      // an earlier page came in while this was asked: the reader holds messages in front of this
      // answer, so it is asked again for all of them (once: a front deleted meanwhile is not looped on)
      const front = getState().messages[threadId]?.[0];
      if (!again && (preload === undefined || preload.used) && earlier > 0 && front !== undefined && !snapshot.some((m) => m.id === front.id)) {
        wider = true;
        return;
      }
      landed.set(threadId, req.seq);
      const messages = req.since.reduce(upsertMessage, snapshot);
      if (preload !== undefined && !preload.used) keepPreview(threadId, messages, earlier, at);
      else installHistory(threadId, messages, earlier, at);
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
    if (wider) await fetchThread(threadId, undefined, true);
    else if (outdated) await fetchThread(threadId, undefined, again);
  }

  /**
   * The page of saved messages before the first one loaded, put in front of them. True once it is
   * in; false when there was none, or a reload or delete changed the thread meanwhile.
   */
  function loadEarlier(threadId: string): Promise<boolean> {
    const pending = fetchingEarlier.get(threadId);
    if (pending !== undefined) return pending;
    const first = getState().messages[threadId]?.[0];
    if (first === undefined || (earlierCounts.get(threadId) ?? 0) === 0) return Promise.resolve(false);
    const page = (async () => {
      try {
        const { messages, earlier = 0 } = await call("threads.get", { threadId, before: first.id, limit: PAGE_MESSAGES });
        // a reload or delete that landed meanwhile decides what is in front now
        if (getState().messages[threadId]?.[0]?.id !== first.id) return false;
        applyServerEvent((s) => {
          const now = s.messages[threadId] ?? [];
          const have = new Set(now.map((m) => m.id));
          return { messages: { ...s.messages, [threadId]: [...messages.filter((m) => !have.has(m.id)), ...now] } };
        });
        setEarlier(threadId, earlier);
        return true;
      } catch (e) {
        // the message it starts from is gone (an edit or delete elsewhere): read the thread again
        if (codeOf(e) === "message-not-found") void loadThread(threadId, true);
        else applyServerEvent({ notice: failure("load the earlier messages", e) });
        return false;
      } finally {
        fetchingEarlier.delete(threadId);
      }
    })();
    fetchingEarlier.set(threadId, page);
    return page;
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
    if (t !== "") await threadAction("rename", threadId, () => call("threads.rename", { threadId, title: t }, { onResult: rowAnswered }));
  }

  /** An action's answer is the chat's row at the action's number: it applies as a pushed row does. */
  function rowAnswered(thread: Thread, sync: SyncMetadata | undefined): void {
    applyRow(thread.id, thread, sync);
  }

  const deletions = new Map<string, Promise<void>>();

  /** Export must let a delete already requested for this thread settle before making a file. */
  function waitForThreadDeletion(threadId: string): Promise<void> {
    return deletions.get(threadId) ?? Promise.resolve();
  }

  function deleteThread(threadId: string): Promise<void> {
    const pending = deletions.get(threadId);
    if (pending !== undefined) return pending;
    const deletion = performDelete(threadId).finally(() => deletions.delete(threadId));
    deletions.set(threadId, deletion);
    return deletion;
  }

  async function performDelete(threadId: string): Promise<void> {
    // the answer is the deletion's number: a list read before it cannot bring the row back
    if (!await threadAction("delete", threadId, () => call("threads.delete", { threadId }, { onResult: (_, sync) => { numbers.row(threadId, numbers.of(sync, "threads")); } }))) return;
    forget(threadId);
    if (getState().threadId === threadId) {
      const notice = getState().notice;
      newThread();
      if (notice !== null) applyServerEvent({ notice });
    }
  }

  /** A new chat for this message; null, with the text back in the box, when the server does not answer. */
  async function createThread(content: string, model: string | undefined, fromDraft = true): Promise<string | null> {
    const version = getDraft().version;
    if (creatingDrafts.has(version)) return null;
    creatingDrafts.add(version);
    try {
      let at = 0;
      const t = await call("threads.create", { title: titleFrom(content) || "Attached images" }, { onResult: (made, sync) => {
        rowAnswered(made, sync);
        at = numbers.of(sync, chatScope(made.id)) ?? numbers.asked(made.id);
      } });
      // Its history is known empty, so loadThread never runs for it: record the model it starts on here.
      const own = model === undefined ? {} : { threadModels: { ...getState().threadModels, [t.id]: model } };
      numbers.hold(t.id, at);
      applyServerEvent((st) => ({ messages: { ...st.messages, [t.id]: [] }, ...own }));
      openThread(t.id);
      return t.id;
    } catch {
      applyServerEvent({ notice: fromDraft ? "The message didn't send. Gates Local isn't answering; your words are still in the composer." : "The message didn't send. Gates Local isn't answering." });
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
    noteMessage, loadThread, restoreSaved, reloadThread, loading,
    preloadThread, loadEarlier,
    /** How many saved messages come before the ones loaded in this thread. */
    earlierOf: (threadId: string) => earlierCounts.get(threadId) ?? 0,
    onEarlier(listener: () => void) {
      earlierListeners.add(listener);
      return () => { earlierListeners.delete(listener); };
    },
    rowPushed, listArrived, rowAnswered,
    renameThread, deleteThread, waitForThreadDeletion, createThread, untrackedDone, imageSaved,
    creatingDraft: (version: number) => creatingDrafts.has(version),
    /**
     * A new connection. On the same server (its epoch unchanged) every number the window holds stays,
     * and the list read that follows says which cached chats moved. A restarted server or a legacy
     * connection forgets them: each cached chat is read again on its next visit, and a preview or a
     * read ahead from before is not used.
     */
    connected(epoch: string | undefined) {
      if (!numbers.begin(epoch, Object.keys(getState().messages))) return;
      previews.clear();
      if (preloading !== null) preloading.cancelled = true;
    },
  };
}
