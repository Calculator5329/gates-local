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
  const loads = new Set<{ readonly threadId: string; readonly seq: number; readonly since: Message[] }>();

  /** Each thread load's ticket, in the order they were sent. */
  let loadSeq = 0;
  /** Per thread, the ticket of the newest load whose snapshot landed: an older load's answer, snapshot or failure, never replaces it. */
  const landed = new Map<string, number>();

  /** Threads whose history landed before any model list: their saved model is decided when one lands (MP5-02). */
  const unrestored = new Set<string>();

  const creatingDrafts = new Set<number>();

  async function refreshThreads(): Promise<void> {
    const ticket = threadsOrder.next();
    const threads = await call("threads.list", {}).catch(() => undefined);
    if (threads === undefined || !threadsOrder.current(ticket)) return;
    applyServerEvent((s) => {
      const open = s.threadId !== null && threads.some((t) => t.id === s.threadId);
      const threadModels = Object.fromEntries(Object.entries(s.threadModels).filter(([id]) => threads.some((t) => t.id === id)));
      return { threads: sortThreads(threads), threadModels, ...(s.view === "thread" && !open ? { view: "new" as const, threadId: null } : {}) };
    });
  }

  /** A message this client learned outside a thread load: the loads in flight for its thread replay it. */
  function noteMessage(threadId: string, msg: Message): void {
    for (const l of loads) if (l.threadId === threadId) l.since.push(msg);
  }

  async function loadThread(threadId: string, force = false): Promise<void> {
    if (!force && getState().messages[threadId] !== undefined && !stale.has(threadId)) return;
    const nav = navigationGeneration();
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
      applyServerEvent((s) => ({
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
      if (codeOf(e) === "thread-not-found" && nav === navigationGeneration() && pendingSettings() === null && s.view === "thread" && s.threadId === threadId) applyServerEvent({ view: "new", threadId: null });
    } finally {
      loads.delete(req);
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
    return [...loads].some((l) => l.threadId === threadId);
  }

  async function renameThread(threadId: string, title: string): Promise<void> {
    const t = title.trim();
    if (t === "") return;
    await call("threads.rename", { threadId, title: t }).catch(() => undefined);
  }

  async function deleteThread(threadId: string): Promise<void> {
    await call("threads.delete", { threadId }).catch(() => undefined);
    threadsOrder.next();
    applyServerEvent((s) => {
      const { [threadId]: _gone, ...messages } = s.messages;
      const { [threadId]: _model, ...threadModels } = s.threadModels;
      const { [threadId]: _error, ...loadErrors } = s.loadErrors;
      return { messages, threadModels, loadErrors, threads: s.threads.filter((t) => t.id !== threadId), queued: s.queued.filter((q) => q.threadId !== threadId) };
    });
    if (getState().threadId === threadId) newThread();
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
    const s = getState();
    if (s.messages[threadId] !== undefined || s.threadId === threadId || loading(threadId)) void loadThread(threadId, true);
  }

  return {
    refreshThreads, noteMessage, loadThread, restoreSaved, reloadThread, loading,
    renameThread, deleteThread, createThread, untrackedDone, imageSaved,
    creatingDraft: (version: number) => creatingDrafts.has(version),
    listOrder: threadsOrder,
    markOtherThreadsStale(s: State) {
      for (const id of Object.keys(s.messages)) if (id !== s.threadId) stale.add(id);
    },
  };
}
