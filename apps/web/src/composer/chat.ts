// Chat admissions, concurrent replies, streaming buffers, and this window's view of the server's queue.
import { type AttachedFile, type BlockingTurn, type ImageChoice, type Message, type MethodName, type Params, type Payload, type QueuedMessage, type ReplyCall, type ReplyOutcome, type ReplyTimes, type ResultOf, type StopConsent, WireError } from "@gates-local/contracts";
import { ctxFor, describeModel, k } from "../lib/words/format.ts";
import { firstChatPull, sendableModel } from "../models/pick.ts";
import { type LiveTurn, NA, type NoticeOffer, type Queued, type State, type StopAsk, chatReady, getState, runningTurn, setState, streamingHere, turnOf } from "../lib/store/store.ts";
import { imageReason } from "./paste.ts";
import { drawChoice, imageMode } from "../image/image-choice.ts";
import { releaseFiles } from "./file-holds.ts";
import { type Draft, type DraftKey, beginQueuedDraft, cancelQueuedDraft, clearDraft, currentDraftKey, getDraft, moveDraft, renewDraft, replaceDraft } from "../lib/store/drafts.ts";
import type { ServerEvent } from "../lib/session/server-state.ts";
import { type ChatEvent, type TurnEvent, reduceTurn, stopping, unfinished, withTurn } from "../thread/turn.ts";
import { stopReason as stopWords } from "../thread/times.ts";

declare global {
  interface Window {
    /**
     * Counters the performance spec reads. terminalFlush is that spec's
     * negative control (test/e2e/perf.spec.ts): the done event makes one
     * extra store publish of the open chat's turn before the saved row replaces it.
     */
    glPerf?: { deltas: number; flushes: number; terminalFlush?: boolean };
  }
}

