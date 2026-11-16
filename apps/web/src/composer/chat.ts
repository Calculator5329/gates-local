// Chat admissions, concurrent replies, streaming buffers, and the server's record of every message as this window keeps it.
import { type AttachedFile, type BlockingTurn, type ImageChoice, type Message, type MethodName, type Params, type Payload, type Reply, type ReplyCall, type ReplyChange, type ReplyListed, type ReplyOutcome, type ReplyTimes, type ResultOf, type SoFar, type StopConsent, WireError } from "@gates-local/contracts";
import { ctxFor, describeModel, k } from "../lib/words/format.ts";
import { firstChatPull, sendableModel } from "../models/pick.ts";
import { type LiveTurn, NA, type State, type StopAsk, type TurnClock, type WaitingReply, behindSetup, chatReady, getState, isWaiting, runningTurn, setState, streamingHere, turnOf, waitingReplies } from "../lib/store/store.ts";
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

/** A message of this browser's own saved queue, from before the server kept it: it goes to the server once, on hold. */
export interface SavedQueued {
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
  readonly at: number;
  readonly messageId?: string;
  readonly images?: readonly string[];
  readonly files?: readonly AttachedFile[];
  /** The model it was typed for; a queue from before any model was installed has none. */
  readonly model?: string;
}

/**
 * This browser's own saved queue, from before the server kept it, not yet handed over: null until
 * the reload has read it. A message leaves it when the server has answered for it.
 */
let oldQueue: readonly SavedQueued[] | null = null;
let onOldQueue: (() => void) | undefined;
let oldQueueChanged: (() => void) | undefined;

/**
 * The reload read this browser's saved queue. It goes to the server once the server's records are
 * in too, whichever of the two comes first. A save from after the hand-over is the server's own
 * queue as it then was, and counts for nothing unless it says the server still owes it (`owed`).
 * Returns what is still to hand over.
 */
