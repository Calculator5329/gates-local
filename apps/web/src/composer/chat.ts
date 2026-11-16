// Chat admissions, concurrent replies, streaming buffers, and the server's record of every message as this window keeps it.
import { type AttachedFile, type BlockingTurn, type ImageChoice, type Message, type MethodName, type Params, type Payload, type QueuedMessage, type Reply, type ReplyCall, type ReplyChange, type ReplyListed, type ReplyOutcome, type ReplyRecord, type ReplyTimes, type ResultOf, type StopConsent, WireError } from "@gates-local/contracts";
import { ctxFor, describeModel, k } from "../lib/words/format.ts";
import { firstChatPull, sendableModel } from "../models/pick.ts";
import { type LiveTurn, NA, type Queued, type State, type StopAsk, type WaitingReply, behindSetup, chatReady, getState, isWaiting, runningTurn, setState, streamingHere, turnOf, waitingReplies } from "../lib/store/store.ts";
import { imageReason } from "./paste.ts";
import { drawChoice, imageMode } from "../image/image-choice.ts";
import { releaseFiles } from "./file-holds.ts";
import { type Draft, type DraftKey, beginQueuedDraft, cancelQueuedDraft, clearDraft, currentDraftKey, getDraft, moveDraft, renewDraft, replaceDraft } from "../lib/store/drafts.ts";
import type { ServerEvent } from "../lib/session/server-state.ts";
import { type ChatEvent, type TurnEvent, reduceTurn, stopping, unfinished, withTurn } from "../thread/turn.ts";
import { stopReason as stopWords } from "../thread/times.ts";
import { type WindowRules, createRecords } from "./records.ts";

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
 * Every message is the server's record (it keeps it, moves it and sends every change); a window
 * keeps each record as last sent (State.replies) and asks for changes, and a record changes here
 * only when the server sends it. `askServer` is the connection's calls on one message, once
 * createChat has them.
 */
let askServer: ChatEffects["reply"] | undefined;

/** The edit open in this window's composer: the words it started from, and a save whose answer never came. */
let edited: { readonly id: string; readonly base: string; readonly text: string; tried?: string } | null = null;

/**
 * Messages this window opened for editing. The record says who edits it only once the server has
 * answered, and still says so for a moment after the edit ended here: neither is an edit elsewhere.
 */
const editsHere = new Set<string>();

export const editedElsewhere = (q: WaitingReply): boolean => q.stage === "editing" && !editsHere.has(q.id);

const ALREADY_SENT = "That message was already sent.";
const ON_ITS_WAY = "This message is already on its way.";
const REMOVED = "That message was removed.";
const OPEN_ELSEWHERE = "That message is open in another window.";
const NOT_REACHED = "Gates Local stopped answering.";
const CLOSING = "Gates Local is closing. The reply written so far was saved.";
/** Where a message went, for a call that came too late for it. */
const tooLate = (a: Extract<ReplyOutcome, { answer: "gone" | "sending" }>): string => (a.answer === "sending" ? ON_ITS_WAY : a.why === "sent" ? ALREADY_SENT : REMOVED);

/** The words "restored on hold" a reload put up for this browser's own saved queue, which the server's now replaces. */
const RESTORED_NOTICE = "Your queued messages were restored on hold. Use Send now when you are ready.";
/** Set once this browser's saved queue (from before the server kept it) has gone to the server. */
const QUEUE_MOVED_KEY = "gates-local.queue-on-server";

/**
 * This browser's own saved queue, from before the server kept it, not yet handed over: null until
 * the reload has read it. A message leaves it when the server has answered for it.
 */
let oldQueue: readonly Queued[] | null = null;
let onOldQueue: (() => void) | undefined;
let oldQueueChanged: (() => void) | undefined;

/**
 * The reload read this browser's saved queue. It goes to the server once the server's records are
 * in too, whichever of the two comes first. A save from after the hand-over is the server's own
 * queue as it then was, and counts for nothing unless it says the server still owes it (`owed`).
 * Returns what is still to hand over.
 */
export function oldQueueRead(queued: readonly Queued[], owed: boolean): readonly Queued[] {
  let moved = false;
  try {
    moved = localStorage.getItem(QUEUE_MOVED_KEY) === "1";
  } catch {
    // unknown: a saved queue is handed over rather than lost, and the server takes each message once
  }
  oldQueue = moved && !owed ? [] : queued;
  onOldQueue?.();
  return oldQueue;
}

/** The old saved queue's messages the server has not answered for: a save keeps them until it has. `changed` runs when one leaves. */
export function oldQueueOwed(changed?: () => void): readonly Queued[] {
  if (changed !== undefined) oldQueueChanged = changed;
  return oldQueue ?? [];
}

