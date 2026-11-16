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

export const PAGE_MESSAGES = 200;
const HOVER_INTENT_MS = 160;

export function sortThreads<T extends { updatedAt: number }>(threads: readonly T[]): T[] {
  return threads.toSorted((a, b) => b.updatedAt - a.updatedAt);
}


function upsertMessage(list: readonly Message[], msg: Message): readonly Message[] {
  const i = list.findIndex((m) => m.id === msg.id);
  return i < 0 ? [...list, msg] : list.map((m, j) => (j === i ? msg : m));
}

export function withMessage(s: State, threadId: string, msg: Message): State["messages"] {
  return { ...s.messages, [threadId]: upsertMessage(s.messages[threadId] ?? [], msg) };
}

function savedModel(s: State, threadId: string, messages: State["messages"][string]): Partial<State> {
  if (s.threadModels[threadId] !== undefined || s.models === undefined) return {};
  const saved = messages.findLast((m) => m.role === "assistant" && m.model !== undefined)?.model;
  const m = s.models.find((x) => x.name === saved);
  if (m === undefined || !choosable(m)) return {};
  return { threadModels: { ...s.threadModels, [threadId]: m.name }, ...(s.threadId === threadId ? { model: m.name } : {}) };
}

function savedReplyFor(live: LiveTurn | null, threadId: string, messages: readonly Message[]): boolean {
  if (live === null || live.threadId !== threadId || live.end === undefined || live.userMessageId === undefined) return false;
  const i = messages.findIndex((m) => m.id === live.userMessageId);
  return i >= 0 && messages.slice(i + 1).some((m) => m.role === "assistant");
}

export function threadMarkdown(threadId: string, messages: readonly Message[]): string {
  const s = getState();
  const t = s.threads.find((x) => x.id === threadId);
  const lines = [`# ${t?.title ?? "Thread"}`, ""];
  for (const m of messages) {
    lines.push(m.role === "user" ? "## You" : `## ${describeModel(m.model ?? "", catalogOf(s)).name || "Reply"}`, "", m.content, "");
  }
  return lines.join("\n");
}

