import { type AttachedFile, type BlockingTurn, type ImageChoice, type Message, type Params, type Payload, type Reply, type ReplyCall, type ReplyChange, type ReplyListed, type ReplyOutcome, type ReplyTimes, type SoFar, type StopConsent, WireError } from "@gates-local/contracts";
import { ctxFor, describeModel, k } from "../lib/words/format.ts";
import { firstChatPull, sendableModel } from "../models/pick.ts";
import { type LiveTurn, NA, type State, type StopAsk, type TurnClock, type WaitingReply, behindSetup, chatReady, getState, isWaiting, runningTurn, setState, streamingHere, turnOf, waitingReplies } from "../lib/store/store.ts";
import { imageReason } from "./paste.ts";
import { drawChoice, imageMode } from "../image/image-choice.ts";
import { releaseFiles } from "./file-holds.ts";
import { frameLoop } from "../lib/ui/kit/frame.ts";
import { type Draft, type DraftKey, beginQueuedDraft, cancelQueuedDraft, clearDraft, currentDraftKey, getDraft, moveDraft, renewDraft, replaceDraft } from "../lib/store/drafts.ts";
import type { ServerEvent } from "../lib/session/server-state.ts";
import { type TurnEvent, type TurnFailure, reduceTurn, stopping, unfinished, withTurn } from "../thread/turn.ts";
import { stopReason as stopWords } from "../thread/times.ts";
import { type WindowRules, createRecords } from "./records.ts";

declare global {
  interface Window {
    glPerf?: { deltas: number; flushes: number; terminalFlush?: boolean };
  }
}

interface ChatEffects {
  readonly applyServerEvent: (event: ServerEvent) => void;
  readonly reply: <M extends ReplyCall>(method: M, params: Params<M>) => Promise<ReplyOutcome>;
  readonly codeOf: (error: unknown) => string;
  readonly createThread: (content: string, model: string | undefined, fromDraft?: boolean) => Promise<string | null>;
  readonly creatingDraft: (version: number) => boolean;
  readonly loadThread: (threadId: string, force?: boolean) => Promise<void>;
  readonly loading: (threadId: string) => boolean;
  readonly noteMessage: (threadId: string, message: Message) => void;
  readonly rowsSaved: (threadId: string, chatNumber: number) => void;
  readonly withMessage: (state: State, threadId: string, message: Message) => State["messages"];
  readonly untrackedDone: (threadId: string, message: Message) => void;
  readonly openThread: (threadId: string) => void;
  readonly blockingFor: (model: string, numCtx: number) => Promise<readonly BlockingTurn[]>;
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

const STOP_OTHERS_KEY = "gates-local.stop-others-ok";

const queueId = () => `q-${crypto.randomUUID()}`;

let askServer: ChatEffects["reply"] | undefined;

let edited: { readonly id: string; readonly base: string; readonly text: string; tried?: string } | null = null;

const editsHere = new Set<string>();

export const editedElsewhere = (q: WaitingReply): boolean => q.stage === "editing" && !editsHere.has(q.id);

const ALREADY_SENT = "That message was already sent.";
const ON_ITS_WAY = "This message is already on its way.";
const REMOVED = "That message was removed.";
const OPEN_ELSEWHERE = "That message is open in another window.";
const NOT_REACHED = "Gates Local stopped answering.";
const CLOSING = "Gates Local is closing. The reply written so far was saved.";
const tooLate = (a: Extract<ReplyOutcome, { answer: "gone" | "sending" }>): string => (a.answer === "sending" ? ON_ITS_WAY : a.why === "sent" ? ALREADY_SENT : REMOVED);

const CHAT_GONE = "The chat this message was waiting in is gone, so it was not sent.";
const RESTORED_NOTICE = "Your queued messages were restored on hold. Use Send now when you are ready.";
const QUEUE_MOVED_KEY = "gates-local.queue-on-server";

export interface SavedQueued {
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
  readonly at: number;
  readonly messageId?: string;
  readonly images?: readonly string[];
  readonly files?: readonly AttachedFile[];
  readonly model?: string;
}

let oldQueue: readonly SavedQueued[] | null = null;
let onOldQueue: (() => void) | undefined;
let oldQueueChanged: (() => void) | undefined;

export function oldQueueRead(queued: readonly SavedQueued[], owed: boolean): readonly SavedQueued[] {
  let moved = false;
  try {
    moved = localStorage.getItem(QUEUE_MOVED_KEY) === "1";
  } catch {}
  oldQueue = moved && !owed ? [] : queued;
  onOldQueue?.();
  return oldQueue;
}

export function oldQueueOwed(changed?: () => void): readonly SavedQueued[] {
  if (changed !== undefined) oldQueueChanged = changed;
  return oldQueue ?? [];
}

function queueMoved(): void {
  try {
    localStorage.setItem(QUEUE_MOVED_KEY, "1");
  } catch {
    // external: a browser's private window may throw on localStorage.setItem
  }
}

function clockOf(r: Exclude<Reply, WaitingReply | { readonly stage: "done" | "stopped" | "failed" }>): TurnClock {
  const none = { workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {} };
  if (r.stage === "starting") return { ...none, stage: r.draw !== undefined ? "drawing" : r.loading === true ? "loading" : "waiting", startedAt: r.startedAt };
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

export function sendsBeforeReady(s: State): boolean {
  if (s.conn.kind !== "open") return false;
  return s.runtime?.state === "installing" || (s.runtime?.state === "ready" && firstPull(s) !== undefined);
}

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

const APART: Draft = { text: "", images: [], sendId: null, version: -1 };

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


export function canRetry(s: State): boolean {
  return s.threadId !== null && !streamingHere(s) && !stopping(s.turns[s.threadId]);
}

const stopReason = (event: { readonly code: string; readonly neededBy?: string | undefined }): string | undefined => stopWords(event, catalogOf(getState()));

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
    ...(l.end?.kind === "error" ? { why: { code: l.end.code, message: l.end.message } } : {}),
  };
}