function queueMoved(): void {
  try {
    localStorage.setItem(QUEUE_MOVED_KEY, "1");
  } catch {
    // private windows may refuse storage: what was handed over stays the server's all the same
  }
}

/**
 * A record's times as a turn draws them. A message taken and not yet saved has no clock: it
 * waits, or loads. A reply whose model has sent nothing yet waits too, with no work to time.
 */
function clockOf(r: Exclude<Reply, WaitingReply | { readonly stage: "done" | "stopped" | "failed" }>): ReplyRecord {
  const none = { workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {} };
  if (r.stage === "starting") return { ...none, stage: r.loading === true ? "loading" : "waiting", startedAt: r.startedAt };
  // a stopped picture's turn is over in the composer while its card says the engine is letting go
  if (r.stage === "drawing") return { ...none, startedAt: r.startedAt, ...(r.stoppedAt === undefined ? { stage: "waiting" } : { stage: "stopping", stoppedAt: r.stoppedAt }) };
  return {
    stage: r.stage === "thinking" && r.silent === true ? "waiting" : r.stage,
    startedAt: r.startedAt, workMs: r.workMs, toolMs: r.toolMs, attempt: r.try, spans: r.spans, callsAt: r.callsAt,
    ...(r.readyAt === undefined ? {} : { readyAt: r.readyAt }),
    ...(r.firstTokenAt === undefined ? {} : { firstTokenAt: r.firstTokenAt }),
    ...(r.stage === "stopping" ? { stoppedAt: r.stoppedAt } : {}),
  };
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
  return out.queuedId !== undefined && (s.editingQueued === out.queuedId || !waitingReplies(s).some((q) => q.id === out.queuedId));
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
        return setState({ notice: `${NOT_REACHED} The message was not removed.` });
    }
  });
}

function dropped(id: string, notice?: string): void {
  if (getState().editingQueued === id) cancelQueuedDraft(currentDraftKey());
  if (edited?.id === id) edited = null;
  setState((s) => ({
    ...(s.editingQueued === id ? { editingQueued: null } : {}),
    ...(s.stopAsk?.queuedId === id ? { stopAsk: null } : {}),
    ...(notice === undefined ? {} : { notice }),
  }));
}