// why: session.ts wires navigation and RPC; load-ordering guards stay next to their loads
export function createThreads({ applyServerEvent, call, codeOf, failure, openThread, newThread, navigationGeneration, pendingSettings }: ThreadEffects) {
  function setLoadError(threadId: string, message: string | null): void {
    if ((getState().loadErrors[threadId] ?? null) === message) return;
    applyServerEvent((s) => {
      const { [threadId]: _old, ...rest } = s.loadErrors;
      return { loadErrors: message === null ? rest : { ...rest, [threadId]: message } };
    });
  }

  const numbers = createThreadNumbers();

  const loads = new Set<{ readonly threadId: string; readonly seq: number; readonly since: Message[]; readonly preload?: Preload | undefined }>();

  let loadSeq = 0;
  const landed = new Map<string, number>();

  const earlierCounts = new Map<string, number>();
  const earlierListeners = new Set<() => void>();
  function setEarlier(threadId: string, count: number): void {
    if ((earlierCounts.get(threadId) ?? 0) === count) return;
    if (count === 0) earlierCounts.delete(threadId);
    else earlierCounts.set(threadId, count);
    for (const listener of earlierListeners) listener();
  }
  const fetchingEarlier = new Map<string, Promise<boolean>>();

  const unrestored = new Set<string>();

  const creatingDrafts = new Set<number>();
  const previews = new Map<string, { messages: readonly Message[]; earlier: number; size: number; at: number }>();
  interface Preload {
    readonly threadId: string;
    cancelled: boolean;
    used: boolean;
    navigation?: number;
    completion: Promise<void>;
  }
  let preloading: Preload | null = null;
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

  // why: the RPC wire has no cancel for reads, so a read already sent finishes in its one slot
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

  function forget(threadId: string): void {
    invalidatePreload(threadId);
    dropDraft(threadId);
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

  function applyRow(threadId: string, thread: Thread | null, sync: SyncMetadata | undefined): void {
    if (!numbers.row(threadId, numbers.of(sync, "threads"))) return;
    if (thread === null) {
      forget(threadId);
      const s = getState();
      if (s.view === "thread" && s.threadId === threadId) applyServerEvent({ view: "new", threadId: null });
      return;
    }
    applyServerEvent((s) => ({ threads: sortThreads([thread, ...s.threads.filter((t) => t.id !== threadId)]) }));
  }

  function rowPushed({ threadId, thread }: Payload<"threads.changed">, sync: SyncMetadata | undefined): void {
    applyRow(threadId, thread, sync);
    if (thread === null) return;
    numbers.announce(threadId, numbers.of(sync, chatScope(threadId)));
    const preview = previews.get(threadId);
    if (preview !== undefined && preview.at < numbers.known(threadId)) previews.delete(threadId);
    if (getState().threadId === threadId && !loading(threadId) && !numbers.current(threadId)) void loadThread(threadId, true);
  }

  function listArrived(threads: readonly Thread[], sync: SyncMetadata | undefined): void {
    const newer = numbers.list(numbers.of(sync, "threads"));
    if (newer === undefined) return;
    for (const t of threads) if (!newer.has(t.id)) numbers.announce(t.id, numbers.of(sync, chatScope(t.id)));
    applyServerEvent((s) => {
      const listed = sortThreads([...threads.filter((t) => !newer.has(t.id)), ...s.threads.filter((t) => newer.has(t.id))]);
      const threadModels = Object.fromEntries(Object.entries(s.threadModels).filter(([id]) => listed.some((t) => t.id === id) || id === s.threadId));
      return { threads: listed, threadModels };
    });
  }

  // why: the rows came with their record; a copy current before them is current at their number
  function rowsSaved(threadId: string, chatNumber: number): void {
    if (getState().messages[threadId] === undefined || loading(threadId) || !numbers.current(threadId)) return;
    numbers.announce(threadId, chatNumber);
    numbers.hold(threadId, chatNumber);
  }

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
    let at = numbers.asked(threadId);
    try {
      const limit = Math.max(PAGE_MESSAGES, getState().messages[threadId]?.length ?? 0);
      const { messages: snapshot, earlier = 0 } = await call("threads.get", { threadId, limit }, { onResult: (_, sync) => { at = numbers.of(sync, chatScope(threadId)) ?? at; } });
      if (older()) return;
      const front = getState().messages[threadId]?.[0];
      if (at < numbers.known(threadId)) outdated = preload === undefined || preload.used;
      else if (!again && (preload === undefined || preload.used) && earlier > 0 && front !== undefined && !snapshot.some((m) => m.id === front.id)) wider = true;
      else {
        landed.set(threadId, req.seq);
        const messages = req.since.reduce(upsertMessage, snapshot);
        if (preload !== undefined && !preload.used) keepPreview(threadId, messages, earlier, at);
        else installHistory(threadId, messages, earlier, at);
      }
    } catch (e) {
      if (older()) return;
      if (preload !== undefined && !preload.used) return;
      landed.set(threadId, req.seq);
      setLoadError(threadId, failure("load this conversation", e));
      const s = getState();
      if (codeOf(e) === "thread-not-found" && (preload?.navigation ?? nav) === navigationGeneration() && pendingSettings() === null && s.view === "thread" && s.threadId === threadId) applyServerEvent({ view: "new", threadId: null });
    } finally {
      loads.delete(req);
      if (preload !== undefined && preloading === preload) preloading = null;
    }
    if (wider) await fetchThread(threadId, undefined, true);
    else if (outdated) await fetchThread(threadId, undefined, again);
  }

  function loadEarlier(threadId: string): Promise<boolean> {
    const pending = fetchingEarlier.get(threadId);
    if (pending !== undefined) return pending;
    const first = getState().messages[threadId]?.[0];
    if (first === undefined || (earlierCounts.get(threadId) ?? 0) === 0) return Promise.resolve(false);
    const page = (async () => {
      try {
        const { messages, earlier = 0 } = await call("threads.get", { threadId, before: first.id, limit: PAGE_MESSAGES });
        if (getState().messages[threadId]?.[0]?.id !== first.id) return false;
        applyServerEvent((s) => {
          const now = s.messages[threadId] ?? [];
          const have = new Set(now.map((m) => m.id));
          return { messages: { ...s.messages, [threadId]: [...messages.filter((m) => !have.has(m.id)), ...now] } };
        });
        setEarlier(threadId, earlier);
        return true;
      } catch (e) {
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

  function reloadThread(threadId: string): void {
    void loadThread(threadId, true);
  }

  function loading(threadId: string): boolean {
    return [...loads].some((l) => l.threadId === threadId && (l.preload === undefined || l.preload.used));
  }

  let actionNotice: { readonly key: string; readonly message: string } | undefined;

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

  function rowAnswered(thread: Thread, sync: SyncMetadata | undefined): void {
    applyRow(thread.id, thread, sync);
  }

  const deletions = new Map<string, Promise<void>>();

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
    if (!await threadAction("delete", threadId, () => call("threads.delete", { threadId }, { onResult: (_, sync) => { numbers.row(threadId, numbers.of(sync, "threads")); } }))) return;
    forget(threadId);
    if (getState().threadId === threadId) {
      const notice = getState().notice;
      newThread();
      if (notice !== null) applyServerEvent({ notice });
    }
  }

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

  function untrackedDone(threadId: string, message: Message): void {
    noteMessage(threadId, message);
    void loadThread(threadId, true);
  }

  function imageSaved(threadId: string): void {
    invalidatePreload(threadId);
    const s = getState();
    if (s.messages[threadId] !== undefined || s.threadId === threadId || loading(threadId)) void loadThread(threadId, true);
  }

  return {
    noteMessage, loadThread, restoreSaved, reloadThread, loading,
    preloadThread, loadEarlier,
    earlierOf: (threadId: string) => earlierCounts.get(threadId) ?? 0,
    onEarlier(listener: () => void) {
      earlierListeners.add(listener);
      return () => { earlierListeners.delete(listener); };
    },
    rowPushed, listArrived, rowAnswered, rowsSaved,
    renameThread, deleteThread, waitForThreadDeletion, createThread, untrackedDone, imageSaved,
    creatingDraft: (version: number) => creatingDrafts.has(version),
    connected(epoch: string) {
      if (!numbers.begin(epoch, Object.keys(getState().messages))) return;
      previews.clear();
      if (preloading !== null) preloading.cancelled = true;
    },
  };
}