const retriable = (m: Message) => m.interrupted === true || m.imageJob?.state === "error" || m.imageJob?.state === "cancelled";

function retriedRows(messages: readonly Message[]): readonly Message[] {
  const rows = messages.slice(messages.findLastIndex((m) => m.role === "user"));
  return rows[0]?.role === "user" && rows.slice(1).every(retriable) ? rows : [];
}

export function removeQueued(id: string): void {
  void askServer?.("reply.remove", { id }).then((a) => {
    switch (a.answer) {
      case "done":
        dropped(id);
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

export function editQueued(id: string): void {
  const q = waitingReplies(getState()).find((x) => x.id === id);
  if (!q) return;
  beginQueuedDraft(q.threadId, q.text, q.images ?? [], q.messageId, q.files);
  edited = { id, base: q.messageId, text: q.text };
  editsHere.add(id);
  setState({ editingQueued: id, notice: null, stopAsk: null });
  openEdit(id, q.threadId, q.text);
}

function openEdit(id: string, threadId: string, text: string): void {
  void askServer?.("reply.edit", { id, open: true }).then((a) => {
    switch (a.answer) {
      case "done":
        return;
      case "not-reached":
        return;
      case "sending":
      case "gone":
        return closeEdit(id, threadId, text, tooLate(a));
      case "elsewhere":
        return closeEdit(id, threadId, text, OPEN_ELSEWHERE);
    }
  });
}

function closeEdit(id: string, threadId: DraftKey, text: string | undefined, why: string): void {
  if (getState().editingQueued !== id) return;
  const draft = getDraft(threadId);
  const typed = draft.text !== text;
  if (typed) replaceDraft(threadId, { text: draft.text, images: draft.images, ...(draft.files?.length ? { files: draft.files } : {}), sendId: null });
  else cancelQueuedDraft(threadId);
  if (edited?.id === id) edited = null;
  setState({ editingQueued: null, notice: typed ? `${why} Your new words are still in the composer.` : why });
}

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

export function heldSentence(q: WaitingReply): string | undefined {
  const at = q.stage === "editing" ? q.back : q;
  if (at.stage !== "held" || at.held.why !== "refused") return undefined;
  const { code, message } = at.held;
  if (code === "gpu-unreadable" || code === "image-input") return message;
  return refusal(code, q.model ?? getState().model ?? "", null, q.numCtx);
}

interface Waiting {
  readonly id: string;
  text: string;
  thinking: string;
}

function withWaiting(turn: LiveTurn, w: Waiting, now: number): LiveTurn {
  const thought = reduceTurn(turn, { type: "thinking", text: w.thinking }, now) ?? turn;
  return reduceTurn(thought, { type: "delta", text: w.text }, now) ?? thought;
}

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

function endOf(r: Extract<Reply, { readonly stage: "stopped" | "failed" }>, at: number): TurnFailure {
  if (r.stage === "failed") return { type: "error", code: r.code, message: r.message, ended: { reason: "failed", at } };
  switch (r.by.who) {
    case "person": return { type: "error", code: "cancelled", message: "", ended: { reason: "stopped", at } };
    case "preempted": return { type: "error", code: "preempted", message: "", ...(r.by.neededBy === undefined ? {} : { neededBy: r.by.neededBy }), ended: { reason: "preempted", at } };
    case "runtime": return { type: "error", code: "runtime-changed", message: "", ended: { reason: "preempted", at } };
    case "closing": return { type: "error", code: "cancelled", message: CLOSING, ended: { reason: "preempted", at } };
  }
}

function handedOver(id: string, restored: boolean): void {
  oldQueue = (oldQueue ?? []).filter((q) => q.id !== id);
  queueMoved();
  if (restored) setState({ notice: RESTORED_NOTICE });
  oldQueueChanged?.();
}

const shownTurn = (id: string) => Object.values(getState().turns).find((t) => t.turnId === id);
const tryOf = (r: Reply | undefined): number => (r !== undefined && "try" in r ? r.try : 0);

export function createChat({ applyServerEvent, reply: askOne, codeOf, createThread, creatingDraft, loadThread, loading, noteMessage, rowsSaved, withMessage, untrackedDone, openThread, blockingFor }: ChatEffects, rules?: WindowRules) {
  askServer = askOne;
  const records = createRecords(rules);
  const firstDraws = new Map<string, { readonly draw: NonNullable<Params<"reply.send">["draw"]>; readonly drawCount: number | undefined }>();

  function recordChanged(change: ReplyChange, listed = false): void {
    const id = change.kind === "is" ? change.reply.id : change.id;
    if (!records.takes(getState().replies.get(id), change)) return;
    if (oldQueue?.some((q) => q.id === id) === true) handedOver(id, false);
    pickTaken(change);
    if (change.kind === "left") return recordLeft(change.id, change.why);
    const r = change.reply;
    const saved = change.saved ?? [];
    if (getState().editingQueued === r.id) editsHere.add(r.id);
    else if (r.stage !== "editing") editsHere.delete(r.id);
    if (isWaiting(r)) return waits(r, listed);
    if (r.stage === "starting") return starts(r);
    if (r.stage === "done") done(r, saved);
    else if (r.stage === "stopped" || r.stage === "failed") over(r, saved);
    else answers(r, saved);
    if (change.chatNumber !== undefined) rowsSaved(r.threadId, change.chatNumber);
  }

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


  function waits(r: WaitingReply, listed: boolean): void {
    const s = getState();
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
    if (listed && s.editingQueued === r.id && r.stage !== "editing") openEdit(r.id, r.threadId, edited?.id === r.id ? edited.text : r.text);
  }

  function givesWay(turn: LiveTurn | undefined, to: string, keepWords: boolean): void {
    if (turn === undefined || turn.turnId === to) return;
    if (keepWords) keepStoppedWords(turn);
    waiting.delete(turn.threadId);
  }

  function starts(r: Extract<Reply, { readonly stage: "starting" }>): void {
    const now = Date.now();
    const { threadId } = r;
    const s = getState();
    const was = s.replies.get(r.id);
    givesWay(s.turns[threadId], r.id, r.retryOf === undefined);
    const made: LiveTurn = { threadId, turnId: r.id, model: r.draw?.preset ?? r.model ?? "", startedAt: now, thinking: "", text: "", tools: [] };
    applyServerEvent((st) => {
      const at = st.turns[threadId];
      return { replies: kept(st, r), turns: withTurn(st.turns, threadId, reduceTurn(at?.turnId === r.id ? at : made, { type: "reply", reply: clockOf(r) }, now)) };
    });
    if (was !== undefined && isWaiting(was) && behindSetup(was) && s.threadId !== threadId) openThread(threadId);
  }

  function questionSaved(id: string, threadId: string, questionId: string): void {
    const draft = getDraft(threadId);
    if (draft.sendId === questionId) {
      if (draft.beforeEdit) cancelQueuedDraft(threadId);
      else clearDraft(threadId);
    } else if (getState().editingQueued === id) renewDraft(threadId);
    if (edited?.id === id) edited = null;
    applyServerEvent((s) => {
      const editing = s.editingQueued === id;
      const ask = s.stopAsk?.messageId === questionId;
      if (!editing && !ask) return;
      return { ...(editing ? { editingQueued: null } : {}), ...(ask ? { stopAsk: null } : {}) };
    });
  }

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
      if (turn.reply !== undefined && clock.attempt > turn.reply.attempt) waiting.delete(threadId);
      else if (s.threadId !== threadId || clock.stoppedAt !== undefined) flushWords(threadId);
    }
    if (question !== undefined) noteMessage(threadId, question);
    const made: LiveTurn = { threadId, turnId: r.id, model: "", startedAt: now, thinking: "", text: "", tools: [] };
    applyServerEvent((st) => {
      const at = st.turns[threadId];
      const base = at?.turnId === r.id ? at : made;
      const started: LiveTurn = { ...base, userMessageId: base.userMessageId ?? r.questionId, model: r.stage === "drawing" ? r.preset : r.model };
      return { replies: kept(st, r), ...(question === undefined ? {} : withQuestion(st, threadId, question, retried)), turns: withTurn(st.turns, threadId, reduceTurn(started, { type: "reply", reply: clock }, now)) };
    });
  }

  function withQuestion(st: State, threadId: string, question: Message, retried: string | undefined): Partial<State> {
    const rows = st.messages[threadId];
    if (rows === undefined) return st.threadId === threadId ? { messages: withMessage(st, threadId, question) } : {};
    const replaced = retried === undefined ? [] : retriedRows(rows);
    const base = replaced[0]?.id === retried ? { ...st, messages: { ...st.messages, [threadId]: rows.filter((m) => !replaced.includes(m)) } } : st;
    return { messages: withMessage(base, threadId, question) };
  }

  function askedLate(r: { readonly id: string; readonly threadId: string }, question: Message | undefined): void {
    const s = getState();
    const turn = s.turns[r.threadId];
    if (question === undefined || !unstarted(turn, r.id)) return;
    const was = s.replies.get(r.id);
    questionSaved(r.id, r.threadId, question.id);
    noteMessage(r.threadId, question);
    applyServerEvent((st) => ({ ...withQuestion(st, r.threadId, question, was?.stage === "starting" ? was.retryOf : undefined), turns: withTurn(st.turns, r.threadId, { ...turn, userMessageId: question.id }) }));
  }

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
    if (open && window.glPerf?.terminalFlush === true) {
      perf.flushes++;
      applyServerEvent((st) => ({ turns: { ...st.turns, [threadId]: { ...turn } } }));
    }
    waiting.delete(threadId);
    if (open) noteMessage(threadId, msg);
    applyServerEvent((st) => ({
      replies: without(st, r.id),
      ...(open ? { messages: withMessage(st, threadId, msg) } : {}),
      turns: withTurn(st.turns, threadId, null),
    }));
    if (!open) untrackedDone(threadId, msg);
  }

  function over(r: Extract<Reply, { readonly stage: "stopped" | "failed" }>, saved: readonly Message[]): void {
    const { threadId } = r;
    const question = r.questionId === undefined ? undefined : saved.find((m) => m.id === r.questionId);
    askedLate(r, question);
    const partial = saved.find((m) => m.role === "assistant");
    const stamp = r.stage === "stopped" && r.by.who === "person" ? (partial ?? question)?.times : undefined;
    const event: TurnFailure = stamp?.ended.reason === "failed" && stamp.why !== undefined
      ? { type: "error", code: stamp.why.code, message: stamp.why.message, ended: stamp.ended }
      : endOf(r, r.at);
    const said = { ...event, message: stopReason(event) ?? event.message, ...(partial === undefined ? {} : { partial }), ...(question === undefined ? {} : { question }) };
    const s = getState();
    const turn = s.turns[threadId];
    const open = s.threadId === threadId;
    if (r.questionId === undefined) {
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
    keepQuestion(threadId, said);
    applyServerEvent((st) => {
      const at = st.turns[threadId];
      return { replies: without(st, r.id), ...(at?.turnId === r.id ? { turns: withTurn(st.turns, threadId, reduceTurn(at, said, Date.now())) } : {}) };
    });
    const ended = getState().turns[threadId];
    if (!open && ended !== undefined && ended.turnId === r.id) settle(ended);
  }

  function recordLeft(id: string, why: Extract<ReplyChange, { kind: "left" }>["why"]): void {
    editsHere.delete(id);
    const was = getState().replies.get(id);
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
  // why: words past this window's end that land before this connection's list follow its words so far
  const ahead = new Map<string, Array<Payload<"reply.words">["part"]>>();
  const handing = new Set<string>();

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
      const { at: _typed, ...said } = q;
      void askOne("reply.send", { ...said, messageId: q.messageId ?? queueId(), held: true, numCtx: s.numCtx, think: s.think }).then((a) => {
        if (a.answer === "not-reached") return undefined;
        if (a.answer !== "gone") return true;
        if (a.why === "chat-deleted") setState({ notice: CHAT_GONE });
        return false;
      }, () => {
        setState({ notice: CHAT_GONE });
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
    ahead.clear();
    records.connected(getState().replies.keys());
  }

  function replyListed(list: readonly ReplyListed[]): void {
    const held = new Map(list.map(({ reply }) => [reply.id, tryOf(getState().replies.get(reply.id))]));
    for (const { reply } of list) recordChanged({ kind: "is", reply }, true);
    // why: a list read before a retry this window already took holds the thrown-away try's words
    for (const { reply, soFar } of list) if (soFar !== undefined && tryOf(reply) >= (held.get(reply.id) ?? 0)) caughtUp(reply.id, soFar);
    const unlisted = new Set(records.unlisted());
    for (const id of unlisted) editsHere.delete(id);
    if (unlisted.size > 0) {
      const before = getState();
      const ended = Object.values(before.turns).filter((t) => unlisted.has(t.turnId) && t.end === undefined);
      const reads = (t: LiveTurn) => t.userMessageId !== undefined && before.messages[t.threadId] !== undefined;
      for (const t of ended) waiting.delete(t.threadId);
      applyServerEvent((s) => {
        const replies = new Map(s.replies);
        for (const id of unlisted) replies.delete(id);
        const turns = ended.filter((t) => !reads(t)).reduce((all, t) => (all[t.threadId]?.turnId === t.turnId ? withTurn(all, t.threadId, null) : all), s.turns);
        return { replies, turns };
      });
      for (const t of ended.filter(reads)) {
        const leaves = () => applyServerEvent((s) => (s.turns[t.threadId]?.turnId === t.turnId && s.turns[t.threadId]?.end === undefined && !s.replies.has(t.turnId) ? { turns: withTurn(s.turns, t.threadId, null) } : {}));
        void loadThread(t.threadId, true).then(leaves, leaves);
      }
    }
    listedHere = true;
    ahead.clear();
    moveOldQueue();
  }

  function editEnded(id: string): void {
    if (edited?.id === id) edited = null;
    void askOne("reply.edit", { id, open: false });
  }

  let saving: string | null = null;

  async function saveEdit(id: string, key: DraftKey, words: { readonly content: string; readonly images: readonly string[]; readonly files: readonly AttachedFile[]; readonly messageId: string }): Promise<void> {
    if (saving === id) return;
    saving = id;
    const started = edited?.id === id ? edited : undefined;
    const row = getState().replies.get(id);
    const has = row !== undefined && isWaiting(row) ? row.messageId : undefined;
    const base = has !== undefined && has === started?.tried ? has : started?.base ?? has ?? words.messageId;
    const a = await askOne("reply.change", { id, base, messageId: words.messageId, text: words.content, images: [...words.images], files: [...words.files] });
    saving = null;
    if (getState().editingQueued !== id) return;
    switch (a.answer) {
      case "done":
        cancelQueuedDraft(key);
        edited = null;
        return setState({ editingQueued: null, notice: null });
      case "not-reached":
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

  const waiting = new Map<string, Waiting>();
  let framed = false;

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

  function frame(): boolean {
    framed = false;
    const open = getState().threadId;
    if (open !== null) flushWords(open);
    return false;
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
    if (getState().threadId !== turn.threadId || framed) return;
    framed = true;
    // why: the next frame: the stream's words since the last one go into the store in one write
    frameLoop(frame);
  }

  function catchUp(threadId: string): void {
    flushWords(threadId);
    if (turnOf(getState(), threadId) !== undefined) settleEnded(threadId);
  }


  // why: a part says where it starts, so words this window has are not added twice
  function onWords({ id, part }: Payload<"reply.words">): void {
    const turn = shownTurn(id);
    if (turn === undefined) {
      // why: words before this connection's list is read follow the words so far it brings
      if (!listedHere) ahead.set(id, part.type === "again" ? [] : [...ahead.get(id) ?? [], part]);
      return;
    }
    const { threadId } = turn;
    if (part.type === "again") {
      waiting.delete(threadId);
      ahead.delete(id);
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
    // why: a part past this window's words follows ones it missed; a connect's list has them
    if (part.from > have) {
      if (!listedHere) ahead.set(id, [...ahead.get(id) ?? [], part]);
      return;
    }
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
    const parts = ahead.get(id) ?? [];
    ahead.delete(id);
    for (const part of parts) onWords({ id, part });
  }

  function settle(turn: LiveTurn): void {
    applyServerEvent((s) => ({ turns: withTurn(s.turns, turn.threadId, null) }));
    if (turn.text !== "" || turn.thinking !== "" || turn.tools.length > 0) keepStoppedWords(turn);
  }

  function keepQuestion(threadId: string, event: TurnFailure): void {
    const { question } = event;
    if (question === undefined) return;
    applyServerEvent((s) => s.messages[threadId]?.some((m) => m.id === question.id) === true ? { messages: withMessage(s, threadId, question) } : {});
  }

  function keepStopped(threadId: string, event: TurnFailure): void {
    const { partial } = event;
    if (partial === undefined) return keepQuestion(threadId, event);
    noteMessage(threadId, partial);
    applyServerEvent((s) => (s.messages[threadId] !== undefined ? { messages: withMessage(s, threadId, partial) } : {}));
  }

  function sendQueuedNow(id: string): void {
    const s = getState();
    const q = waitingReplies(s).find((x) => x.id === id);
    if (!q || behindSetup(q)) return;
    if (unfinished(s.turns[q.threadId])) return queueNow(id, stopOthersOk());
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