/** Edit: the words go in the composer and the message keeps its place, unsent, until the next Send updates it. */
export function editQueued(id: string): void {
  const q = waitingReplies(getState()).find((x) => x.id === id);
  if (!q) return;
  beginQueuedDraft(q.threadId, q.text, q.images ?? [], q.messageId, q.files);
  edited = { id, base: q.messageId, text: q.text };
  editsHere.add(id);
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
  const q = waitingReplies(getState()).find((x) => x.id === id);
  if (q === undefined || askServer === undefined) return false;
  const base = q.messageId;
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
      setState({ notice: `${NOT_REACHED} Try again.` });
      return false;
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

/** Words the server was never heard to take go back in their chat's composer, above anything typed there since. */
function backInBox(entry: QueuedMessage): void {
  const draft = getDraft(entry.threadId);
  const empty = draft.text === "" && draft.images.length === 0 && !draft.files?.length;
  const files = [...(entry.files ?? []), ...(empty ? [] : draft.files ?? [])];
  replaceDraft(entry.threadId, {
    text: empty ? entry.text : `${entry.text}\n${draft.text}`,
    images: empty ? entry.images ?? [] : [...(entry.images ?? []), ...draft.images],
    ...(files.length ? { files } : {}),
    sendId: empty ? entry.messageId : null,
  });
  setState({ notice: refusal("closed", entry.model ?? "", "box") });
}

const kept = (s: State, r: Reply): State["replies"] => new Map(s.replies).set(r.id, r);
function without(s: State, id: string): State["replies"] {
  if (!s.replies.has(id)) return s.replies;
  const replies = new Map(s.replies);
  replies.delete(id);
  return replies;
}

function endOf(r: Extract<Reply, { readonly stage: "stopped" | "failed" }>, at: number): Extract<ChatEvent, { type: "error" }> {
  if (r.stage === "failed") return { type: "error", code: r.code, message: r.message, ended: { reason: "failed", at } };
  switch (r.by.who) {
    case "person": return { type: "error", code: "cancelled", message: "", ended: { reason: "stopped", at } };
    case "preempted": return { type: "error", code: "preempted", message: "", ...(r.by.neededBy === undefined ? {} : { neededBy: r.by.neededBy }), ended: { reason: "preempted", at } };
    case "runtime": return { type: "error", code: "runtime-changed", message: "", ended: { reason: "preempted", at } };
    case "closing": return { type: "error", code: "cancelled", message: CLOSING, ended: { reason: "preempted", at } };
  }
}

/** The server answered for an old saved message: it is the server's (`restored`), or was already, or was refused, which said so. */
function handedOver(id: string, restored: boolean): void {
  oldQueue = (oldQueue ?? []).filter((q) => q.id !== id);
  queueMoved();
  if (restored) setState({ notice: RESTORED_NOTICE });
  oldQueueChanged?.();
}

/** History, navigation, fit and RPC operations are wired by session.ts. `rules` is given only by the test that turns one off (records.test.ts). */
export function createChat({ applyServerEvent, call, reply: askOne, codeOf, createThread, creatingDraft, loadThread, loading, noteMessage, withMessage, untrackedDone, openThread, blockingFor }: ChatEffects, rules?: WindowRules) {
  askServer = askOne;
  /** Queued messages this window pressed Send now on: a would-stop answer shows the warning here. */
  const nowAsked = new Set<string>();
  /** Queued here to wait for setup or the first download: its chat opens when it goes. */
  const waitedHere = new Set<string>();
  /** Each queued message's refusal as last said, so it is said once. */
  const refusalSaid = new Map<string, string>();
  const records = createRecords(rules);

  /**
   * Hand a message to the server's queue. Its row shows when the server's record of it arrives.
   * An add the server never answered puts the words back in the composer under the same name, so
   * sending them again asks once; if the server has them after all, its record takes them out.
   */
  function enqueue(entry: QueuedMessage): Promise<"ok" | "not-reached" | "refused"> {
    return call("queue.add", entry).then(() => "ok" as const, (e: unknown) => {
      const code = codeOf(e);
      if (code === "closed" || code === "timeout") return "not-reached" as const;
      // removed in another window while this one could not hear it: the removal stands, said nowhere twice
      if (code !== "queue-removed") setState({ notice: "The chat this message was waiting in is gone, so it was not sent." });
      return "refused" as const;
    });
  }

  /**
   * One record changed, or left: the only way a message changes in this window. A change older
   * than the one held is dropped. A new refusal is said once, here as a warning when this window
   * pressed Send now and the yes is the person's to give. `listed`: the list at connect, whose
   * refusals were said before.
   */
  function recordChanged(change: ReplyChange, listed = false): void {
    const id = change.kind === "is" ? change.reply.id : change.id;
    if (!records.takes(getState().replies.get(id), change)) return;
    // an old saved message the server says anything of is the server's: its add is not asked again
    if (oldQueue?.some((q) => q.id === id) === true) handedOver(id, false);
    if (change.kind === "left") return recordLeft(change.id, change.why);
    const r = change.reply;
    const saved = change.saved ?? [];
    // an edit open here (also one a reload brought back) is this window's, whatever the record says yet
    if (getState().editingQueued === r.id) editsHere.add(r.id);
    else if (r.stage !== "editing") editsHere.delete(r.id);
    if (isWaiting(r)) return waits(r, listed);
    refusalSaid.delete(r.id);
    if (r.stage === "starting") return starts(r);
    if (r.stage === "done") return done(r, saved);
    if (r.stage === "stopped" || r.stage === "failed") return over(r, saved);
    answers(r, saved);
  }

  /** A turn of this record that never started here shows nothing more: its question was not saved. One the server stopped stays as stopped. */
  const unstarted = (turn: LiveTurn | undefined, id: string): turn is LiveTurn => turn !== undefined && turn.turnId === id && turn.userMessageId === undefined && turn.end?.kind !== "stopped" && admittingTurn(id) === undefined;

  /** It waits: a row of its chat's tray. One that was on its way is back (refused, or a Stop pulled it back), and nothing of a turn shows. */
  function waits(r: WaitingReply, listed: boolean): void {
    const s = getState();
    // words an unanswered add put back in the composer: the server has them after all, and they are the row
    const draft = getDraft(r.threadId);
    const putBack = draft.sendId === r.messageId && draft.beforeEdit === undefined && s.editingQueued !== r.id;
    if (putBack) clearDraft(r.threadId);
    let said: Partial<State> = putBack && s.notice === refusal("closed", "", "box") ? { notice: null } : {};
    const why = r.stage === "held" && r.held.why === "refused" ? r.held : undefined;
    // an edit of a refused message returns it as it was: its refusal has been said
    if (why === undefined && r.stage !== "editing") refusalSaid.delete(r.id);
    const key = JSON.stringify(why);
    if (why !== undefined && refusalSaid.get(r.id) !== key) {
      refusalSaid.set(r.id, key);
      if (!listed) {
        const asked = nowAsked.delete(r.id);
        const here = s.view === "thread" && s.threadId === r.threadId;
        const { code, message, blocking } = why;
        const model = r.model ?? s.model ?? "";
        if (code === "would-stop" && blocking !== undefined && asked && here) {
          said = { notice: null, stopAsk: { content: r.text, images: r.images ?? [], ...(r.files ? { files: r.files } : {}), messageId: r.messageId, model, threadId: r.threadId, keepDraft: true, queuedId: r.id, ...(r.draw === undefined ? {} : { draw: r.draw }), blocking } };
        } else {
          const notice = !here ? elsewhereNotice(s, r.threadId) : code === "gpu-unreadable" ? `${message} Your message is back in the queue.` : code === "image-input" ? message : refusal(code, model, "queue");
          // a memory refusal in view says what runs instead, as a send from the box does
          const offer = here && code === "wont-fit" ? why.offer : undefined;
          said = { notice, noticeOffer: offer === undefined ? null : { notice, model, numCtx: r.numCtx ?? ctxFor(s.numCtx, s.models, model), offer } };
        }
      }
    }
    if (unstarted(s.turns[r.threadId], r.id)) waiting.delete(r.threadId);
    applyServerEvent((st) => ({
      replies: kept(st, r),
      ...(unstarted(st.turns[r.threadId], r.id) ? { turns: withTurn(st.turns, r.threadId, null) } : {}),
      ...said,
    }));
    // an edit open here that the server no longer keeps for this window (it started again): asked again
    if (listed && s.editingQueued === r.id && r.stage !== "editing") openEdit(r.id, r.threadId, edited?.id === r.id ? edited.text : r.text);
  }

  /** It is on its way: its chat's turn, with its words as the question until the saved one takes their place. */
  function starts(r: Extract<Reply, { readonly stage: "starting" }>): void {
    const now = Date.now();
    const { threadId } = r;
    const own = admitting.get(r.messageId);
    if (own !== undefined && own.threadId === threadId && (own.turnId ?? r.id) === r.id) {
      // this window's own send: the turn that shows it has its name now
      own.turnId = r.id;
      applyServerEvent((s) => {
        const turn = s.turns[threadId];
        return { replies: kept(s, r), ...(turn?.gen === own.gen ? { turns: withTurn(s.turns, threadId, reduceTurn({ ...turn, turnId: r.id }, { type: "reply", reply: clockOf(r) }, now)) } : {}) };
      });
      return;
    }
    const s = getState();
    const turn = s.turns[threadId];
    const mine = turn?.turnId === r.id;
    // the server lets one reply run in a chat, and this is the one: a turn shown in its place gives way
    // (a send of this window's still waiting for its answer there will be refused)
    const fresh = !mine;
    if (fresh) retire(turn);
    const made: LiveTurn = {
      gen: ++turnGen, threadId, turnId: r.id, model: r.draw?.preset ?? r.model ?? "", startedAt: now, thinking: "", text: "", tools: [],
      // a Retry's question is in the chat already
      pendingUser: r.retryOf === undefined ? r.text : null, pendingImages: r.images ?? [], ...(r.files?.length ? { pendingFiles: r.files } : {}),
      ...(r.draw === undefined ? {} : { image: true as const }),
    };
    applyServerEvent((st) => {
      const at = st.turns[threadId];
      const base = at?.turnId === r.id ? reduceTurn(at, { type: "running" }, now) ?? at : fresh ? made : undefined;
      return { replies: kept(st, r), ...(base === undefined ? {} : { turns: withTurn(st.turns, threadId, reduceTurn(base, { type: "reply", reply: clockOf(r) }, now)) }) };
    });
    // setup and the first download are the whole app waiting; a queue behind a reply stays out of the way
    if (waitedHere.delete(r.id) && s.threadId !== threadId) openThread(threadId);
    nowAsked.delete(r.id);
  }

  /** This window's own send, if this record is its: named now, and started once its question is saved. */
  function ownStart(id: string, threadId: string, question: Message | undefined): boolean {
    const mine = question === undefined ? admittingTurn(id) : ownAdmission(id, threadId, question.id);
    if (mine === undefined) return false;
    const [key, own] = mine;
    if (own.turnId === undefined) own.turnId = id;
    update(threadId, own.gen, { type: "sent", turnId: id });
    if (question === undefined) return false;
    admitting.delete(key);
    own.started(question);
    return true;
  }

  /** A saved question confirms its exact copy in the composer; edited words already have a new identity. */
  function questionSaved(id: string, threadId: string, questionId: string): void {
    const draft = getDraft(threadId);
    if (draft.sendId === questionId) {
      if (draft.beforeEdit) cancelQueuedDraft(threadId);
      else clearDraft(threadId);
      // reworded while it sent: the new words stay, and a paste or dictation meant for the edit is dropped
    } else if (getState().editingQueued === id) renewDraft(threadId);
    if (edited?.id === id) edited = null;
    applyServerEvent((s) => {
      const editing = s.editingQueued === id;
      const ask = s.stopAsk?.messageId === questionId;
      if (!editing && !ask) return;
      return { ...(editing ? { editingQueued: null } : {}), ...(ask ? { stopAsk: null } : {}) };
    });
  }

  /** Its question is saved and its reply is being written (or drawn, or stopped and not yet ended): the chat's turn, with the record's clock. */
  function answers(r: Exclude<Reply, WaitingReply | { readonly stage: "starting" | "done" | "stopped" | "failed" }>, saved: readonly Message[]): void {
    const now = Date.now();
    const { threadId } = r;
    const question = saved.find((m) => m.id === r.questionId);
    const own = ownStart(r.id, threadId, question);
    const s = getState();
    const turn = s.turns[threadId];
    const mine = turn?.turnId === r.id;
    if (!mine || turn.userMessageId !== r.questionId) questionSaved(r.id, threadId, r.questionId);
    const fresh = !mine;
    if (fresh) retire(turn);
    const clock = clockOf(r);
    if (mine) {
      // a second attempt starts over: the first one's waiting words are dropped (the server holds the queue behind it)
      if (turn.reply !== undefined && clock.attempt > turn.reply.attempt) waiting.delete(threadId);
      // the words that were waiting for a frame when the server took a Stop stay (W-05);
      // the open chat's words land in their own frame, a chat off screen takes them at the phase change
      else if (s.threadId !== threadId || clock.stoppedAt !== undefined) flushWords(threadId);
    }
    if (question !== undefined && !own) noteMessage(threadId, question);
    const made: LiveTurn = { gen: ++turnGen, threadId, turnId: r.id, model: "", startedAt: now, thinking: "", text: "", tools: [], pendingUser: null };
    applyServerEvent((st) => {
      const at = st.turns[threadId];
      const base = at?.turnId === r.id ? at : fresh ? made : undefined;
      const messages = question !== undefined && !own && st.messages[threadId] !== undefined ? { messages: withMessage(st, threadId, question) } : {};
      if (base === undefined) return { replies: kept(st, r), ...messages };
      // the saved question takes the place of the words shown while it waited
      const started: LiveTurn = { ...base, pendingUser: null, userMessageId: base.userMessageId ?? r.questionId, ...(r.stage === "drawing" ? { image: true as const, model: r.preset } : { model: r.model }) };
      // cut off here by a dropped connection, and still being written
      const running = reduceTurn(started, { type: "running" }, now) ?? started;
      return { replies: kept(st, r), ...messages, turns: withTurn(st.turns, threadId, reduceTurn(running, { type: "reply", reply: clock }, now)) };
    });
  }

  /** Its reply is saved: the row takes the turn's place, and the record is kept no longer. */
  function done(r: Extract<Reply, { readonly stage: "done" }>, saved: readonly Message[]): void {
    const { threadId } = r;
    ownStart(r.id, threadId, saved.find((m) => m.id === r.questionId));
    const msg = saved.find((m) => m.id === r.replyId);
    const s = getState();
    const turn = s.turns[threadId];
    const open = s.threadId === threadId;
    if (turn?.turnId !== r.id || msg === undefined) {
      applyServerEvent((st) => ({ replies: without(st, r.id), ...(st.turns[threadId]?.turnId === r.id ? { turns: withTurn(st.turns, threadId, null) } : {}) }));
      if (msg !== undefined) untrackedDone(threadId, msg);
      return;
    }
    // the saved message has every word: drop the waiting ones instead of
    // publishing them a moment before the row that replaces them (W-09)
    if (open && window.glPerf?.terminalFlush === true) {
      perf.flushes++;
      applyServerEvent((st) => ({ turns: { ...st.turns, [threadId]: { ...turn } } }));
    }
    waiting.delete(threadId);
    // the row carries the server's times: its thought, first token and rounds draw from them
    if (open) noteMessage(threadId, msg);
    applyServerEvent((st) => ({
      replies: without(st, r.id),
      ...(open ? { messages: withMessage(st, threadId, msg) } : {}),
      turns: withTurn(st.turns, threadId, null),
    }));
    // a chat not on screen reloads: its cached history may be behind
    if (!open) untrackedDone(threadId, msg);
  }

  /** It ended with no finished reply: what it saved is in its chat, with how it ended, and the record is kept no longer. */
  function over(r: Extract<Reply, { readonly stage: "stopped" | "failed" }>, saved: readonly Message[]): void {
    const { threadId } = r;
    const question = r.questionId === undefined ? undefined : saved.find((m) => m.id === r.questionId);
    ownStart(r.id, threadId, question);
    const partial = saved.find((m) => m.role === "assistant");
    // a failure that landed after a Stop: the record ends as stopped, the rows it saved are stamped with the failure, and the failure is what is said
    const stamp = r.stage === "stopped" && r.by.who === "person" ? (partial ?? question)?.times : undefined;
    const event: Extract<ChatEvent, { type: "error" }> = stamp?.ended.reason === "failed" && stamp.why !== undefined
      ? { type: "error", code: stamp.why.code, message: stamp.why.message, ended: stamp.ended }
      : endOf(r, r.at);
    const said = { ...event, message: stopReason(event) ?? event.message, ...(partial === undefined ? {} : { partial }), ...(question === undefined ? {} : { question }) };
    const s = getState();
    const turn = s.turns[threadId];
    const open = s.threadId === threadId;
    if (r.questionId === undefined) {
      // a Retry refused before it started saved nothing: where another window sent it, nothing of it shows here
      applyServerEvent((st) => ({ replies: without(st, r.id), ...(unstarted(st.turns[threadId], r.id) ? { turns: withTurn(st.turns, threadId, null) } : {}) }));
      return;
    }
    if (turn === undefined || turn.turnId !== r.id) {
      applyServerEvent((st) => ({ replies: without(st, r.id) }));
      return keepStopped(threadId, said);
    }
    if (partial !== undefined) {
      // the saved partial has every word the turn showed, and how and when it ended: it takes the turn's place
      waiting.delete(threadId);
      noteMessage(threadId, partial);
      applyServerEvent((st) => ({
        replies: without(st, r.id),
        turns: withTurn(st.turns, threadId, null),
        ...(open || st.messages[threadId] !== undefined ? { messages: withMessage(st, threadId, partial) } : {}),
      }));
      return;
    }
    flushWords(threadId);
    // the question, stamped with how its turn ended: its note shows once the ended turn leaves the screen
    keepQuestion(threadId, said);
    applyServerEvent((st) => {
      const at = st.turns[threadId];
      return { replies: without(st, r.id), ...(at?.gen === turn.gen ? { turns: withTurn(st.turns, threadId, reduceTurn(at, said, Date.now())) } : {}) };
    });
    // on screen the ended turn stays with its Retry; elsewhere it settles into its chat now
    const ended = getState().turns[threadId];
    if (!open && ended !== undefined && ended.gen === turn.gen) settle(ended);
  }

  /** It is on no list any more: removed, its chat deleted, or settled with nothing more to show. */
  function recordLeft(id: string, why: Extract<ReplyChange, { kind: "left" }>["why"]): void {
    refusalSaid.delete(id);
    nowAsked.delete(id);
    waitedHere.delete(id);
    editsHere.delete(id);
    const was = getState().replies.get(id);
    // settled while open here: the edit has nothing left to change (a removal is said by the edit's own next answer)
    if (why === "settled" && was !== undefined && getState().editingQueued === id) {
      renewDraft(was.threadId);
      if (edited?.id === id) edited = null;
    }
    applyServerEvent((s) => {
      const turn = was === undefined ? undefined : s.turns[was.threadId];
      return {
        replies: without(s, id),
        ...(why === "settled" && s.editingQueued === id ? { editingQueued: null } : {}),
        ...(was !== undefined && unstarted(turn, id) ? { turns: withTurn(s.turns, was.threadId, null) } : {}),
      };
    });
  }

  // why: an old saved queue is handed over only once this connection has read the records
  let listedHere = false;
  const handing = new Set<string>();

  /**
   * This browser's queue from before the server kept one goes to the server once, on hold, when
   * both are known: what was saved, and the server's records. Each message stays saved here until
   * the server answers for it; one it never answered goes at the next connection.
   */
  function moveOldQueue(): void {
    if (oldQueue === null || !listedHere) return;
    const s = getState();
    for (const q of oldQueue) {
      if (handing.has(q.id)) continue;
      if (s.replies.has(q.id)) {
        handedOver(q.id, false);
        continue;
      }
      handing.add(q.id);
      void enqueue({ ...q, messageId: q.messageId ?? queueId(), waitFor: "reply", held: true, numCtx: s.numCtx, think: s.think }).then((a) => {
        handing.delete(q.id);
        if (a !== "not-reached") handedOver(q.id, a === "ok");
      });
    }
  }
  onOldQueue = moveOldQueue;

  function connected(): void {
    listedHere = false;
    records.connected(getState().replies.keys());
  }

  /**
   * The server's records at connect: every message waiting or on its way. One held from before
   * that the list does not name is gone, with a turn of it that never started here. An edit open
   * here keeps its message from going.
   */
  function replyListed(list: readonly ReplyListed[]): void {
    for (const { reply } of list) recordChanged({ kind: "is", reply }, true);
    const unlisted = new Set(records.unlisted());
    for (const id of unlisted) {
      refusalSaid.delete(id);
      editsHere.delete(id);
    }
    if (unlisted.size > 0) {
      applyServerEvent((s) => {
        const replies = new Map(s.replies);
        for (const id of unlisted) replies.delete(id);
        let turns = s.turns;
        for (const t of Object.values(s.turns)) if (t.turnId !== null && unlisted.has(t.turnId) && t.userMessageId === undefined && admittingTurn(t.turnId) === undefined) turns = withTurn(turns, t.threadId, null);
        return { replies, turns };
      });
    }
    listedHere = true;
    moveOldQueue();
  }

  /** An edit ended without a Send (Cancel, or leaving the chat): the message goes on as it was. */
  function editEnded(id: string): void {
    if (edited?.id === id) edited = null;
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
    const row = getState().replies.get(id);
    const has = row !== undefined && isWaiting(row) ? row.messageId : undefined;
    // the words this edit started from, unless the record shows an earlier save of this edit landed after all
    const base = has !== undefined && has === started?.tried ? has : started?.base ?? has ?? words.messageId;
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
  const perf: NonNullable<Window["glPerf"]> = { deltas: 0, flushes: 0 };
  window.glPerf = perf;

  /** Turns started this session; each turn carries its number (LiveTurn.gen). */
  let turnGen = 0;
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
   * A turn leaving the map: words it showed that no saved row will bring stay in its chat. Its
   * late words reach no turn that replaces it: words go to the turn of the record they name (WF-01).
   */
  function retire(turn: LiveTurn | undefined, keepWords = true): void {
    // a Retry replaces what it stopped: nothing is said under its question
    if (turn !== undefined && keepWords) keepStoppedWords(turn);
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
    // the server sends it as this window would have: the context and thinking set now, a picture at its chat's count
    const drawCount = draw === undefined ? undefined : threadId === null ? s.imageCountNew : s.threads.find((t) => t.id === queueIn)?.imageCount ?? 1;
    const q: QueuedMessage = { id: queueId(), messageId, threadId: queueIn, text: content, images, ...attached, at: Date.now(), waitFor: wait, ...(model === undefined ? {} : { model }), ...drawing, numCtx: s.numCtx, think: s.think, ...(drawCount === undefined ? {} : { drawCount }) };
    // Unchanged since Send, by its words: New thread during the creation gives the same draft a new identity.
    const now = getDraft(key);
    if (!apart && now.text === draft.text && now.images === draft.images && now.files === draft.files && now.sendId === draft.sendId) clearDraft(key);
    if (key === null && !apart) moveDraft(null, queueIn);
    settleEnded();
    setState({ notice: null, stopAsk: null });
    if (wait !== "reply") waitedHere.add(q.id);
    void enqueue(q).then((a) => {
      if (a !== "ok") waitedHere.delete(q.id);
      if (a === "not-reached") backInBox(q);
    });
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
    if (!waitingReplies(getState()).some((x) => x.id === id)) return;
    nowAsked.add(id);
    setState({ stopAsk: null, notice: null });
    const consent: StopConsent | undefined = !stopOthers ? undefined : stopTurns === undefined ? { kind: "standing" } : { kind: "named", replies: [...stopTurns] };
    void askOne("reply.now", { id, ...(consent === undefined ? {} : { consent }) }).then((a) => {
      switch (a.answer) {
        case "done":
          // the server's record already shows it first
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
        questionSaved(r.turnId, threadId, saved.id);
        noteMessage(threadId, saved);
        // the first send's turn may still be writing, and its start already made this the turn that shows it
        const running = own.turnId !== undefined;
        applyServerEvent(st => ({ messages: withMessage(st, threadId, saved), notice: "Your message was already sent. It was not sent again.", ...(!running && st.turns[threadId]?.gen === gen ? { turns: withTurn(st.turns, threadId, null) } : {}) }));
        await loadThread(threadId, true);
        return;
      }
      // its record may have come already, and named the turn (recordChanged)
      own.turnId ??= r.turnId;
      update(threadId, gen, { type: "sent", turnId: r.turnId });
      const now = getState().turns[threadId];
      // the turn that shows is this send's, or one its record made here before the answer came
      const mine = now !== undefined && (now.gen === gen || now.turnId === r.turnId);
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
    // the person stopped it before it started: the server took the Stop (and says so), the Stop was still waiting for the turn's id, or a newer send in its chat took its place
    const halted = owner === null || owner.end?.kind === "stopped" || asked || code === "cancelled";
    const here = st.view === "thread" && st.threadId === threadId;
    const draft = getDraft(threadId);
    const where = out?.regenerate === true ? null : draft.text === "" && draft.images.length === 0 && !draft.files?.length ? "box" : "queue";
    const blocking = e instanceof WireError ? e.blocking : undefined;
    // halted: the person has already said no; a message that went to the queue instead of the box would warn about words not in view
    const ask = code === "would-stop" && blocking !== undefined && out !== undefined && here && !halted && where !== "queue" ? { ...out, threadId, blocking } : null;
    const draw = out?.draw;
    const typed: QueuedMessage = { id: queueId(), messageId: messageId ?? queueId(), threadId, text: content, images, ...attached, at: Date.now(), waitFor: "reply", model, held: true, ...(draw === undefined ? {} : { draw }), numCtx: st.numCtx, think: st.think };
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
      ...(ask === null || consented ? {} : { stopAsk: ask, notice: null }),
      ...(ask === null && !halted ? { notice, noticeOffer: offer === undefined ? null : { notice, model, numCtx: ctxFor(st.numCtx, st.models, model), offer } } : {}),
    });
    // on hold, on the server: its row shows when the server's record of it arrives
    if (where === "queue") void enqueue(typed).then((a) => { if (a === "not-reached") backInBox(typed); });
    // The Stop was still waiting for a reply to name, and the send was refused before it had one:
    // the server has nothing to stop, so what waits behind it is asked to hold, row by row.
    if (asked) for (const q of waitingReplies(st)) if (q.threadId === threadId && q.stage === "queued" && !behindSetup(q)) void askOne("reply.hold", { id: q.id });
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
    const taken = [...admitting.entries()].filter(([, a]) => a.turnId !== undefined);
    for (const [key] of taken) admitting.delete(key);
    for (const [, own] of taken) own.refused(new WireError("closed", "The connection dropped before this message was sent."));
    applyServerEvent((s) => {
      let turns = s.turns;
      for (const turn of Object.values(s.turns)) {
        const behind = turn.threadId !== open && turn.turnId !== null && turn.end === undefined;
        turns = withTurn(turns, turn.threadId, behind ? null : reduceTurn(turn, { type: "lost" }, Date.now()));
      }
      return { turns };
    });
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

  /**
   * The words of every reply, for the turn of the record they name. Where a reply stands is its
   * record's to say (recordChanged), with two things left to these events: the refusal of a send
   * of this window's that has not started, which the send's call does not carry, and the mark
   * that the words so far follow again after a reconnect.
   */
  function onChatEvent(p: Payload<"chat.event">): void {
    const { threadId, event } = p;
    if (event.type === "error") {
      // nothing was saved: its words go back where the person will find them
      const mine = admittingTurn(p.turnId);
      if (mine === undefined) return;
      admitting.delete(mine[0]);
      return mine[1].refused(new WireError(event.code, event.message, event.blocking, event.offer));
    }
    if (event.type === "done" || event.type === "reply") return;
    const turn = getState().turns[threadId];
    if (turn === undefined || turn.turnId !== (p.replyId ?? p.turnId)) return;
    switch (event.type) {
      case "thinking":
        return queueWords(turn, "thinking", event.text);
      case "delta":
        return event.text === "" ? undefined : queueWords(turn, "text", event.text);
      case "tool":
        flushWords(threadId);
        return update(threadId, turn.gen, event);
      case "start":
        // the snapshot that follows has every word: words still waiting would come twice
        if (turn.end === undefined || turn.end.kind === "error") waiting.delete(threadId);
        return update(threadId, turn.gen, event);
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
   * Send now, T3 Code's interrupt: one call, in which the server stops a reply running in this
   * message's chat and sends the message first once that has ended. With nothing running there it
   * goes at once; a load that would stop another chat's reply comes back as the warning, as any
   * other send's does.
   */
  function sendQueuedNow(id: string): void {
    const s = getState();
    const q = waitingReplies(s).find((x) => x.id === id);
    if (!q || behindSetup(q)) return;
    if (unfinished(s.turns[q.threadId])) return queueNow(id, stopOthersOk());
    // nothing running in its chat: the same question first, and the same warning, as any other send
    void admit({ content: q.text, images: q.images ?? [], ...(q.files ? { files: q.files } : {}), messageId: q.messageId, model: q.model ?? s.model ?? "", threadId: q.threadId, keepDraft: true, queuedId: q.id, ...(q.draw === undefined ? {} : { draw: q.draw }) });
  }

  function cancelQueuedEdit(): void {
    const id = getState().editingQueued;
    cancelQueuedDraft(currentDraftKey());
    setState({ editingQueued: null });
    if (id !== null) editEnded(id);
  }

  return {
    send, confirmStopAsk, stop, retry, sendQueuedNow, cancelQueuedEdit,
    onChatEvent, lostTurn, catchUp, connected, recordChanged, replyListed, editEnded,
  };
}