interface ChatEffects {
  /** A function that returns nothing publishes nothing: no selector runs. */
  readonly applyServerEvent: (event: ServerEvent) => void;
  readonly call: <M extends MethodName>(method: M, params: Params<M>, options?: { readonly timeoutMs?: number }) => Promise<ResultOf<M>>;
  /** A call that names one waiting message, answered with what became of it. */
  readonly reply: <M extends ReplyCall>(method: M, params: Params<M>) => Promise<ReplyOutcome>;
  readonly codeOf: (error: unknown) => string;
  /** `fromDraft` false: the words are not in the composer, so a refusal does not say they are. */
  readonly createThread: (content: string, model: string | undefined, fromDraft?: boolean) => Promise<string | null>;
  readonly creatingDraft: (version: number) => boolean;
  readonly loadThread: (threadId: string, force?: boolean) => Promise<void>;
  readonly loading: (threadId: string) => boolean;
  readonly noteMessage: (threadId: string, message: Message) => void;
  readonly withMessage: (state: State, threadId: string, message: Message) => State["messages"];
  readonly untrackedDone: (threadId: string, message: Message) => void;
  readonly openThread: (threadId: string) => void;
  readonly blockingFor: (model: string, numCtx: number) => Promise<readonly BlockingTurn[]>;
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

const STOP_OTHERS_KEY = "gates-local.stop-others-ok";

const queueId = () => `q-${crypto.randomUUID()}`;

/**
 * The queue is the server's (it keeps it, sends it and pushes every change); a window shows its
 * copy and asks for changes, and its copy changes when the server's answer or list says so.
 * `askServer` is the connection's calls on one waiting message, once createChat has them.
 */
let askServer: ChatEffects["reply"] | undefined;

/** Queued here and not yet acknowledged: shown meanwhile, and asked again after a dropped connection. */
const unsynced = new Map<string, QueuedMessage>();
/** Removed here while the server could not be asked: asked at the next connection, if it has them. */
const removeOwed = new Set<string>();
/** The edit open in this window's composer: the words it started from, and a save whose answer never came. */
let edited: { readonly id: string; readonly base: string; readonly text: string; tried?: string } | null = null;

const ALREADY_SENT = "That message was already sent.";
const ON_ITS_WAY = "This message is already on its way.";
const REMOVED = "That message was removed.";
const OPEN_ELSEWHERE = "That message is open in another window.";
const NOT_REACHED = "Gates Local stopped answering.";
/** Where a message went, for a call that came too late for it. */
const tooLate = (a: Extract<ReplyOutcome, { answer: "gone" | "sending" }>): string => (a.answer === "sending" ? ON_ITS_WAY : a.why === "sent" ? ALREADY_SENT : REMOVED);

/** The words "restored on hold" a reload put up for this browser's own saved queue, which the server's now replaces. */
const RESTORED_NOTICE = "Your queued messages were restored on hold. Use Send now when you are ready.";
/** Set once this browser's saved queue (from before the server kept it) has gone to the server. */
const QUEUE_MOVED_KEY = "gates-local.queue-on-server";

/** Whether this browser's own saved queue has gone to the server; only the hand-over marks it. */
export function queueOnServer(): boolean {
  try {
    return localStorage.getItem(QUEUE_MOVED_KEY) === "1";
  } catch {
    // unknown: a saved queue is shown on hold rather than lost, and the server's copy is not doubled
    return false;
  }
}

/** A message of this browser's old saved queue the server does not have yet: kept saved until it does. */
export function stillOwed(id: string): boolean {
  return unsynced.has(id) || (oldQueue?.some((q) => q.id === id) ?? false);
}

/** This browser's own saved queue not yet handed over: null until the reload has read it. */
let oldQueue: readonly Queued[] | null = null;
let onOldQueue: (() => void) | undefined;

/**
 * The reload read this browser's saved queue (empty when there was none, or it already went). It
 * goes to the server once the server's list is in too, whichever of the two comes first.
 */
export function oldQueueRead(queued: readonly Queued[]): void {
  oldQueue = queued;
  onOldQueue?.();
}

function queueMoved(): void {
  try {
    localStorage.setItem(QUEUE_MOVED_KEY, "1");
  } catch {
    // private windows may refuse storage: what was handed over stays the server's all the same
  }
}

/** The window's copy of a server entry: what it shows and acts on. */
function toQueued(e: QueuedMessage): Queued {
  const { numCtx: _numCtx, think: _think, drawCount: _drawCount, sending: _sending, stopOthers: _stopOthers, stopTurns: _stopTurns, why: _why, ...q } = e;
  return q;
}

/** The row with its edit over, before the server's list says so: no "edited elsewhere" in between. */
function notEditing(q: Queued): Queued {
  if (q.editing === undefined) return q;
  const { editing: _editing, ...rest } = q;
  return rest;
}

type Outgoing = Omit<StopAsk, "blocking">;

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

function stopOthersOk(): boolean {
  try {
    return localStorage.getItem(STOP_OTHERS_KEY) === "1";
  } catch {
    return false;
  }
}

/** What a `keepDraft` send reads in place of the composer's draft: no pictures, no copy identity, no create in flight. */
const APART: Draft = { text: "", images: [], sendId: null, version: -1 };

/** A Send now waits on the server and on the warning: meanwhile the person may have removed its message or opened it for editing. */
function gone(out: Outgoing): boolean {
  const s = getState();
  return out.queuedId !== undefined && (s.editingQueued === out.queuedId || !s.queued.some((q) => q.id === out.queuedId));
}

export function cancelStopAsk(): void {
  setState({ stopAsk: null });
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


/** Retry stays off while the server is still stopping a reply: it refuses a second turn in a thread, and the old turn's events must not land on the new one. */
export function canRetry(s: State): boolean {
  return s.threadId !== null && !streamingHere(s) && !stopping(s.turns[s.threadId]);
}

/** One plain sentence for a reply the server stopped to make way for something else. */
const stopReason = (event: { readonly code: string; readonly neededBy?: string | undefined }): string | undefined => stopWords(event, catalogOf(getState()));

/**
 * The times a row of words kept here carries when the server saved none: its record as the turn
 * ended, every figure the server's. None when the record never said how the turn ended.
 */
function recordTimes(l: LiveTurn): ReplyTimes | undefined {
  const r = l.reply;
  const ended = r?.ended ?? (r?.stoppedAt === undefined ? undefined : { reason: "stopped" as const, at: r.stoppedAt });
  if (r === undefined || ended === undefined) return undefined;
  return {
    startedAt: r.startedAt,
    ...(r.readyAt === undefined ? {} : { readyAt: r.readyAt }),
    ...(r.firstTokenAt === undefined ? {} : { firstTokenAt: r.firstTokenAt }),
    spans: r.spans,
    callsAt: r.callsAt,
    workMs: r.workMs,
    ended,
    // a failure keeps the runtime's text for its tip
    ...(l.end?.kind === "error" ? { why: { code: l.end.code, message: l.end.message } } : {}),
  };
}

/** A row Retry replaces: a stopped reply, or a picture that failed or was cancelled (the server's retriedRows). */
const retriable = (m: Message) => m.interrupted === true || m.imageJob?.state === "error" || m.imageJob?.state === "cancelled";

/** What a Retry replaces on the server: the last question and the unfinished rows after it. None when a finished reply followed: Regenerate is then a new question. */
function retriedRows(messages: readonly Message[]): readonly Message[] {
  const rows = messages.slice(messages.findLastIndex((m) => m.role === "user"));
  return rows[0]?.role === "user" && rows.slice(1).every(retriable) ? rows : [];
}

/** Remove: the message is gone, from every window. Edit is the way to get its words back. */
export function removeQueued(id: string): void {
  void askServer?.("reply.remove", { id }).then((a) => {
    switch (a.answer) {
      case "done":
        dropped(id);
        // after its row is gone from here: a file the queue still names is kept
        return releaseFiles(("files" in a.reply ? a.reply.files ?? [] : []).map((f) => f.path));
      case "gone":
        return dropped(id, a.why === "sent" ? ALREADY_SENT : undefined);
      case "sending":
      case "elsewhere":
        return setState({ notice: ON_ITS_WAY });
      case "not-reached":
        // the server never said it has this one, so this window's copy is the only one known: it
        // goes, and if the server has it after all the next connection removes it there
        if (unsynced.has(id)) {
          removeOwed.add(id);
          return dropped(id);
        }
        return setState({ notice: `${NOT_REACHED} The message was not removed.` });
    }
  });
}

/** The message is gone from this window: its row, an edit of it open here, and a warning asked for it. */
function dropped(id: string, notice?: string): void {
  unsynced.delete(id);
  if (getState().editingQueued === id) cancelQueuedDraft(currentDraftKey());
  if (edited?.id === id) edited = null;
  setState((s) => ({
    queued: s.queued.filter((q) => q.id !== id),
    ...(s.editingQueued === id ? { editingQueued: null } : {}),
    ...(s.stopAsk?.queuedId === id ? { stopAsk: null } : {}),
    ...(notice === undefined ? {} : { notice }),
  }));
}

/** Edit: the words go in the composer and the message keeps its place, unsent, until the next Send updates it. */
export function editQueued(id: string): void {
  const q = getState().queued.find((x) => x.id === id);
  if (!q) return;
  beginQueuedDraft(q.threadId, q.text, q.images ?? [], q.messageId ?? null, q.files);
  edited = { id, base: q.messageId ?? "", text: q.text };
  setState({ editingQueued: id, notice: null, stopAsk: null });
  openEdit(id, q.threadId, q.text);
}

/** The server is asked to keep the message for this window's composer. */
function openEdit(id: string, threadId: string, text: string): void {
  void askServer?.("reply.edit", { id, open: true }).then((a) => {
    switch (a.answer) {
      case "done":
        return;
      case "not-reached":
        // the edit stays open here, and the next connection asks again
        return;
      case "sending":
      case "gone":
        return closeEdit(id, threadId, text, tooLate(a));
      case "elsewhere":
        return closeEdit(id, threadId, text, OPEN_ELSEWHERE);
    }
  });
}

/** An edit that cannot go on closes, saying why; words typed into it stay in the composer as a new message. `text`: the words it opened with, when known. */
function closeEdit(id: string, threadId: DraftKey, text: string | undefined, why: string): void {
  if (getState().editingQueued !== id) return;
  const draft = getDraft(threadId);
  const typed = draft.text !== text;
  if (typed) replaceDraft(threadId, { text: draft.text, images: draft.images, ...(draft.files?.length ? { files: draft.files } : {}), sendId: null });
  else cancelQueuedDraft(threadId);
  if (edited?.id === id) edited = null;
  setState({ editingQueued: null, notice: typed ? `${why} Your new words are still in the composer.` : why });
}

/**
 * A memory refusal's offer taken for a held message: the model and context it now goes with, on
 * the server, which sends it. True once the message has them.
 */
export async function chooseForQueued(id: string, model: string, numCtx: number): Promise<boolean> {
  const q = getState().queued.find((x) => x.id === id);
  if (q === undefined || askServer === undefined) return false;
  const u = unsynced.get(id);
  // not with the server yet: the choice goes with the message when it does
  if (u !== undefined) unsynced.set(id, { ...u, model, numCtx });
  const base = q.messageId ?? "";
  const a = await askServer("reply.change", { id, base, messageId: base, model, numCtx });
  switch (a.answer) {
    case "done":
      return true;
    case "sending":
    case "gone":
      setState({ notice: tooLate(a) });
      return false;
    case "elsewhere":
      setState({ notice: OPEN_ELSEWHERE });
      return false;
    case "not-reached":
      if (u === undefined) setState({ notice: `${NOT_REACHED} Try again.` });
      return u !== undefined;
  }
}

interface TurnOptions {
  readonly messageId?: string;
  readonly stopOthers?: boolean;
  readonly stopTurns?: readonly string[] | undefined;
  /** The person is waiting on it, so a reply in the way can still get the warning; queued messages that go on their own have none. */
  readonly out?: Outgoing;
}

/** Words that came since the last frame, for one turn. */
interface Waiting {
  readonly gen: number;
  text: string;
  thinking: string;
}

/** The turn with the words that waited for a frame. */
function withWaiting(turn: LiveTurn, w: Waiting, now: number): LiveTurn {
  const thought = reduceTurn(turn, { type: "thinking", text: w.thinking }, now) ?? turn;
  return reduceTurn(thought, { type: "delta", text: w.text }, now) ?? thought;
}

/** History, navigation, fit and RPC operations are wired by session.ts. */
export function createChat({ applyServerEvent, call, reply: askOne, codeOf, createThread, creatingDraft, loadThread, loading, noteMessage, withMessage, untrackedDone, openThread, blockingFor }: ChatEffects) {
  askServer = askOne;
  /** Queued messages this window pressed Send now on: a would-stop answer shows the warning here. */
  const nowAsked = new Set<string>();
  /** Queued here to wait for setup or the first download: its chat opens when it goes. */
  const waitedHere = new Set<string>();
  /** Turns the server started for queued messages, until their start: an error before it is a refusal, and the message is back on hold. */
  const queueTurns = new Map<string, string>();
  /** Each queued message's refusal as last said, so it is said once. */
  const refusalSaid = new Map<string, string>();

  /** Hand a message to the server's queue. A dropped connection keeps it here, and the next connection asks again. */
  function enqueue(entry: QueuedMessage): void {
    unsynced.set(entry.id, entry);
    call("queue.add", entry).then(() => { unsynced.delete(entry.id); }, (e: unknown) => {
      const code = codeOf(e);
      if (code === "closed" || code === "timeout") return;
      unsynced.delete(entry.id);
      // removed in another window while this one could not hear it: the removal stands, said nowhere twice
      if (code === "queue-removed") return setState((s) => ({ queued: s.queued.filter((q) => q.id !== entry.id) }));
      // its chat is gone
      setState((s) => ({ queued: s.queued.filter((q) => q.id !== entry.id), notice: "The chat this message was waiting in is gone, so it was not sent." }));
    });
  }

  /**
   * The server's queue, as this window shows it. One on its way becomes its chat's turn, with its
   * words as the question until the start saves them; a new refusal is said once, here as a warning
   * when this window pressed Send now and the yes is the person's to give. `listed`: the snapshot at
   * connect, whose refusals were said before.
   */
  function queueChanged(list: readonly QueuedMessage[], listed = false): void {
    const s = getState();
    const now = Date.now();
    // the server has it: an add whose answer was lost with the connection is not asked again
    for (const e of list) unsynced.delete(e.id);
    // this window's own sends (a Send now's yes) are out of the list until their start
    const waiting = list.filter((e) => e.sending === undefined && !admitting.has(e.messageId)).map(toQueued);
    // a Send now shows first, as it goes first; the server keeps its place for a refusal
    const shown = [...waiting.filter((q) => q.now === true), ...waiting.filter((q) => q.now !== true)];
    const local = [...unsynced.values()].filter((u) => !list.some((e) => e.id === u.id)).map(toQueued);
    let turns = s.turns;
    let notice: string | undefined;
    let noticeOffer: NoticeOffer | undefined;
    let stopAsk: StopAsk | undefined;
    const opening: string[] = [];
    for (const e of list) {
      if (e.sending !== undefined) {
        const turn = turns[e.threadId];
        if (queueTurns.has(e.sending) || (turn !== undefined && turn.turnId !== e.sending && unfinished(turn))) continue;
        queueTurns.set(e.sending, e.id);
        const words = { pendingUser: e.text, pendingImages: e.images ?? [], ...(e.files?.length ? { pendingFiles: e.files } : {}) };
        if (turn?.turnId === e.sending) {
          if (turn.pendingUser === null) turns = withTurn(turns, e.threadId, { ...turn, ...words });
        } else {
          retire(turn);
          turns = withTurn(turns, e.threadId, { gen: ++turnGen, threadId: e.threadId, turnId: e.sending, model: e.draw?.preset ?? e.model ?? "", startedAt: now, thinking: "", text: "", tools: [], ...words, ...(e.draw === undefined ? {} : { image: true as const }) });
        }
        // setup and the first download are the whole app waiting; a queue behind a reply stays out of the way
        if (waitedHere.delete(e.id) && e.waitFor !== "reply" && s.threadId !== e.threadId) opening.push(e.threadId);
        nowAsked.delete(e.id);
        continue;
      }
      if (e.why === undefined) continue;
      const key = JSON.stringify(e.why);
      if (refusalSaid.get(e.id) === key) continue;
      refusalSaid.set(e.id, key);
      if (listed) continue;
      const asked = nowAsked.delete(e.id);
      const here = s.view === "thread" && s.threadId === e.threadId;
      const { code, message, blocking } = e.why;
      const model = e.model ?? s.model ?? "";
      if (code === "would-stop" && blocking !== undefined && asked && here) {
        stopAsk = { content: e.text, images: e.images ?? [], ...(e.files ? { files: e.files } : {}), messageId: e.messageId, model, threadId: e.threadId, keepDraft: true, queuedId: e.id, ...(e.draw === undefined ? {} : { draw: e.draw }), blocking };
      } else {
        notice = !here ? elsewhereNotice(s, e.threadId) : code === "gpu-unreadable" ? `${message} Your message is back in the queue.` : code === "image-input" ? message : refusal(code, model, "queue");
        // a memory refusal in view says what runs instead, as a send from the box does
        const offer = here && code === "wont-fit" ? e.why.offer : undefined;
        noticeOffer = offer === undefined ? undefined : { notice, model, numCtx: e.numCtx ?? ctxFor(s.numCtx, s.models, model), offer };
      }
    }
    for (const id of refusalSaid.keys()) if (!list.some((e) => e.id === id)) refusalSaid.delete(id);
    applyServerEvent({
      queued: [...shown, ...local],
      ...(turns === s.turns ? {} : { turns }),
      ...(stopAsk === undefined ? {} : { stopAsk, notice: null }),
      ...(notice === undefined ? {} : { notice, noticeOffer: noticeOffer ?? null }),
    });
    for (const threadId of opening) openThread(threadId);
  }

  /**
   * The queue at connect. What this window queued while the connection was down goes now; a queue
   * this browser kept itself before the server did goes once, on hold; one it kept since is only the
   * server's own, and the server's wins. An edit open here keeps its message from going.
   */
  /** The server's ids at the last connect: undefined before the first. */
  let listedIds: ReadonlySet<string> | undefined;
  /** This browser's old saved queue goes to the server once both are known: what it saved, and the server's list. */
  function moveOldQueue(sendNow: boolean): number {
    if (oldQueue === null || oldQueue.length === 0 || listedIds === undefined) return 0;
    const s = getState();
    const ids = listedIds;
    const older = oldQueue.filter((q) => !ids.has(q.id) && !unsynced.has(q.id));
    oldQueue = [];
    queueMoved();
    for (const q of older) {
      const entry: QueuedMessage = { ...q, messageId: q.messageId ?? queueId(), waitFor: "reply", held: true, numCtx: s.numCtx, think: s.think };
      if (sendNow) enqueue(entry);
      else unsynced.set(q.id, entry);
    }
    return older.length;
  }
  onOldQueue = () => void moveOldQueue(true);

  function queueListed(list: readonly QueuedMessage[]): void {
    const s = getState();
    const has = (id: string) => list.some((e) => e.id === id);
    listedIds = new Set(list.map((e) => e.id));
    const moved = moveOldQueue(false);
    for (const u of unsynced.values()) if (!has(u.id)) enqueue(u);
    for (const id of removeOwed) if (has(id)) removeQueued(id);
    removeOwed.clear();
    if (moved === 0 && oldQueue !== null && s.notice === RESTORED_NOTICE) setState({ notice: null });
    const editing = list.find((e) => e.id === s.editingQueued);
    if (editing !== undefined && editing.editing !== true && editing.sending === undefined) openEdit(editing.id, editing.threadId, edited?.id === editing.id ? edited.text : editing.text);
    queueChanged(list, true);
  }

  /** An edit ended without a Send (Cancel, or leaving the chat): the message goes on as it was. */
  function editEnded(id: string): void {
    if (edited?.id === id) edited = null;
    setState((s) => ({ queued: s.queued.map((q) => (q.id === id ? notEditing(q) : q)) }));
    // whatever the answer, the edit is over in this window: the message left, another window has
    // it, or the server frees it when it sees this connection close
    void askOne("reply.edit", { id, open: false });
  }

  /** An Update asked and not yet answered: a second press in that moment is the same save. */
  let saving: string | null = null;

  /**
   * Update: the edited words go to the server, and stay in the composer until it says they are
   * the message's. Any other answer leaves them there and says what became of the message.
   */
  async function saveEdit(id: string, key: DraftKey, words: { readonly content: string; readonly images: readonly string[]; readonly files: readonly AttachedFile[]; readonly messageId: string }): Promise<void> {
    if (saving === id) return;
    saving = id;
    const started = edited?.id === id ? edited : undefined;
    const row = getState().queued.find((q) => q.id === id);
    // the words this edit started from, unless the list shows an earlier save of this edit landed after all
    const base = row?.messageId !== undefined && row.messageId === started?.tried ? row.messageId : started?.base ?? row?.messageId ?? words.messageId;
    const a = await askOne("reply.change", { id, base, messageId: words.messageId, text: words.content, images: [...words.images], files: [...words.files] });
    saving = null;
    // the chat was left meanwhile, which ended the edit
    if (getState().editingQueued !== id) return;
    switch (a.answer) {
      case "done":
        cancelQueuedDraft(key);
        edited = null;
        return setState({ editingQueued: null, notice: null });
      case "not-reached":
        // the same words saved again are the same change, done once
        if (started !== undefined) started.tried = words.messageId;
        replaceDraft(key, { sendId: words.messageId });
        return setState({ notice: `${NOT_REACHED} Your edit is still open. Press Update again.` });
      case "sending":
      case "gone":
        return closeEdit(id, key, started?.text, tooLate(a));
      case "elsewhere":
        return closeEdit(id, key, started?.text, "That message was changed in another window.");
    }
  }
  /** A saved user message confirms its exact copy; edited words already have a new identity. */
  function confirmCopy(message: Message): void {
    // the server sent it: a queued copy this window still holds is never asked for again
    for (const [id, u] of unsynced) if (u.messageId === message.id) unsynced.delete(id);
    const matchedDraft = getDraft(message.threadId).sendId === message.id;
    if (matchedDraft) {
      if (getDraft(message.threadId).beforeEdit) cancelQueuedDraft(message.threadId);
      else clearDraft(message.threadId);
    } else {
      // reworded while it sent: the new words stay, and a paste or dictation meant for the edit is dropped
      const { queued, editingQueued } = getState();
      if (queued.some(q => q.messageId === message.id && q.id === editingQueued)) renewDraft(message.threadId);
    }
    applyServerEvent(s => {
      const queued = s.queued.find(q => q.messageId === message.id);
      const editing = queued !== undefined && queued.id === s.editingQueued;
      const draft = matchedDraft;
      const ask = s.stopAsk?.messageId === message.id;
      if (!queued && !draft && !ask) return {};
      return {
        ...(queued ? { queued: s.queued.filter(q => q.messageId !== message.id) } : {}),
        ...(editing ? { editingQueued: null } : {}),
        ...(ask ? { stopAsk: null } : {}),
      };
    });
  }

  const perf: NonNullable<Window["glPerf"]> = { deltas: 0, flushes: 0 };
  window.glPerf = perf;

  /** Turns started this session; each turn carries its number (LiveTurn.gen). */
  let turnGen = 0;
  /**
   * Ids of turns this client stopped or replaced, until their terminal event.
   * A replaced turn is no longer in the map, so this is what keeps its late
   * events off the turn that took its chat's place while that one waits for
   * its own id (W-02, WF-01). Its terminal event still brings the rows it
   * saved, with how it ended stamped on them.
   */
  const oldTurns = new Set<string>();
  /** Turns (by number) whose Stop was pressed before chat.send gave them an id: the stop is asked once it answers, and a refusal meanwhile is not said. */
  const stopAsked = new Set<number>();

  /** Apply one event to a thread's turn, if that turn is still the one numbered `gen`. */
  function update(threadId: string, gen: number, event: TurnEvent): void {
    applyServerEvent((s) => {
      const turn = s.turns[threadId];
      if (turn === undefined || turn.gen !== gen) return;
      return { turns: withTurn(s.turns, threadId, reduceTurn(turn, event, Date.now())) };
    });
  }

  /**
   * A turn leaving the map: its id, when known, is retired, so its late events
   * never reach the turn that replaces it (WF-01); words it showed that no saved
   * row will bring stay in its chat.
   */
  function retire(turn: LiveTurn | undefined, keepWords = true): void {
    // a listed turn has shown nothing, and its events, if they come, start it afresh
    if (turn === undefined || turn.listed === true) return;
    // a Retry replaces what it stopped: nothing is said under its question
    if (turn.turnId !== null) oldTurns.add(turn.turnId);
    if (keepWords) keepStoppedWords(turn);
  }

  /**
   * Replies that ended (stopped, failed or cut off) stay in their chat with
   * their Retry until the person moves on: a send, or opening a chat whose
   * reply is running. Then their words become rows with their note, except in
   * the chat a Retry is replacing them in.
   */
  function settleEnded(except?: string, regenerating?: string): void {
    const ended = Object.values(getState().turns).filter((t) => t.end !== undefined && t.threadId !== except);
    if (ended.length === 0) return;
    for (const t of ended) retire(t, t.threadId !== regenerating);
    applyServerEvent((s) => ({ turns: ended.reduce((turns, t) => (turns[t.threadId]?.gen === t.gen ? withTurn(turns, t.threadId, null) : turns), s.turns) }));
  }

  /**
   * This client's sends that have not started yet, by the message id each asks the
   * server to save: the turn's start brings the saved question with that id, and an error before
   * it is the refusal, which puts the words back. `turnId` is the one chat.send answered with; the
   * start, which names the question, can also be told apart before the answer is read.
   */
  interface Admitting {
    readonly threadId: string;
    readonly gen: number;
    turnId?: string;
    readonly started: (question: Message) => void;
    readonly refused: (e: WireError) => void;
  }
  const admitting = new Map<string, Admitting>();
  const admittingTurn = (turnId: string) => [...admitting.entries()].find(([, a]) => a.turnId === turnId);
  /** The send a start belongs to: by its turn id once answered, else by the question it saved, which names the message id the send asked for. */
  function ownAdmission(turnId: string, threadId: string, questionId: string): [string, Admitting] | undefined {
    const answered = admittingTurn(turnId);
    if (answered !== undefined) return answered;
    const asked = admitting.get(questionId);
    return asked !== undefined && asked.threadId === threadId && asked.turnId === undefined ? [questionId, asked] : undefined;
  }

  /** `keepDraft`: words from elsewhere (a Library question). The composer's draft is not this message: none of its pictures go, and it is left as it is, here and after the new chat exists. */
  async function send(text: string, opts: { reuseThread?: boolean; keepDraft?: true; draw?: ImageChoice } = {}): Promise<void> {
    const content = text.trim();
    const s = getState();
    const key = currentDraftKey();
    const apart = opts.keepDraft === true;
    const draft = apart ? APART : getDraft(key);
    const images = draft.images;
    const files = draft.files ?? [];
    const attached = files.length ? { files } : {};
    if (creatingDraft(draft.version)) return;
    if ((content === "" && images.length === 0 && files.length === 0) || asking) return;
    if (s.pasting) return;
    // Image on: the words go to the image model, so no chat model has to be ready, see the attachments or fit.
    // `draw`: a picture's own setup (Pictures' Again), whatever the composer is set to.
    const draw = opts.draw ?? drawChoice(s);
    if (draw === undefined && imageMode(s)) return setState({ notice: "The image models are still being read. Send again in a moment." });
    const cannotSee = draw === undefined ? imageReason(s.models, s.model, images) : null;
    if (cannotSee) return setState({ notice: cannotSee });
    const threadId = s.view === "thread" || opts.reuseThread ? s.threadId : null;
    const messageId = draft.sendId ?? queueId();
    if (s.editingQueued !== null && !apart) return saveEdit(s.editingQueued, key, { content, images, files, messageId });
    const wait = (draw === undefined ? queueReason(s) : null) ?? (streamingHere(s) ? "reply" : null);
    if (!(draw === undefined ? chatReady(s) : s.conn.kind === "open") && wait === null) return;
    const model = sendableModel(s.models, s.model);
    if (model === undefined && draw === undefined && wait === null) return;
    const drawing = draw === undefined ? {} : { draw };

    if (wait === null) return admit({ content, images, ...attached, messageId, model: model ?? "", threadId, keepDraft: apart, ...drawing });
    // Keep the draft visible while a first thread is being created.
    const queueIn = threadId ?? (await createThread(content, model, !apart));
    if (queueIn === null) return;
    const q: Queued = { id: queueId(), messageId, threadId: queueIn, text: content, images, ...attached, at: Date.now(), waitFor: wait, ...(model === undefined ? {} : { model }), ...drawing };
    // Unchanged since Send, by its words: New thread during the creation gives the same draft a new identity.
    const now = getDraft(key);
    if (!apart && now.text === draft.text && now.images === draft.images && now.files === draft.files && now.sendId === draft.sendId) clearDraft(key);
    if (key === null && !apart) moveDraft(null, queueIn);
    settleEnded();
    setState((st) => ({ notice: null, stopAsk: null, queued: [...st.queued, q] }));
    if (wait !== "reply") waitedHere.add(q.id);
    // the server sends it as this window would have: the context and thinking set now, a picture at its chat's count
    const drawCount = draw === undefined ? undefined : threadId === null ? s.imageCountNew : s.threads.find((t) => t.id === queueIn)?.imageCount ?? 1;
    enqueue({ ...q, messageId, numCtx: s.numCtx, think: s.think, ...(drawCount === undefined ? {} : { drawCount }) });
  }

  /** The server is being asked what a send would stop; a second Enter in that moment is the same send. */
  let asking = false;

  /** Every send from the person goes through here: the server says whether it would stop another chat, and the warning asks once. */
  async function admit(out: Outgoing): Promise<void> {
    if (asking) return;
    out = { ...out, messageId: out.messageId ?? queueId() };
    asking = true;
    // a picture loads no chat model, so it stops no other chat's reply (the image job keeps its own GPU rules)
    let blocking: readonly BlockingTurn[] = [];
    if (out.draw === undefined) {
      // the server plans beside the running replies, which can take a second: Send shows it is on its way
      setState({ asking: true });
      try {
        blocking = await blockingFor(out.model, getState().numCtx);
      } finally {
        setState({ asking: undefined });
      }
    }
    asking = false;
    if (gone(out)) return;
    if (blocking.length > 0 && !stopOthersOk()) {
      setState({ stopAsk: { ...out, blocking }, notice: null });
      return;
    }
    await launch(out, blocking.length > 0);
  }

  /** `stopTurns`: the turns a warning named and the person agreed to; without it, standing consent. */
  async function launch(out: Outgoing, stopOthers: boolean, stopTurns?: readonly string[]): Promise<void> {
    if (gone(out)) return setState({ stopAsk: null });
    if (out.queuedId !== undefined) return queueNow(out.queuedId, stopOthers, stopTurns);
    settleEnded(undefined, out.regenerate === true ? out.threadId ?? undefined : undefined);
    // Keep the words in view until a new chat exists. A failed create leaves the draft alone.
    const threadId = out.threadId ?? (await createThread(out.content, out.model === "" ? undefined : out.model, !out.keepDraft));
    if (threadId === null) return;
    const draftKey = out.threadId;
    const draft = getDraft(draftKey);
    if (!out.keepDraft && draft.text.trim() === out.content && draft.images === out.images && (draft.files ?? []).length === (out.files ?? []).length) clearDraft(draftKey);
    // A new chat for words from elsewhere leaves the new-chat draft where it was.
    if (out.threadId === null && !out.keepDraft) moveDraft(null, threadId);
    setState({ notice: null, stopAsk: null });
    await startTurn(threadId, out.content, out.model, { stopOthers, stopTurns, out });
  }

  /**
   * Send now, once nothing in its way needs a yes (or the yes is given): the server sends it first,
   * as soon as its chat has no reply running. `stopOthers` with no `stopTurns` is standing consent.
   */
  function queueNow(id: string, stopOthers: boolean, stopTurns?: readonly string[]): void {
    if (!getState().queued.some((x) => x.id === id)) return;
    nowAsked.add(id);
    setState({ stopAsk: null, notice: null });
    const consent: StopConsent | undefined = !stopOthers ? undefined : stopTurns === undefined ? { kind: "standing" } : { kind: "named", replies: [...stopTurns] };
    void askOne("reply.now", { id, ...(consent === undefined ? {} : { consent }) }).then((a) => {
      switch (a.answer) {
        case "done":
          // the server's list already shows it first
          return;
        case "sending":
        case "gone":
          nowAsked.delete(id);
          return setState({ notice: tooLate(a) });
        case "elsewhere":
          nowAsked.delete(id);
          return setState({ notice: OPEN_ELSEWHERE });
        case "not-reached":
          nowAsked.delete(id);
          return setState({ notice: `${NOT_REACHED} The message is still waiting.` });
      }
    });
  }

  /** The warning's action. `dontShowAgain` is saved only here, so a Cancel with the box ticked changes nothing. */
  function confirmStopAsk(dontShowAgain: boolean): void {
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

  /** A stopped or failed reply without a saved partial keeps its words in this client's chat. Not while the server is still stopping it: its terminal event is on its way and brings the saved row. */
  function keepStoppedWords(l: LiveTurn): void {
    if (l.end === undefined || stopping(l) || (l.end.kind === "error" && l.end.code === "closed") || (l.text === "" && l.thinking === "" && l.tools.length === 0)) return;
    const { threadId } = l;
    // a call the person's Stop cut short is kept as stopped, one that a failure cut as failed
    const stopped = l.end.kind === "stopped";
    const tools = l.tools.map((t) => t.state === "running" ? { ...t, state: "error" as const, ...(stopped ? { stopped: true as const } : {}) } : t);
    const times = recordTimes(l);
    const msg: Message = { id: `stopped-${l.gen}`, threadId, role: "assistant", content: l.text, ...(l.thinking === "" ? {} : { thinking: l.thinking }), ...(tools.length === 0 ? {} : { tools }),
      model: l.model, createdAt: Date.now(), ...(times === undefined ? { interrupted: true as const } : { times }) };
    // A partial is not the whole history of a chat this client never opened.
    if (getState().messages[threadId] === undefined && !loading(threadId)) void loadThread(threadId);
    noteMessage(threadId, msg);
    applyServerEvent((s) => ({ messages: withMessage(s, threadId, msg) }));
  }

  async function startTurn(threadId: string, content: string, model: string, opts: TurnOptions = {}): Promise<void> {
    const s = getState();
    // a stopped reply's words stay in its chat, unless this is a Retry there, which is asking to replace them
    retire(s.turns[threadId], opts.out?.regenerate !== true);
    const images = opts.out?.images ?? [];
    const files = opts.out?.files ?? [];
    const gen = ++turnGen;
    const replacing = opts.out?.regenerate === true ? retriedRows(s.messages[threadId] ?? []) : [];
    // the server has taken the old rows out in the same write that saved the new question
    const replacedIds = new Set(replacing.map((m) => m.id));
    const withoutReplaced = (st: State): State => replacing.length === 0 ? st : { ...st, messages: { ...st.messages, [threadId]: (st.messages[threadId] ?? []).filter((m) => !replacedIds.has(m.id)) } };
    const messageId = opts.out?.messageId ?? queueId();
    opts = { ...opts, messageId };
    const draw = opts.out?.draw;
    // a new thread's first send carries the count picked before it existed; a thread keeps its own
    const fresh = opts.out?.threadId === null;
    const drawCount = draw === undefined ? undefined : fresh ? s.imageCountNew : s.threads.find((t) => t.id === threadId)?.imageCount ?? 1;
    const startedAt = Date.now();
    const turn: LiveTurn = { gen, threadId, turnId: null, model: draw?.preset ?? model, startedAt, thinking: "", text: "", tools: [], pendingUser: content, pendingImages: images, ...(files.length ? { pendingFiles: files } : {}), ...(draw === undefined ? {} : { image: true as const }) };
    // Using is a turn that starts: a send, a queued send, Retry or Regenerate, after any warning was answered.
    // The next new chat starts on this model (navigation.ts newThread). An Image send uses no chat model.
    setState(st => ({ turns: withTurn(st.turns, threadId, turn), ...(model === "" || draw !== undefined ? {} : { chosen: model }) }));
    const own: Admitting = {
      threadId,
      gen,
      started: (question) => {
        noteMessage(threadId, question);
        applyServerEvent((st) => ({ messages: withMessage(withoutReplaced(st), threadId, question) }));
        // the phone's pick for a new chat went with its first send, which the thread keeps; the next new chat starts from Settings
        if (draw !== undefined && fresh) {
          // the thread keeps the count now (the server saved it with this send), so the button does not blink back to 1 before the list says so
          applyServerEvent((st) => ({
            ...st.imagePick?.preset === draw.preset && st.imagePick.width === draw.width && st.imagePick.height === draw.height ? { imagePick: undefined } : {},
            imageCountNew: 1,
            threads: st.threads.map((t) => (t.id === threadId && drawCount !== undefined && drawCount > 1 ? { ...t, imageCount: drawCount } : t)),
          }));
        }
      },
      refused: (e) => notStarted(e, gen, threadId, content, model, opts),
    };
    admitting.set(messageId, own);
    try {
      const r = await call("chat.send", {
        threadId,
        content,
        messageId,
        ...(replacing[0] === undefined ? {} : { retryOf: replacing[0].id }),
        model,
        numCtx: s.numCtx,
        think: s.think,
        ...(images.length ? { images } : {}),
        ...(files.length ? { files: [...files] } : {}),
        ...(draw === undefined ? {} : { draw, drawCount }),
        ...(opts.stopOthers ? { stopOthers: true, ...(opts.stopTurns === undefined ? {} : { stopTurns: opts.stopTurns }) } : opts.out === undefined ? {} : { askFirst: true }),
      });
      const saved = r.userMessage;
      if (r.replayed && saved !== undefined) {
        if (admitting.get(messageId) === own) admitting.delete(messageId);
        confirmCopy(saved);
        noteMessage(threadId, saved);
        // the first send's turn may still be writing, and its start already made this the turn that shows it
        const running = own.turnId !== undefined;
        applyServerEvent(st => ({ messages: withMessage(st, threadId, saved), notice: "Your message was already sent. It was not sent again.", ...(!running && st.turns[threadId]?.gen === gen ? { turns: withTurn(st.turns, threadId, null) } : {}) }));
        await loadThread(threadId, true);
        return;
      }
      // its start may have come already, and bound the turn's id (turnEvent)
      if (own.turnId === undefined) {
        own.turnId = r.turnId;
        update(threadId, gen, { type: "sent", turnId: r.turnId });
      }
      const now = getState().turns[threadId];
      // the turn that shows is this send's, or one its start made here before the answer came
      const mine = now !== undefined && (now.gen === gen || now.turnId === r.turnId);
      // replaced by a newer turn: its late events stay off that one
      if (!mine) oldTurns.add(r.turnId);
      // Stop was pressed before its id was known, or it was replaced: the server ends it
      if (stopAsked.delete(gen) || !mine) void askOne("reply.stop", { id: r.turnId });
    } catch (e) {
      if (admitting.get(messageId) !== own) return;
      admitting.delete(messageId);
      notStarted(e, gen, threadId, content, model, opts);
    }
  }

  /** chat.send was refused, or the turn ended before its start: nothing was saved. */
  function notStarted(e: unknown, gen: number, threadId: string, content: string, model: string, opts: TurnOptions): void {
    notSent(e, gen, threadId, content, model, opts);
  }

  /**
   * chat.send was refused, so nothing was saved: the words go where the person
   * will find them (a queued message the server sent is the server's to put
   * back). Other words go back in their thread's empty draft, even off
   * screen, else on hold in that chat's queue. A Retry's are already in the chat.
   * A reply in the way that the preflight missed gets the usual warning, when
   * the person is still there to answer it.
   */
  function notSent(e: unknown, gen: number, threadId: string, content: string, model: string, { out, messageId }: TurnOptions): void {
    const st = getState();
    const images = out?.images ?? [];
    const files = out?.files ?? [];
    const attached = files.length ? { files } : {};
    const code = codeOf(e);
    const turn = st.turns[threadId];
    const owner = turn?.gen === gen ? turn : null;
    const asked = stopAsked.delete(gen);
    // the person stopped it before it started: the server took the Stop, the Stop was still waiting for the turn's id, or a newer send in its chat took its place
    const halted = owner === null || owner.end?.kind === "stopped" || asked;
    const here = st.view === "thread" && st.threadId === threadId;
    const draft = getDraft(threadId);
    const where = out?.regenerate === true ? null : draft.text === "" && draft.images.length === 0 && !draft.files?.length ? "box" : "queue";
    const blocking = e instanceof WireError ? e.blocking : undefined;
    // halted: the person has already said no; a message that went to the queue instead of the box would warn about words not in view
    const ask = code === "would-stop" && blocking !== undefined && out !== undefined && here && !halted && where !== "queue" ? { ...out, threadId, blocking } : null;
    const draw = out?.draw;
    const typed: Queued = { id: queueId(), ...(messageId ? { messageId } : {}), threadId, text: content, images, ...attached, at: Date.now(), waitFor: "reply", model, held: true, ...(draw === undefined ? {} : { draw }) };
    const consented = ask !== null && stopOthersOk();
    if (where === "box") replaceDraft(threadId, { text: content, images, ...attached, sendId: messageId ?? null });
    const title = st.threads.find(t => t.id === threadId)?.title;
    const restoredElsewhere = where === "box" && !here ? `Your message didn't send. Your words are in the draft in ${title ? `“${title}”` : "another chat"}.` : undefined;
    const notice = restoredElsewhere ?? (code === "gpu-unreadable" && e instanceof Error ? `${e.message}${where === null ? "" : ` Your message is back in the ${where}.`}` : code === "image-input" && e instanceof Error ? e.message : where === "queue" && !here ? elsewhereNotice(st, threadId) : refusal(code, model, where));
    // A memory refusal in view says what runs instead; the note's buttons take it (WIN-MEM-02).
    const offer = code === "wont-fit" && here && e instanceof WireError ? e.offer : undefined;
    applyServerEvent({
      // one the server stopped stays as its record says; a Stop that never reached the server leaves nothing to show
      ...(owner === null ? {} : { turns: withTurn(st.turns, threadId, owner.end?.kind === "stopped" ? reduceTurn(owner, { type: "refused" }, Date.now()) : null) }),
      ...(where === "queue" ? { queued: [...st.queued, typed] } : {}),
      ...(ask === null || consented ? {} : { stopAsk: ask, notice: null }),
      ...(ask === null && !halted ? { notice, noticeOffer: offer === undefined ? null : { notice, model, numCtx: ctxFor(st.numCtx, st.models, model), offer } } : {}),
    });
    // on the server too, on hold
    if (where === "queue") enqueue({ ...typed, messageId: typed.messageId ?? queueId(), numCtx: st.numCtx, think: st.think });
    // The Stop was still waiting for a reply to name, and the send was refused before it had one:
    // the server has nothing to stop, so what waits behind it is asked to hold, row by row.
    if (asked) for (const q of st.queued) if (q.threadId === threadId && q.waitFor === "reply" && q.now !== true && q.held !== true) void askOne("reply.hold", { id: q.id });
    if (consented) void launch(ask, true);
  }

  /**
   * Stop the reply being written in the open chat. The press only asks: the reply is stopped here
   * when the server's record says it took the Stop, with its seconds, and what waited behind it is
   * on hold when the server's list says so. A press that never reaches the server changes nothing.
   */
  function stop(): void {
    const turn = runningTurn(getState(), getState().threadId);
    if (turn === undefined) return;
    if (turn.turnId !== null) void askOne("reply.stop", { id: turn.turnId });
    // without an id yet, startTurn asks once chat.send answers
    else stopAsked.add(turn.gen);
  }

  /** Retry or Regenerate: send the thread's last user message again. An unfinished reply is replaced; after a finished one the server keeps both copies (no regenerate method yet). */
  function retry(): void {
    const s = getState();
    if (s.threadId === null || !canRetry(s)) return;
    const last = (s.messages[s.threadId] ?? []).findLast((m) => m.role === "user");
    if (!last) return;
    // sent again the way Send would send it now: with Image on, to the image model
    const draw = drawChoice(s);
    void admit({ content: last.content, images: last.images, ...(last.files ? { files: last.files } : {}), model: s.model ?? last.model ?? "", threadId: s.threadId, keepDraft: true, regenerate: true, ...(draw === undefined ? {} : { draw }) });
  }

  /**
   * A dropped connection loses every stream. The open chat keeps its reply,
   * marked cut off; a reply behind another chat is let go, and the next visit
   * to its thread reloads what was saved. A send still waiting for its answer
   * stays: the dropped connection refuses it, and notSent takes it from there.
   * A send answered but not started is refused here the same way: its start or
   * its refusal may have been lost with the connection. Its words go back with
   * its message id, so sending them again cannot ask twice.
   */
  function lostTurn(): void {
    const open = getState().threadId;
    if (open !== null) flushWords(open);
    waiting.clear();
    // one still waiting for its answer is refused by its call
    const unstarted = [...admitting.entries()].filter(([, a]) => a.turnId !== undefined);
    for (const [key] of unstarted) admitting.delete(key);
    for (const [, own] of unstarted) own.refused(new WireError("closed", "The connection dropped before this message was sent."));
    applyServerEvent((s) => {
      let turns = s.turns;
      for (const turn of Object.values(s.turns)) {
        const behind = turn.threadId !== open && turn.turnId !== null && turn.end === undefined;
        turns = withTurn(turns, turn.threadId, behind || turn.listed === true ? null : reduceTurn(turn, { type: "lost" }, Date.now()));
      }
      return { turns };
    });
  }

  /**
   * turns.active at hydration: a reply the server is writing that this client
   * has no turn for gets a listed one, which only marks its chat running until
   * its first event; one this client marked cut off is running again. The
   * server lists a turn before saving its question and may drop it with no
   * event, so a listed turn ends here, at the next hydration that does not list
   * it (or when the connection drops).
   */
  function activeTurns(s: State, active: ResultOf<"turns.active">): Pick<State, "turns"> {
    const ids = new Set(active.map((a) => a.turnId));
    let turns = s.turns;
    const now = Date.now();
    for (const turn of Object.values(s.turns)) if (turn.listed === true && (turn.turnId === null || !ids.has(turn.turnId))) turns = withTurn(turns, turn.threadId, null);
    for (const { threadId, turnId, reply } of active) {
      const turn = turns[threadId];
      if (oldTurns.has(turnId)) continue;
      // running again, with the record as it is now
      if (turn?.turnId === turnId) {
        const running = reduceTurn(turn, { type: "running" }, now) ?? turn;
        turns = withTurn(turns, threadId, reduceTurn(running, { type: "reply", reply }, now));
      } else if (turn === undefined) turns = withTurn(turns, threadId, { gen: ++turnGen, threadId, turnId, model: "", startedAt: now, reply, replyAt: now, thinking: "", text: "", tools: [], pendingUser: null, listed: true });
      // any other turn there is this client's own: its send's answer, or the snapshot's start, settles it
    }
    return { turns };
  }

  // Words batch into one store update per animation frame, and only for the
  // open chat: a reply in another chat costs it nothing per word. Its words
  // land when its turn changes phase (first word, tool step, end) or when its
  // chat is opened.
  const waiting = new Map<string, Waiting>();
  let raf = 0;

  function flushWords(threadId: string): void {
    const w = waiting.get(threadId);
    if (w === undefined) return;
    waiting.delete(threadId);
    perf.flushes++;
    applyServerEvent((s) => {
      const turn = s.turns[threadId];
      if (turn === undefined || turn.gen !== w.gen) return;
      return { turns: withTurn(s.turns, threadId, withWaiting(turn, w, Date.now())) };
    });
  }

  function frame(): void {
    raf = 0;
    const open = getState().threadId;
    if (open !== null) flushWords(open);
  }

  function queueWords(turn: LiveTurn, kind: "text" | "thinking", t: string): void {
    perf.deltas++;
    // words after the server took a Stop are dropped (W-05): the record's seconds end there
    if (turn.end?.kind === "stopped") return;
    let w = waiting.get(turn.threadId);
    if (w === undefined || w.gen !== turn.gen) waiting.set(turn.threadId, (w = { gen: turn.gen, text: "", thinking: "" }));
    w[kind] += t;
    // oxlint-disable-next-line gates/timer-needs-reason -- the next frame: the stream's words since the last one go into the store in one write
    if (getState().threadId === turn.threadId && raf === 0) raf = requestAnimationFrame(frame);
  }

  /** Opening a chat shows every word its reply wrote meanwhile; a reply coming back to the screen moves ended ones on. */
  function catchUp(threadId: string): void {
    flushWords(threadId);
    if (turnOf(getState(), threadId) !== undefined) settleEnded(threadId);
  }

  function onChatEvent(p: Payload<"chat.event">): void {
    if (p.event.type === "start") confirmCopy(p.event.userMessage);
    turnEvent(p);
  }

  /** Every event of every turn, in an open chat or not, goes through here; all but the two that save a row (done, an error with a partial) then go through reduceTurn. */
  function turnEvent(p: Payload<"chat.event">): void {
    const { turnId, threadId, event } = p;
    // a send of this client's that has not started: its start brings the question, an error before it is its refusal
    const mine = event.type === "start" ? ownAdmission(turnId, threadId, event.userMessage.id) : event.type === "error" ? admittingTurn(turnId) : undefined;
    if (mine !== undefined) {
      const [key, own] = mine;
      admitting.delete(key);
      if (event.type === "error") {
        oldTurns.delete(turnId);
        return own.refused(new WireError(event.code, event.message, event.blocking, event.offer));
      }
      if (own.turnId === undefined) {
        own.turnId = turnId;
        update(threadId, own.gen, { type: "sent", turnId });
      }
      if (event.type === "start") own.started(event.userMessage);
    }
    if (event.type === "done" || event.type === "error") oldTurns.delete(turnId);
    const turn = getState().turns[threadId];
    if (queueTurns.has(turnId) && (event.type === "start" || event.type === "done" || event.type === "error")) {
      queueTurns.delete(turnId);
      // a queued message refused before its start: the server puts it back on hold and says why with the queue
      if (event.type === "error") {
        // one the person stopped stays stopped, its question back in the queue, as a stopped send's does
        if (turn?.turnId === turnId) applyServerEvent((s) => ({ turns: withTurn(s.turns, threadId, turn.end?.kind === "stopped" ? reduceTurn(turn, { type: "refused" }, Date.now()) : null) }));
        return;
      }
    }
    // a turn another window sent that never started here: refused there, so nothing of it shows here
    if (turn?.listed === true && turn.turnId === turnId && event.type === "error") {
      applyServerEvent((s) => ({ turns: withTurn(s.turns, threadId, null) }));
      keepStopped(threadId, event);
      return;
    }
    if (turn === undefined || turn.turnId !== turnId) return otherTurn(p);
    const open = getState().threadId === threadId;
    switch (event.type) {
      case "thinking":
        return queueWords(turn, "thinking", event.text);
      case "delta":
        return event.text === "" ? undefined : queueWords(turn, "text", event.text);
      case "tool":
        flushWords(threadId);
        return update(threadId, turn.gen, event);
      case "reply":
        // a second attempt starts over: the first one's waiting words are dropped (the server holds the queue behind it)
        if (turn.reply !== undefined && event.reply.attempt > turn.reply.attempt) waiting.delete(threadId);
        // the words that were waiting for a frame when the server took a Stop stay (W-05)
        else if (!open || event.reply.stoppedAt !== undefined) flushWords(threadId);
        // the open chat's words land in their own frame (one flush a frame); a chat off screen takes them at the phase change
        return update(threadId, turn.gen, event);
      case "start":
        noteMessage(threadId, event.userMessage);
        if (getState().messages[threadId] !== undefined) applyServerEvent((s) => ({ messages: withMessage(s, threadId, event.userMessage) }));
        // the snapshot that follows has every word: words still waiting would come twice
        if (turn.end === undefined || turn.end.kind === "error") waiting.delete(threadId);
        return update(threadId, turn.gen, event);
      case "done": {
        // the saved message has every word: drop the waiting ones instead of
        // publishing them a moment before the row that replaces them (W-09)
        if (open && window.glPerf?.terminalFlush === true) {
          perf.flushes++;
          applyServerEvent((s) => ({ turns: { ...s.turns, [threadId]: { ...turn } } }));
        }
        waiting.delete(threadId);
        // the row carries the server's times: its thought, first token and rounds draw from them
        const msg = event.message;
        if (open) noteMessage(threadId, msg);
        applyServerEvent((s) => ({
          ...(open ? { messages: withMessage(s, threadId, msg) } : {}),
          turns: withTurn(s.turns, threadId, null),
        }));
        // a chat not on screen reloads: its cached history may be behind
        if (!open) untrackedDone(threadId, msg);
        return;
      }
      case "error": {
        const said = { ...event, message: stopReason(event) ?? event.message };
        if (said.partial !== undefined) {
          // the saved partial has every word the turn showed, and how and when it ended: it takes the turn's place
          waiting.delete(threadId);
          const { partial } = said;
          noteMessage(threadId, partial);
          applyServerEvent((s) => ({
            turns: withTurn(s.turns, threadId, null),
            ...(open || s.messages[threadId] !== undefined ? { messages: withMessage(s, threadId, partial) } : {}),
          }));
        } else {
          flushWords(threadId);
          // the question, stamped with how its turn ended: its note shows once the ended turn leaves the screen
          keepQuestion(threadId, said);
          update(threadId, turn.gen, said);
          // on screen the ended turn stays with its Retry; elsewhere it settles into its chat now
          const ended = getState().turns[threadId];
          if (!open && ended !== undefined && ended.gen === turn.gen) settle(ended);
        }
        return;
      }
    }
  }

  /** A reply that ended without a saved row while its chat was not open: its words become a row; its question already says how it ended. */
  function settle(turn: LiveTurn): void {
    applyServerEvent((s) => ({ turns: withTurn(s.turns, turn.threadId, null) }));
    if (turn.text !== "" || turn.thinking !== "" || turn.tools.length > 0) keepStoppedWords(turn);
  }

  /**
   * The question of a turn that saved no reply, stamped by the server with how the turn ended, in
   * place of its copy here. Only in place: a Retry may have taken the row out on the server already.
   */
  function keepQuestion(threadId: string, event: Extract<ChatEvent, { type: "error" }>): void {
    const { question } = event;
    if (question === undefined) return;
    applyServerEvent((s) => s.messages[threadId]?.some((m) => m.id === question.id) === true ? { messages: withMessage(s, threadId, question) } : {});
  }

  /** A turn that ended without being on screen: what it saved goes into its thread, with how it ended on the row. */
  function keepStopped(threadId: string, event: Extract<ChatEvent, { type: "error" }>): void {
    const { partial } = event;
    if (partial === undefined) return keepQuestion(threadId, event);
    noteMessage(threadId, partial);
    applyServerEvent((s) => (s.messages[threadId] !== undefined ? { messages: withMessage(s, threadId, partial) } : {}));
  }

  /**
   * An event of a turn this client has no turn for. A turn begun by another
   * client (the same thread open on the phone and the desktop) becomes its
   * chat's turn here too and streams; a joining client gets the same
   * start with a snapshot of words already sent.
   */
  function otherTurn({ turnId, threadId, event }: Payload<"chat.event">): void {
    if (event.type === "done") return untrackedDone(threadId, event.message);
    // what a turn stopped elsewhere, or gone from the screen, saved: the row says how it ended
    if (event.type === "error") return keepStopped(threadId, event);
    if (event.type !== "start" || oldTurns.has(turnId)) return;
    noteMessage(threadId, event.userMessage);
    retire(getState().turns[threadId]);
    // what it is doing and its seconds come in the server's record that follows the start
    const turn: LiveTurn = { gen: ++turnGen, threadId, turnId, userMessageId: event.userMessage.id, model: event.model, startedAt: Date.now(), thinking: "", text: "", tools: [], pendingUser: null, ...(event.image === true ? { image: true as const } : {}) };
    applyServerEvent((st) => ({
      ...(st.messages[threadId] !== undefined ? { messages: withMessage(st, threadId, event.userMessage) } : {}),
      turns: withTurn(st.turns, threadId, turn),
    }));
  }

  /**
   * Send now, T3 Code's interrupt: one call, in which the server stops a reply running in this
   * message's chat and sends the message first once that has ended. With nothing running there it
   * goes at once; a load that would stop another chat's reply comes back as the warning, as any
   * other send's does.
   */
  function sendQueuedNow(id: string): void {
    const s = getState();
    const q = s.queued.find((x) => x.id === id);
    if (!q || q.waitFor !== "reply") return;
    if (unfinished(s.turns[q.threadId])) return queueNow(id, stopOthersOk());
    // nothing running in its chat: the same question first, and the same warning, as any other send
    void admit({ content: q.text, images: q.images, ...(q.files ? { files: q.files } : {}), messageId: q.messageId, model: q.model ?? s.model ?? "", threadId: q.threadId, keepDraft: true, queuedId: q.id, ...(q.draw === undefined ? {} : { draw: q.draw }) });
  }

  function cancelQueuedEdit(): void {
    const id = getState().editingQueued;
    cancelQueuedDraft(currentDraftKey());
    setState({ editingQueued: null });
    if (id !== null) editEnded(id);
  }

  return {
    send, confirmStopAsk, stop, retry, sendQueuedNow, cancelQueuedEdit,
    onChatEvent, lostTurn, catchUp, activeTurns, queueChanged, queueListed, editEnded,
  };
}