export function oldQueueRead(queued: readonly SavedQueued[], owed: boolean): readonly SavedQueued[] {
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
export function oldQueueOwed(changed?: () => void): readonly SavedQueued[] {
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
function clockOf(r: Exclude<Reply, WaitingReply | { readonly stage: "done" | "stopped" | "failed" }>): TurnClock {
  const none = { workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {} };
  if (r.stage === "starting") return { ...none, stage: r.draw !== undefined ? "drawing" : r.loading === true ? "loading" : "waiting", startedAt: r.startedAt };
  // a stopped picture's turn is over in the composer while its card says the engine is letting go
  if (r.stage === "drawing") return { ...none, stage: "drawing", startedAt: r.startedAt, ...(r.stoppedAt === undefined ? {} : { stoppedAt: r.stoppedAt }) };
  return {
    stage: r.stage === "thinking" && r.silent === true ? "waiting" : r.stage,
    startedAt: r.startedAt, workMs: r.workMs, toolMs: r.toolMs, attempt: r.try, spans: r.spans, callsAt: r.callsAt,
    ...(r.readyAt === undefined ? {} : { readyAt: r.readyAt }),
    ...(r.firstTokenAt === undefined ? {} : { firstTokenAt: r.firstTokenAt }),
    ...(r.stage === "stopping" ? { stoppedAt: r.stoppedAt } : {}),
  };
}

type Outgoing = Omit<StopAsk, "blocking">;

/** Send is on before any model can answer, while setup or the first download runs: the server keeps the message until it can go. */
export function sendsBeforeReady(s: State): boolean {
  if (s.conn.kind !== "open") return false;
  return s.runtime?.state === "installing" || (s.runtime?.state === "ready" && firstPull(s) !== undefined);
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

const unstarted = (turn: LiveTurn | undefined, id: string): turn is LiveTurn => turn !== undefined && turn.turnId === id && turn.userMessageId === undefined;

const inView = (threadId: string) => getState().view === "thread" && getState().threadId === threadId;

function draftElsewhere(threadId: string): string {
  const title = getState().threads.find((t) => t.id === threadId)?.title;
  return `Your message didn't send. Your words are in the draft in ${title ? `“${title}”` : "another chat"}.`;
}

/** Plain words for a send that did not go; `where`: its words are back in the box (null: they were already in the chat). */
function refusal(code: string, model: string, where: "box" | null, numCtx?: number): string {
  const name = describeModel(model, catalogOf(getState())).name;
  const back = where === null ? "" : " Your message is back in the box.";
  switch (code) {
    case "wont-fit":
      return `${name} doesn't fit in memory at ${k(numCtx ?? ctxFor(getState().numCtx, getState().models, model))}. Pick a smaller model or context.`;
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

/** A held message's refusal in a whole sentence, for its row's tip: the row itself says it in a few words. */
export function heldSentence(q: WaitingReply): string | undefined {
  const at = q.stage === "editing" ? q.back : q;
  if (at.stage !== "held" || at.held.why !== "refused") return undefined;
  const { code, message } = at.held;
  // these two are written to be shown
  if (code === "gpu-unreadable" || code === "image-input") return message;
  return refusal(code, q.model ?? getState().model ?? "", null, q.numCtx);
}

/** Words that came since the last frame, for the turn of one reply. */
interface Waiting {
  readonly id: string;
  text: string;
  thinking: string;
}

/** The turn with the words that waited for a frame. */
function withWaiting(turn: LiveTurn, w: Waiting, now: number): LiveTurn {
  const thought = reduceTurn(turn, { type: "thinking", text: w.thinking }, now) ?? turn;
  return reduceTurn(thought, { type: "delta", text: w.text }, now) ?? thought;
}

/**
 * Words the server did not take go back in their chat's composer, above anything typed there
 * since. Alone there they keep their name, so sending them again asks once: if the server has
 * them after all, its record takes them out.
 */
function backInBox(entry: Pick<Params<"reply.send">, "threadId" | "messageId" | "text" | "images" | "files">): void {
  const draft = getDraft(entry.threadId);
  const empty = draft.text === "" && draft.images.length === 0 && !draft.files?.length;
  const files = [...(entry.files ?? []), ...(empty ? [] : draft.files ?? [])];
  replaceDraft(entry.threadId, {
    text: empty ? entry.text : `${entry.text}\n${draft.text}`,
    images: empty ? entry.images ?? [] : [...(entry.images ?? []), ...draft.images],
    ...(files.length ? { files } : {}),
    sendId: empty ? entry.messageId : null,
  });
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

const shownTurn = (id: string) => Object.values(getState().turns).find((t) => t.turnId === id);

/** History, navigation, fit and RPC operations are wired by session.ts. `rules` is given only by the test that turns one off (records.test.ts). */
export function createChat({ applyServerEvent, call, reply: askOne, codeOf, createThread, creatingDraft, loadThread, loading, noteMessage, withMessage, untrackedDone, openThread, blockingFor }: ChatEffects, rules?: WindowRules) {
  askServer = askOne;
  const records = createRecords(rules);
  /** Image sends that open a new chat, by record id, until the server saves their question. */
  const firstDraws = new Map<string, { readonly draw: NonNullable<Params<"reply.send">["draw"]>; readonly drawCount: number | undefined }>();

  /**
   * One record changed, or left: the only way a message changes in this window. A change older
   * than the one held is dropped. A message held by a refusal says so on its own row, in every
   * window, so nothing is said here. `listed`: the list at connect.
   */
  function recordChanged(change: ReplyChange, listed = false): void {
    const id = change.kind === "is" ? change.reply.id : change.id;
    if (!records.takes(getState().replies.get(id), change)) return;
    // an old saved message the server says anything of is the server's: its add is not asked again
    if (oldQueue?.some((q) => q.id === id) === true) handedOver(id, false);
    pickTaken(change);
    if (change.kind === "left") return recordLeft(change.id, change.why);
    const r = change.reply;
    const saved = change.saved ?? [];
    // an edit open here (also one a reload brought back) is this window's, whatever the record says yet
    if (getState().editingQueued === r.id) editsHere.add(r.id);
    else if (r.stage !== "editing") editsHere.delete(r.id);
    if (isWaiting(r)) return waits(r, listed);
    if (r.stage === "starting") return starts(r);
    if (r.stage === "done") return done(r, saved);
    if (r.stage === "stopped" || r.stage === "failed") return over(r, saved);
    answers(r, saved);
  }

  /**
   * The phone's pick for a new chat went with its first send: once the server saved that question
   * the thread keeps the pick and its count, and the next new chat starts from Settings. A send held
   * or gone leaves the pick for the next try.
   */
  function pickTaken(change: ReplyChange): void {
    const id = change.kind === "is" ? change.reply.id : change.id;
    const first = firstDraws.get(id);
    if (first === undefined) return;
    if (change.kind === "left" || isWaiting(change.reply)) return void firstDraws.delete(id);
    const r = change.reply;
    if (!("questionId" in r)) return;
    firstDraws.delete(r.id);
    const { draw, drawCount } = first;
    applyServerEvent((st) => ({
      ...st.imagePick?.preset === draw.preset && st.imagePick.width === draw.width && st.imagePick.height === draw.height ? { imagePick: undefined } : {},
      imageCountNew: 1,
      threads: st.threads.map((t) => (t.id === r.threadId && drawCount !== undefined && drawCount > 1 ? { ...t, imageCount: drawCount } : t)),
    }));
  }

  /** A turn of this record whose question was never saved: when the record waits again, or leaves, nothing of the turn shows. */

  /** It waits: a row of its chat's tray. One that was on its way is back (refused, or a Stop pulled it back), and nothing of a turn shows. */
  function waits(r: WaitingReply, listed: boolean): void {
    const s = getState();
    // words an unanswered send put back in the composer: the server has them after all, and they are the row
    const draft = getDraft(r.threadId);
    const putBack = draft.sendId === r.messageId && draft.beforeEdit === undefined && s.editingQueued !== r.id;
    if (putBack) clearDraft(r.threadId);
    const said: Partial<State> = putBack && s.notice === refusal("closed", "", "box") ? { notice: null } : {};
    if (unstarted(s.turns[r.threadId], r.id)) waiting.delete(r.threadId);
    applyServerEvent((st) => ({
      replies: kept(st, r),
      ...(unstarted(st.turns[r.threadId], r.id) ? { turns: withTurn(st.turns, r.threadId, null) } : {}),
      ...said,
    }));
    // an edit open here the server let go (the window was gone past its grace): asked again
    if (listed && s.editingQueued === r.id && r.stage !== "editing") openEdit(r.id, r.threadId, edited?.id === r.id ? edited.text : r.text);
  }

  /** A turn that gives way to another record's in its chat: words it showed that no saved row will bring stay there, and its late words reach nothing. */
  function givesWay(turn: LiveTurn | undefined, to: string, keepWords: boolean): void {
    if (turn === undefined || turn.turnId === to) return;
    if (keepWords) keepStoppedWords(turn);
    waiting.delete(turn.threadId);
  }

  /** It is on its way: its chat's turn. Its question shows from the record itself until the saved one takes its place. */
  function starts(r: Extract<Reply, { readonly stage: "starting" }>): void {
    const now = Date.now();
    const { threadId } = r;
    const s = getState();
    const was = s.replies.get(r.id);
    // the server lets one reply run in a chat, and this is the one. A Retry replaces what it stopped: nothing of that stays under its question.
    givesWay(s.turns[threadId], r.id, r.retryOf === undefined);
    const made: LiveTurn = { threadId, turnId: r.id, model: r.draw?.preset ?? r.model ?? "", startedAt: now, thinking: "", text: "", tools: [] };
    applyServerEvent((st) => {
      const at = st.turns[threadId];
      return { replies: kept(st, r), turns: withTurn(st.turns, threadId, reduceTurn(at?.turnId === r.id ? at : made, { type: "reply", reply: clockOf(r) }, now)) };
    });
    // setup and the first download are the whole app waiting: a message that waited for them opens its chat when it goes
    if (was !== undefined && isWaiting(was) && behindSetup(was) && s.threadId !== threadId) openThread(threadId);
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
    const s = getState();
    const was = s.replies.get(r.id);
    const retried = was?.stage === "starting" ? was.retryOf : undefined;
    const turn = s.turns[threadId];
    const mine = turn?.turnId === r.id;
    if (!mine || turn.userMessageId !== r.questionId) questionSaved(r.id, threadId, r.questionId);
    givesWay(turn, r.id, retried === undefined);
    const clock = clockOf(r);
    if (mine) {
      // a second attempt starts over: the first one's waiting words are dropped (the server holds the queue behind it)
      if (turn.reply !== undefined && clock.attempt > turn.reply.attempt) waiting.delete(threadId);
      // the words that were waiting for a frame when the server took a Stop stay (W-05);
      // the open chat's words land in their own frame, a chat off screen takes them at the phase change
      else if (s.threadId !== threadId || clock.stoppedAt !== undefined) flushWords(threadId);
    }
    if (question !== undefined) noteMessage(threadId, question);
    const made: LiveTurn = { threadId, turnId: r.id, model: "", startedAt: now, thinking: "", text: "", tools: [] };
    applyServerEvent((st) => {
      const at = st.turns[threadId];
      // the saved question takes the place of the record's words
      const base = at?.turnId === r.id ? at : made;
      const started: LiveTurn = { ...base, userMessageId: base.userMessageId ?? r.questionId, model: r.stage === "drawing" ? r.preset : r.model };
      return { replies: kept(st, r), ...(question === undefined ? {} : withQuestion(st, threadId, question, retried)), turns: withTurn(st.turns, threadId, reduceTurn(started, { type: "reply", reply: clock }, now)) };
    });
  }

  /** A chat's rows with a question the server just saved, cached once its chat is open. It took a Retry's old rows out in the same write. */
  function withQuestion(st: State, threadId: string, question: Message, retried: string | undefined): Partial<State> {
    const rows = st.messages[threadId];
    if (rows === undefined) return st.threadId === threadId ? { messages: withMessage(st, threadId, question) } : {};
    const replaced = retried === undefined ? [] : retriedRows(rows);
    const base = replaced[0]?.id === retried ? { ...st, messages: { ...st.messages, [threadId]: rows.filter((m) => !replaced.includes(m)) } } : st;
    return { messages: withMessage(base, threadId, question) };
  }

  /** A reply that ends in the change that first brings its saved question: the question goes in its chat before the end does. */
  function askedLate(r: { readonly id: string; readonly threadId: string }, question: Message | undefined): void {
    const s = getState();
    const turn = s.turns[r.threadId];
    if (question === undefined || !unstarted(turn, r.id)) return;
    const was = s.replies.get(r.id);
    questionSaved(r.id, r.threadId, question.id);
    noteMessage(r.threadId, question);
    applyServerEvent((st) => ({ ...withQuestion(st, r.threadId, question, was?.stage === "starting" ? was.retryOf : undefined), turns: withTurn(st.turns, r.threadId, { ...turn, userMessageId: question.id }) }));
  }

  /** Its reply is saved: the row takes the turn's place, and the record is kept no longer. */
  function done(r: Extract<Reply, { readonly stage: "done" }>, saved: readonly Message[]): void {
    const { threadId } = r;
    askedLate(r, saved.find((m) => m.id === r.questionId));
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
    askedLate(r, question);
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
      // A Retry refused after it began to start saved nothing, and has no row to say so: every window
      // that showed it starting says why, where its chat is in view. One refused before that was
      // told to the window that pressed it, by its call.
      const was = s.replies.get(r.id);
      const here = s.view === "thread" && open;
      const notice = r.stage === "failed" && was?.stage === "starting" && was.retryOf !== undefined && here
        ? r.code === "image-input" || r.code === "gpu-unreadable" ? r.message : refusal(r.code, was.model ?? "", null, was.numCtx)
        : undefined;
      applyServerEvent((st) => ({
        replies: without(st, r.id),
        ...(unstarted(st.turns[threadId], r.id) ? { turns: withTurn(st.turns, threadId, null) } : {}),
        ...(notice === undefined ? {} : { notice, noticeOffer: null }),
      }));
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
      return { replies: without(st, r.id), ...(at?.turnId === r.id ? { turns: withTurn(st.turns, threadId, reduceTurn(at, said, Date.now())) } : {}) };
    });
    // on screen the ended turn stays with its Retry; elsewhere it settles into its chat now
    const ended = getState().turns[threadId];
    if (!open && ended !== undefined && ended.turnId === r.id) settle(ended);
  }

  /** It is on no list any more: removed, its chat deleted, or settled with nothing more to show. */
  function recordLeft(id: string, why: Extract<ReplyChange, { kind: "left" }>["why"]): void {
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
      void call("queue.add", { ...q, messageId: q.messageId ?? queueId(), waitFor: "reply", held: true, numCtx: s.numCtx, think: s.think }).then(() => true, (e: unknown) => {
        const code = codeOf(e);
        // never answered: it stays saved here, and goes at the next connection
        if (code === "closed" || code === "timeout") return undefined;
        // removed in another window while this one could not hear it: the removal stands, said nowhere twice
        if (code !== "queue-removed") setState({ notice: "The chat this message was waiting in is gone, so it was not sent." });
        return false;
      }).then((restored) => {
        handing.delete(q.id);
        if (restored !== undefined) handedOver(q.id, restored);
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
   * that the list does not name is gone. A reply of one, still shown as being written, ended while
   * this window could not hear it: its chat's saved rows are read again and take its place, with
   * no moment between in which neither shows. An edit open here keeps its message from going.
   */
  function replyListed(list: readonly ReplyListed[]): void {
    for (const { reply } of list) recordChanged({ kind: "is", reply }, true);
    for (const { reply, soFar } of list) if (soFar !== undefined) caughtUp(reply.id, soFar);
    const unlisted = new Set(records.unlisted());
    for (const id of unlisted) editsHere.delete(id);
    if (unlisted.size > 0) {
      const before = getState();
      const ended = Object.values(before.turns).filter((t) => unlisted.has(t.turnId) && t.end === undefined);
      // rows to read again: a reply whose question was saved, in a chat this window has read
      const reads = (t: LiveTurn) => t.userMessageId !== undefined && before.messages[t.threadId] !== undefined;
      for (const t of ended) waiting.delete(t.threadId);
      applyServerEvent((s) => {
        const replies = new Map(s.replies);
        for (const id of unlisted) replies.delete(id);
        // nothing of these was saved, or their chat is read on its next visit
        const turns = ended.filter((t) => !reads(t)).reduce((all, t) => (all[t.threadId]?.turnId === t.turnId ? withTurn(all, t.threadId, null) : all), s.turns);
        return { replies, turns };
      });
      for (const t of ended.filter(reads)) {
        const leaves = () => applyServerEvent((s) => (s.turns[t.threadId]?.turnId === t.turnId && s.turns[t.threadId]?.end === undefined && !s.replies.has(t.turnId) ? { turns: withTurn(s.turns, t.threadId, null) } : {}));
        void loadThread(t.threadId, true).then(leaves, leaves);
      }
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

  /** Apply one of the server's events to a thread's turn, if that turn is still the one of the record `id`. */
  function update(threadId: string, id: string, event: TurnEvent): void {
    applyServerEvent((s) => {
      const turn = s.turns[threadId];
      if (turn === undefined || turn.turnId !== id) return;
      return { turns: withTurn(s.turns, threadId, reduceTurn(turn, event, Date.now())) };
    });
  }

  // why: a Library question sends with keepDraft: the composer's own draft is left as it is
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
    const draw = opts.draw ?? drawChoice(s);
    if (draw === undefined && imageMode(s)) return setState({ notice: "The image models are still being read. Send again in a moment." });
    const cannotSee = draw === undefined ? imageReason(s.models, s.model, images) : null;
    if (cannotSee) return setState({ notice: cannotSee });
    const threadId = s.view === "thread" || opts.reuseThread ? s.threadId : null;
    const messageId = draft.sendId ?? queueId();
    if (s.editingQueued !== null && !apart) return saveEdit(s.editingQueued, key, { content, images, files, messageId });
    const early = draw === undefined && sendsBeforeReady(s);
    if (!(draw === undefined ? chatReady(s) || early : s.conn.kind === "open")) return;
    const model = sendableModel(s.models, s.model);
    if (model === undefined && draw === undefined && !early) return;
    const out: Outgoing = { content, images, ...attached, messageId, model: model ?? "", threadId, keepDraft: apart, ...(draw === undefined ? {} : { draw }) };
    // why: behind setup or a reply in its own chat it waits, so it stops nothing and needs no warning
    if (early || streamingHere(s)) return launch(out, false);
    return admit(out);
  }

  let asking = false;

  async function admit(out: Outgoing): Promise<void> {
    if (asking) return;
    out = { ...out, messageId: out.messageId ?? queueId() };
    asking = true;
    let blocking: readonly BlockingTurn[] = [];
    // why: a picture loads no chat model, so it stops no other chat's reply
    if (out.draw === undefined) {
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

  // why: stopTurns are the replies a warning named and the person agreed to; none is standing consent
  async function launch(out: Outgoing, stopOthers: boolean, stopTurns?: readonly string[]): Promise<void> {
    if (gone(out)) return setState({ stopAsk: null });
    if (out.queuedId !== undefined) return queueNow(out.queuedId, stopOthers, stopTurns);
    settleEnded(undefined, out.regenerate === true ? out.threadId ?? undefined : undefined);
    // why: the words stay in view until the new chat exists; a failed create leaves the draft alone
    const threadId = out.threadId ?? (await createThread(out.content, out.model === "" ? undefined : out.model, !out.keepDraft));
    if (threadId === null) return;
    const draft = getDraft(out.threadId);
    if (!out.keepDraft && draft.text.trim() === out.content && draft.images === out.images && (draft.files ?? []).length === (out.files ?? []).length) clearDraft(out.threadId);
    if (out.threadId === null && !out.keepDraft) moveDraft(null, threadId);
    setState({ notice: null, stopAsk: null });
    const consent: StopConsent | undefined = !stopOthers ? undefined : stopTurns === undefined ? { kind: "standing" } : { kind: "named", replies: [...stopTurns] };
    await sendOne(threadId, out, consent);
  }

  async function sendOne(threadId: string, out: Outgoing, consent: StopConsent | undefined): Promise<void> {
    const s = getState();
    const { draw } = out;
    const retryOf = out.regenerate === true ? retriedRows(s.messages[threadId] ?? [])[0]?.id : undefined;
    const fresh = out.threadId === null;
    const drawCount = draw === undefined ? undefined : fresh ? s.imageCountNew : s.threads.find((t) => t.id === threadId)?.imageCount ?? 1;
    const params: Params<"reply.send"> = {
      id: queueId(), threadId, messageId: out.messageId ?? queueId(), text: out.content,
      ...(out.model === "" ? {} : { model: out.model }),
      numCtx: s.numCtx, think: s.think,
      ...(out.images?.length ? { images: [...out.images] } : {}),
      ...(out.files?.length ? { files: [...out.files] } : {}),
      ...(draw === undefined ? {} : { draw, ...(drawCount === undefined ? {} : { drawCount }) }),
      ...(retryOf === undefined ? {} : { retryOf }),
      ...(consent === undefined ? { askFirst: true } : { consent }),
    };
    // why: the next new chat starts on the model last sent to (navigation.ts newThread)
    if (draw === undefined && out.model !== "") setState({ chosen: out.model });
    if (draw !== undefined && fresh) firstDraws.set(params.id, { draw, drawCount });
    if (retryOf === undefined) pressed(params);
    let a: ReplyOutcome;
    try {
      a = await askOne("reply.send", params);
    } catch (e) {
      firstDraws.delete(params.id);
      unpressed(params.id);
      return notSent(e, params, out);
    }
    switch (a.answer) {
      case "done":
      case "sending":
      case "elsewhere":
        return recordChanged({ kind: "is", reply: a.reply, saved: [] });
      case "gone":
        firstDraws.delete(params.id);
        unpressed(params.id);
        if (a.why !== "sent") return setState({ notice: tooLate(a) });
        setState({ notice: "Your message was already sent. It was not sent again." });
        return void loadThread(threadId, true);
      case "not-reached":
        firstDraws.delete(params.id);
        unpressed(params.id);
        if (retryOf !== undefined) return setState({ notice: refusal("closed", out.model, null) });
        backInBox(params);
        return setState({ notice: inView(threadId) ? refusal("closed", out.model, "box") : draftElsewhere(threadId) });
    }
  }

  /**
   * The message shows from the press, as the server will most likely take it: on its way in a quiet
   * chat, waiting behind a reply in a busy one. The server's first word on it (rev 1 and up) replaces it.
   */
  function pressed(p: Params<"reply.send">): void {
    const { id, threadId, askFirst: _ask, consent: _consent, ...said } = p;
    const at = Date.now();
    const s = getState();
    const busy = runningTurn(s, threadId) !== undefined || waitingReplies(s).some((w) => w.threadId === threadId);
    const reply: Reply = busy
      ? { id, threadId, rev: 0, ...said, at, stage: "queued" }
      : { id, threadId, rev: 0, ...said, at, stage: "starting", attempt: 1, startedAt: at };
    recordChanged({ kind: "is", reply, saved: [] });
  }

  /** The server made no record of the press: what showed for it goes. */
  function unpressed(id: string): void {
    const was = getState().replies.get(id);
    if (was === undefined || was.rev !== 0) return;
    if (unstarted(getState().turns[was.threadId], id)) waiting.delete(was.threadId);
    applyServerEvent((st) => ({
      replies: without(st, id),
      ...(unstarted(st.turns[was.threadId], id) ? { turns: withTurn(st.turns, was.threadId, null) } : {}),
    }));
  }

  // why: a send that becomes a record says how it went on its row; only a refused call lands here
  function notSent(e: unknown, p: Params<"reply.send">, out: Outgoing): void {
    const s = getState();
    const code = codeOf(e);
    const again = p.retryOf !== undefined;
    const here = inView(p.threadId);
    const model = p.model ?? "";
    if (!again) backInBox(p);
    const blocking = e instanceof WireError ? e.blocking : undefined;
    if (again && code === "would-stop" && blocking !== undefined && here) {
      const ask = { ...out, threadId: p.threadId, blocking };
      if (stopOthersOk()) return void launch(ask, true);
      return setState({ stopAsk: ask, notice: null });
    }
    const said = e instanceof Error ? e.message : "";
    const notice = !again && !here ? draftElsewhere(p.threadId)
      : code === "gpu-unreadable" ? `${said}${again ? "" : " Your message is back in the box."}`
      : code === "image-input" ? said
      : refusal(code, model, again ? null : "box", p.numCtx);
    const offer = code === "wont-fit" && here && e instanceof WireError ? e.offer : undefined;
    setState({ notice, noticeOffer: offer === undefined ? null : { notice, model, numCtx: p.numCtx ?? ctxFor(s.numCtx, s.models, model), offer } });
  }

  // why: Send now with nothing in the way, or a yes given: the server sends it first when its chat is free
  function queueNow(id: string, stopOthers: boolean, stopTurns?: readonly string[]): void {
    if (!waitingReplies(getState()).some((x) => x.id === id)) return;
    setState({ stopAsk: null, notice: null });
    const consent: StopConsent | undefined = !stopOthers ? undefined : stopTurns === undefined ? { kind: "standing" } : { kind: "named", replies: [...stopTurns] };
    void askOne("reply.now", { id, ...(consent === undefined ? {} : { consent }) }).then((a) => {
      switch (a.answer) {
        case "done":
          return;
        case "sending":
        case "gone":
          return setState({ notice: tooLate(a) });
        case "elsewhere":
          return setState({ notice: OPEN_ELSEWHERE });
        case "not-reached":
          return setState({ notice: `${NOT_REACHED} The message is still waiting.` });
      }
    });
  }

  // why: dontShowAgain is saved only here, so a Cancel with the box ticked changes nothing
  function confirmStopAsk(dontShowAgain: boolean): void {
    const ask = getState().stopAsk;
    if (ask === null) return;
    if (dontShowAgain) {
      try {
        localStorage.setItem(STOP_OTHERS_KEY, "1");
      } catch {
        // external: a browser's private window may refuse storage; the warning then shows again
      }
    }
    void launch(ask, true, stopOthersOk() ? undefined : ask.blocking.flatMap((t) => t.turnId ?? []));
  }

  // why: while the server is still stopping it, its end is on its way and brings the saved row
  function keepStoppedWords(l: LiveTurn): void {
    if (l.end === undefined || stopping(l) || (l.end.kind === "error" && l.end.code === "closed") || (l.text === "" && l.thinking === "" && l.tools.length === 0)) return;
    const { threadId } = l;
    const stopped = l.end.kind === "stopped";
    const tools = l.tools.map((t) => t.state === "running" ? { ...t, state: "error" as const, ...(stopped ? { stopped: true as const } : {}) } : t);
    const times = recordTimes(l);
    const msg: Message = { id: `stopped-${l.turnId}`, threadId, role: "assistant", content: l.text, ...(l.thinking === "" ? {} : { thinking: l.thinking }), ...(tools.length === 0 ? {} : { tools }),
      model: l.model, createdAt: Date.now(), ...(times === undefined ? { interrupted: true as const } : { times }) };
    // why: a partial is not the whole history of a chat this window never opened
    if (getState().messages[threadId] === undefined && !loading(threadId)) void loadThread(threadId);
    noteMessage(threadId, msg);
    applyServerEvent((s) => ({ messages: withMessage(s, threadId, msg) }));
  }

  // why: ended replies keep their Retry until the person moves on: a send, or opening a running chat
  function settleEnded(except?: string, regenerating?: string): void {
    const ended = Object.values(getState().turns).filter((t) => t.end !== undefined && t.threadId !== except);
    if (ended.length === 0) return;
    for (const t of ended) if (t.threadId !== regenerating) keepStoppedWords(t);
    applyServerEvent((s) => ({ turns: ended.reduce((turns, t) => (turns[t.threadId]?.turnId === t.turnId ? withTurn(turns, t.threadId, null) : turns), s.turns) }));
  }

  function stop(): void {
    const turn = runningTurn(getState(), getState().threadId);
    if (turn !== undefined) void askOne("reply.stop", { id: turn.turnId });
  }

  // why: a Retry replaces an unfinished reply; after a finished one the server keeps both copies
  function retry(): void {
    const s = getState();
    if (s.threadId === null || !canRetry(s)) return;
    const last = (s.messages[s.threadId] ?? []).findLast((m) => m.role === "user");
    if (!last) return;
    const draw = drawChoice(s);
    void admit({ content: last.content, images: last.images, ...(last.files ? { files: last.files } : {}), model: s.model ?? last.model ?? "", threadId: s.threadId, keepDraft: true, regenerate: true, ...(draw === undefined ? {} : { draw }) });
  }

  // why: the open chat keeps its reply until the list says how it stands; one behind is let go
  function lostTurn(): void {
    const open = getState().threadId;
    if (open !== null) flushWords(open);
    waiting.clear();
    applyServerEvent((s) => {
      let turns = s.turns;
      for (const turn of Object.values(s.turns)) if (turn.threadId !== open && turn.end === undefined) turns = withTurn(turns, turn.threadId, null);
      return { turns };
    });
  }

  // why: words land once per frame and only for the open chat; a chat off screen takes them at a phase
  const waiting = new Map<string, Waiting>();
  let raf = 0;

  function flushWords(threadId: string): void {
    const w = waiting.get(threadId);
    if (w === undefined) return;
    waiting.delete(threadId);
    perf.flushes++;
    applyServerEvent((s) => {
      const turn = s.turns[threadId];
      if (turn === undefined || turn.turnId !== w.id) return;
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
    // why: words after the server took a Stop are dropped (W-05): the record's seconds end there
    if (turn.end?.kind === "stopped") return;
    let w = waiting.get(turn.threadId);
    if (w === undefined || w.id !== turn.turnId) {
      w = { id: turn.turnId, text: "", thinking: "" };
      waiting.set(turn.threadId, w);
    }
    w[kind] += t;
    // oxlint-disable-next-line gates/timer-needs-reason -- the next frame: the stream's words since the last one go into the store in one write
    if (getState().threadId === turn.threadId && raf === 0) raf = requestAnimationFrame(frame);
  }

  function catchUp(threadId: string): void {
    flushWords(threadId);
    if (turnOf(getState(), threadId) !== undefined) settleEnded(threadId);
  }


  // why: a part says where it starts, so words this window has are not added twice
  function onWords({ id, part }: Payload<"reply.words">): void {
    const turn = shownTurn(id);
    if (turn === undefined) return;
    const { threadId } = turn;
    if (part.type === "again") {
      waiting.delete(threadId);
      return applyServerEvent((s) => {
        const at = s.turns[threadId];
        return at?.turnId === id ? { turns: withTurn(s.turns, threadId, { ...at, text: "", thinking: "", tools: [] }) } : undefined;
      });
    }
    if (part.type === "tool") {
      flushWords(threadId);
      return update(threadId, id, part);
    }
    const w = waiting.get(threadId);
    const have = turn[part.type].length + (w?.id === id ? w[part.type].length : 0);
    // why: a part past this window's words follows ones it missed; the next connect's list has them
    if (part.from > have) return;
    const fresh = part.text.slice(have - part.from);
    if (fresh !== "") queueWords(turn, part.type, fresh);
  }

  function caughtUp(id: string, soFar: SoFar): void {
    const turn = shownTurn(id);
    if (turn === undefined) return;
    const { threadId } = turn;
    flushWords(threadId);
    applyServerEvent((s) => {
      const at = s.turns[threadId];
      if (at?.turnId !== id || at.end !== undefined) return;
      const words = { ...at, text: soFar.text.length > at.text.length ? soFar.text : at.text, thinking: soFar.thinking.length > at.thinking.length ? soFar.thinking : at.thinking };
      const now = Date.now();
      return { turns: withTurn(s.turns, threadId, soFar.steps.reduce((t, step) => reduceTurn(t, { type: "tool", step }, now) ?? t, words)) };
    });
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
    onWords, lostTurn, catchUp, connected, recordChanged, replyListed, editEnded,
  };
}
