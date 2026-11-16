// The server's record of every message: the ones waiting, the ones on their way, and the ones
// that left, so a late call is told where its message went. Each is one record in one stage
// (reply.ts), and `move` is the only thing here that changes a stage: this file keeps the
// records, applies what `move` says (also to the other messages of the same chat), numbers each
// change, keeps the waiting ones in a file, and makes the shapes every window is sent. It starts
// nothing itself: the pump (app/queue-pump.ts) asks it which message goes next.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import { QueuedMessage, type Message, type Params, type Reply, type ReplyAnswer, type ReplyChange, type ReplyListed, type ReplyRecord, type ReplyStage, type StopConsent, type WaitFor } from "@gates-local/contracts";
import {
  SOUND, fromQueued, heardAs, isAsked, isEnded, isInFlight, isLive, isWaiting, move, shownStage, stillStarting, toQueued,
  type Ahead, type Back, type Drawing, type End, type Ended, type Heard, type InFlight, type Input, type Live, type Moved, type Queued, type Rec, type Refusal, type Rules, type Stopping, type Waiting, type Words,
} from "./reply.ts";

export type Entry = QueuedMessage;
/** The older queue.update: every part of a waiting message a window could change, in one call. */
export type QueuePatch = Omit<Params<"queue.update">, "id">;

/** What the server has now, for the next start. */
export interface Ready {
  /** Ollama is ready and a chat model is installed: a chat message can go (a picture needs neither). */
  readonly chat: boolean;
  /** Some start or reply is running, in any chat. */
  readonly anyWork: boolean;
  /** A start or a reply is running in this chat, or one is still giving back what it took. */
  readonly busy: (threadId: string) => boolean;
}

/** The message the picker chose: its words, and whether it goes by Send now. */
export interface Picked {
  readonly id: string;
  readonly threadId: string;
  readonly words: Words;
  readonly now: boolean;
  readonly consent?: StopConsent;
}

export interface RepliesDeps {
  /** Where the waiting messages are kept; none keeps them in memory only (tests, a server with no data folder). */
  readonly file?: string | undefined;
  readonly log: (line: string) => void;
  /** The list every window shows, after it changed. */
  readonly changed: (list: readonly Entry[]) => void;
  readonly told: (change: ReplyChange) => void;
  /** The saved message with this id. */
  readonly saved: (messageId: string) => Message | undefined;
  /** This chat's delete is running. */
  readonly deleting: (threadId: string) => boolean;
  /** The app is closing. */
  readonly closing: () => boolean;
  /** Cuts the work of a turn, at `at`. Called after the record has moved. */
  readonly cut: (turnId: string, at: number) => void;
  /** The times of the reply a turn's work is writing. */
  readonly clock: (turnId: string, now: number) => ReplyRecord | undefined;
  /** Only a test passes these (reply.ts Rules). */
  readonly rules?: Rules;
}

export interface Replies {
  list(): readonly Entry[];
  records(): readonly ReplyListed[];
  /** A window's message, to wait its turn. "removed" for an id removed before, which never comes back. */
  add(entry: Entry): "ok" | "removed";
  /** A message a window sent itself (chat.send), taken at once for `turnId`: the window keeps its words. */
  direct(turnId: string, threadId: string, words: Words, retry: boolean, at: number): void;
  /** The older queue.update. Undefined when there is no such waiting message; "sending" when it is on its way. */
  update(id: string, patch: QueuePatch, by: number): "ok" | "sending" | undefined;
  /** The edit a window had open is over: with `by`, only if the edit is still that window's. */
  release(id: string, by?: number): void;
  change(params: Params<"reply.change">, by: number): ReplyAnswer;
  edit(params: Params<"reply.edit">, by: number): ReplyAnswer;
  remove(params: Params<"reply.remove">): ReplyAnswer;
  now(params: Params<"reply.now">): ReplyAnswer;
  hold(params: Params<"reply.hold">): ReplyAnswer;
  /** `id`: a message's, or a turn's. */
  stop(params: Params<"reply.stop">, at?: number): ReplyAnswer;

  /** The message to start now, if any. */
  pick(ready: Ready): Picked | undefined;
  /**
   * The picker took it for `turnId`. Which start of the message this is; none when it could not be
   * taken. The windows' list shows it as it was until `begun`: a start refused before any work
   * began is shown only as the refusal.
   */
  take(id: string, turnId: string, at: number): number | undefined;
  /** The start the picker took was answered with work under way: the windows' list shows the message on its way. */
  begun(turnId: string): void;
  /** A question with this id is in its chat: a message still waiting with it was asked. */
  sent(messageId: string): void;
  /** Whether the work of this start may still write: its record is starting, for this start. */
  starting(turnId: string, attempt: number): boolean;
  /** Its model is loading before its start. True when the record changed. */
  loading(turnId: string): boolean;
  /** Its question was saved, in this same step. False when the record had moved on. Told to the windows at `notify`. */
  started(turnId: string, attempt: number, question: Message, model: string, how: { readonly cold: boolean; readonly drawing: boolean }): boolean;
  /** Its start was refused, or cut before anything was saved. Told to the windows at `notify`. */
  refused(turnId: string, attempt: number, why: Refusal): void;
  /** The turn's stream sent this. The stage its record now shows; none when the record is not being written. */
  heard(turnId: string, heard: Heard): ReplyStage | undefined;
  /** The reply failed and runs once more. The stage its record now shows. */
  retrying(turnId: string): ReplyStage | undefined;
  /** The reply ended. `saved`: the rows its end wrote to the chat. Told to the windows at `notify`, after its last event. */
  ended(turnId: string, end: End, at: number, saved?: readonly Message[]): void;
  clocked(turnId: string): void;
  /** The work of this turn has given back everything it took. */
  left(turnId: string): void;
  /** When the work of this turn was cut by a Stop, if it was. */
  stoppedAt(turnId: string): number | undefined;
  /** The record this turn's work is for, while it is on its way. */
  of(turnId: string): InFlight | undefined;
  /** The saved question this turn's reply answers, until the reply has ended. */
  question(turnId: string): Message | undefined;
  /** This chat was deleted. */
  dropThread(threadId: string): void;
  /** The windows hear of every change so far. Called after the chat event that says the same thing. */
  notify(): void;
}

const decodeEntry = S.decodeUnknownResult(QueuedMessage);
/** Removed ids are remembered at most; the oldest go first. */
const REMOVED_KEPT = 1000;
/** Ended messages are remembered at most; the oldest go first. Bounded by count, never by time. */
const ENDED_KEPT = 1000;

/** A record that is on the list every window shows. */
const listed = (r: Rec | undefined): boolean => r !== undefined && (isWaiting(r) || r.stage === "starting") && !r.direct;

function wireBack(back: Back): Extract<Reply, { stage: "editing" }>["back"] {
  if (back.stage === "queued") return { stage: "queued" };
  if (back.stage === "held") return { stage: "held", held: back.why };
  return { stage: "next", ...(back.consent === undefined ? {} : { consent: back.consent }) };
}

/** The waiting stage a message is in, or returns to when its edit ends; none for one on hold. */
function goes(r: Rec, rules: Rules): "next" | "queued" | "retry" | undefined {
  if (!isWaiting(r) || r.direct) return undefined;
  // the broken variant takes a message open in a composer, from the stage it would return to
  const at = r.stage === "editing" ? (rules.pickSkipsEditing ? undefined : r.back) : r;
  if (at === undefined || at.stage === "held") return undefined;
  if (at.stage === "next") return "next";
  return at.waitFor === "retry" ? "retry" : "queued";
}

/** A waiting message as the picker hands it over. */
function picked(r: Waiting): Picked {
  const at = r.stage === "editing" ? r.back : r;
  const consent = at.stage === "next" ? at.consent : undefined;
  return { id: r.id, threadId: r.threadId, words: r.words, now: at.stage === "next", ...(consent === undefined ? {} : { consent }) };
}

/** What a closed app left: its waiting messages as it wrote them, and the ids removed from it. */
function read(file: string, log: (line: string) => void): { entries: Entry[]; removed: [string, string][] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as { code?: unknown }).code !== "ENOENT") log(`queue not read: ${(e as Error).message}`);
    return { entries: [], removed: [] };
  }
  const gone = typeof raw === "object" && raw !== null && Array.isArray((raw as { removed?: unknown }).removed) ? (raw as { removed: unknown[] }).removed : [];
  const removed = gone.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string");
  const list = typeof raw === "object" && raw !== null && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : [];
  const entries: Entry[] = [];
  for (const item of list) {
    const r = decodeEntry(item);
    if (Result.isFailure(r)) log("queue: an unreadable entry was left out");
    else entries.push(r.success);
  }
  return { entries, removed: removed.slice(-REMOVED_KEPT) };
}

const NO_ROWS: readonly Message[] = [];

// why: a waiting message found asked has nothing to show, so its end makes no record
function over(r: Ended, rows: readonly Message[]): Reply | undefined {
  const common = { id: r.id, threadId: r.threadId, rev: r.rev, at: r.at };
  if (r.stage === "failed") return { ...common, stage: "failed", code: r.code, message: r.message, ...(r.questionId === undefined ? {} : { questionId: r.questionId }) };
  if (r.questionId === undefined) return undefined;
  if (r.stage === "done") return r.replyId === undefined ? undefined : { ...common, stage: "done", questionId: r.questionId, replyId: r.replyId };
  const words = rows.find((m) => m.role === "assistant");
  return { ...common, stage: "stopped", questionId: r.questionId, by: r.by, ...(words === undefined ? {} : { replyId: words.id }) };
}

// why: the older chat.send keeps its own words, so no window lists its record
const keptBySender = (r: Rec): boolean => isWaiting(r) && r.direct;

const revOf = (c: ReplyChange): number => (c.kind === "is" ? c.reply.rev : c.rev);

export function createReplies({ file, log, changed, told, saved, deleting, closing, cut, clock, rules = SOUND }: RepliesDeps): Replies {
  /** Every record by its id, oldest first: a record keeps its place however it changes. */
  const recs = new Map<string, Rec>();
  /** The record each turn was started for: a call may name a message by its turn. */
  const byTurn = new Map<string, string>();
  /** Removed and ended records, oldest first, so the oldest can be forgotten. */
  const removedIds = new Set<string>();
  const endedIds = new Set<string>();
  /** When each turn's work was cut by a Stop, until the work has left. */
  const cuts = new Map<string, number>();
  /** Works to cut once the windows have heard of the change that cuts them. */
  const toCut: { readonly turnId: string; readonly at: number }[] = [];
  /** Taken messages whose start is not answered yet, by record id: the row the windows' list still shows for each. */
  const untold = new Map<string, { readonly turnId: string; readonly row: Entry | undefined }>();
  let counter = 0;
  /** The list changed since the windows last heard. */
  let dirty = false;
  const pending = new Map<string, { readonly last: Rec; readonly saved: readonly Message[] }>();
  // why: a clock that a cut stops is told once every cut of the step is done
  let cutting = false;

  const forget = (id: string) => {
    recs.delete(id);
    untold.delete(id);
    removedIds.delete(id);
    endedIds.delete(id);
    for (const [turnId, of] of byTurn) if (of === id) byTurn.delete(turnId);
  };
  const bound = (ids: Set<string>, kept: number) => {
    for (const old of ids) {
      if (ids.size <= kept) break;
      forget(old);
    }
  };

  /** The record as `move` made it, numbered and kept. */
  function commit(prev: Rec | undefined, next: Rec | undefined): Rec | undefined {
    if (next === undefined || next === prev) return prev;
    const rec: Rec = { ...next, rev: ++counter };
    recs.set(rec.id, rec);
    pending.set(rec.id, { last: rec, saved: pending.get(rec.id)?.saved ?? NO_ROWS });
    // a start that is over, however it ended, is shown as the record says
    const taken = untold.get(rec.id);
    if (taken !== undefined && !(rec.stage === "starting" && rec.turnId === taken.turnId)) untold.delete(rec.id);
    if (listed(prev) || listed(rec) || rec.stage === "removed") dirty = true;
    if (isInFlight(rec)) byTurn.set(rec.turnId, rec.id);
    else if (rec.stage === "removed" && rec.why === "removed") {
      // the broken variant: a removed message is forgotten, so a window that missed the removal queues it again
      if (!rules.removalIsRemembered) forget(rec.id);
      else {
        removedIds.add(rec.id);
        bound(removedIds, REMOVED_KEPT);
      }
    } else if (!isWaiting(rec)) {
      endedIds.add(rec.id);
      bound(endedIds, ENDED_KEPT);
    }
    return recs.get(rec.id);
  }

  const inChat = (threadId: string): Rec[] => [...recs.values()].filter((r) => r.threadId === threadId);
  /** The message on its way in a chat, other than `not`. */
  const going = (threadId: string, not?: string): InFlight | undefined => inChat(threadId).find((r): r is InFlight => isInFlight(r) && r.id !== not);
  const ofTurn = (turnId: string): Rec | undefined => {
    const id = byTurn.get(turnId);
    return id === undefined ? undefined : recs.get(id);
  };
  const cutLater = (c: Moved["cut"]) => {
    if (c !== undefined) toCut.push({ turnId: c.turnId, at: c.at ?? Date.now() });
  };
  /** What the reply before them did, said to the other messages of a chat. */
  const tell = (threadId: string, what: Ahead, not?: string) => {
    for (const other of inChat(threadId)) {
      if (other.id === not) continue;
      const m = move(other, { event: "ahead", what }, rules);
      commit(other, m.next);
      cutLater(m.cut);
    }
  };

  /** One step for one record, and what it means for the rest of its chat. */
  function apply(rec: Rec | undefined, input: Input): Moved {
    const m = move(rec, input, rules);
    const next = commit(rec, m.next);
    cutLater(m.cut);
    const at = next ?? m.next;
    if (at === undefined) return m;
    if (m.ahead !== undefined) tell(at.threadId, m.ahead, at.id);
    if (m.stopChat === true) {
      // the reply on its way in its chat stops in this same call: no window sends a Stop after it
      const reply = going(at.threadId, at.id);
      if (reply !== undefined) apply(reply, { call: "stop", at: Date.now() });
    }
    return { ...m, next };
  }

  const list = (): Entry[] => {
    const rows: Entry[] = [];
    for (const r of recs.values()) {
      const taken = untold.get(r.id);
      const row = taken === undefined ? toQueued(r) : taken.row;
      if (row !== undefined) rows.push(row);
    }
    return rows;
  };
  let pushed = "";
  let written: string | undefined;
  function flush(): void {
    keep();
    tellWindows();
  }
  function keep(): void {
    if (!dirty) return;
    dirty = false;
    const rows = list();
    const entries = JSON.stringify(rows);
    const removed = JSON.stringify([...removedIds].map((id) => [id, recs.get(id)?.threadId ?? ""]));
    const text = `{"version":1,"entries":${entries},"removed":${removed}}`;
    if (file !== undefined && text !== written) {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, text);
        renameSync(tmp, file);
        written = text;
      } catch (e) {
        log(`queue not saved: ${(e as Error).message}`);
      }
    }
    if (entries === pushed) return;
    pushed = entries;
    changed(rows);
  }
  /**
   * After a step: the windows hear, then the works it cut are cut. `quiet`: the chat event that
   * says the same thing has not gone out yet, and the windows hear at `notify`, after it.
   */
  function settle(quiet = false): void {
    if (!quiet) flush();
    if (toCut.length === 0) return;
    cutting = true;
    try {
      for (let c = toCut.shift(); c !== undefined; c = toCut.shift()) {
        if (!cuts.has(c.turnId)) cuts.set(c.turnId, c.at);
        cut(c.turnId, c.at);
      }
    } finally {
      cutting = false;
    }
    // why: the cuts stopped clocks, and the windows hear the times
    if (!quiet) flush();
  }

  function waitFor(r: Queued): WaitFor | undefined {
    if (r.behind === "setup") return { what: "setup" };
    if (r.behind === "download") return { what: "download", ...(r.words.model === undefined ? {} : { model: r.words.model }) };
    const reply = going(r.threadId, r.id);
    return reply === undefined ? undefined : { what: r.waitFor === "retry" ? "retry" : "reply", reply: reply.turnId };
  }

  /** A reply whose question is saved, with its times from its work's clock. `id`: the one the caller asked with. */
  function flying(r: Live | Drawing | Stopping, id: string): Reply | undefined {
    const c = clock(r.turnId, Date.now());
    if (c === undefined) return undefined;
    const common = { id, threadId: r.threadId, rev: r.rev };
    // an Image turn runs no chat model: its pictures are the image module's jobs, which it lists itself
    if (r.stage === "drawing" || (r.stage === "stopping" && r.drawing)) return { ...common, stage: "drawing", questionId: r.question.id, preset: r.model, startedAt: c.startedAt, jobs: [], ...(r.stage === "stopping" ? { stoppedAt: r.stoppedAt } : {}) };
    const times = {
      questionId: r.question.id, model: r.model, startedAt: c.startedAt, workMs: c.workMs, toolMs: c.toolMs, try: r.try, spans: c.spans, callsAt: c.callsAt,
      ...(c.readyAt === undefined ? {} : { readyAt: c.readyAt }),
      ...(c.firstTokenAt === undefined ? {} : { firstTokenAt: c.firstTokenAt }),
    };
    if (r.stage === "stopping") return { ...common, ...times, stage: "stopping", stoppedAt: r.stoppedAt };
    return { ...common, ...times, stage: r.stage, ...(r.stage === "thinking" && !r.heard ? { silent: true as const } : {}) };
  }

  /** The record as the reply calls answer with it; none for one that has ended. */
  function wire(r: Rec, askedId: string): Reply | undefined {
    if (isAsked(r)) return flying(r, askedId);
    if (!(isWaiting(r) || r.stage === "starting")) return undefined;
    const words = { id: r.id, threadId: r.threadId, rev: r.rev, ...r.words };
    if (r.stage === "starting") return { ...words, stage: "starting", attempt: r.attempt, startedAt: r.startedAt, ...(r.loading ? { loading: true as const } : {}) };
    if (r.stage === "editing") return { ...words, stage: "editing", by: String(r.by), back: wireBack(r.back) };
    if (r.stage === "held") return { ...words, stage: "held", held: r.why };
    if (r.stage === "next") return { ...words, stage: "next", ...(r.consent === undefined ? {} : { consent: r.consent }) };
    const wait = waitFor(r);
    return { ...words, stage: "queued", ...(wait === undefined ? {} : { waitFor: wait }) };
  }

  function changeOf(r: Rec, rows: readonly Message[]): ReplyChange | undefined {
    const left = (why: "removed" | "chat-deleted" | "settled"): ReplyChange => ({ kind: "left", id: r.id, threadId: r.threadId, rev: r.rev, why });
    if (r.stage === "removed") return left(r.why);
    if (keptBySender(r)) return left("settled");
    const reply = isEnded(r) ? over(r, rows) : wire(r, r.id);
    if (reply === undefined) return isEnded(r) ? left("settled") : undefined;
    return { kind: "is", reply, ...(rows.length === 0 ? {} : { saved: rows }) };
  }

  function tellWindows(): void {
    if (pending.size === 0) return;
    const changes: ReplyChange[] = [];
    for (const [id, p] of pending) {
      if (untold.has(id)) continue;
      pending.delete(id);
      const change = changeOf(recs.get(id) ?? p.last, p.saved);
      if (change !== undefined) changes.push(change);
    }
    for (const c of changes.toSorted((a, b) => revOf(a) - revOf(b))) told(c);
  }
  const savedWith = (id: string, rows: readonly Message[]) => {
    const p = pending.get(id);
    if (p !== undefined && rows.length > 0) pending.set(id, { last: p.last, saved: [...p.saved, ...rows] });
  };

  const gone = (why: "sent" | "removed" | "chat-deleted" | "unknown", questionId?: string): ReplyAnswer => {
    const question = questionId === undefined ? undefined : saved(questionId);
    return { answer: "gone", why, ...(question === undefined ? {} : { question }) };
  };

  /** What the caller is told, with the record as it is once the step has settled. */
  function answered(m: Moved, askedId: string): ReplyAnswer {
    const a = m.answer;
    if (a === undefined) return gone("unknown");
    if (a.answer === "gone") return gone(a.why, a.questionId);
    const now = recs.get(a.record.id);
    // a remove is answered with the message as it was
    const reply = wire(now !== undefined && now.stage !== "removed" ? now : a.record, askedId);
    return reply === undefined ? gone("sent") : { answer: a.answer, reply };
  }

  /** One call on the message `id` names. */
  const called = (id: string, input: Input): ReplyAnswer => {
    const m = apply(recs.get(id), input);
    settle();
    return answered(m, id);
  };

  const waitingWith = (messageId: string, not?: string): Rec[] => [...recs.values()].filter((r) => isWaiting(r) && r.words.messageId === messageId && r.id !== not);

  if (file !== undefined) {
    const kept = read(file, log);
    for (const [id, threadId] of kept.removed) commit(undefined, { id, threadId, rev: 0, stage: "removed", why: "removed" });
    let asked = false;
    for (const q of kept.entries) {
      const rec = commit(undefined, fromQueued(q));
      // The app closed after a question was saved and before its row left the file: it was asked,
      // and it is not listed again. The broken variant lists it, on hold, beside its own question.
      const question = rules.restartReconciles ? saved(q.messageId) : undefined;
      if (question !== undefined && question.threadId === q.threadId && question.role === "user") {
        apply(rec, { event: "saved" });
        asked = true;
      // nothing else a closed app left goes on by itself
      } else apply(rec, { event: "restart", at: Date.now() });
    }
    toCut.length = 0;
    // the file is written again at the next change when a row was left out of it here
    dirty = asked;
    pushed = JSON.stringify(list());
  }
  // why: no window has connected yet: each reads the records with reply.list
  pending.clear();

  return {
    list,
    records() {
      const rows: ReplyListed[] = [];
      for (const r of recs.values()) {
        if (!(isWaiting(r) || isInFlight(r)) || keptBySender(r)) continue;
        const reply = wire(r, r.id);
        if (reply !== undefined) rows.push({ reply });
      }
      return rows;
    },
    add(entry) {
      const known = recs.get(entry.id) ?? [...recs.values()].find((r) => (isWaiting(r) || r.stage === "starting") && r.words.messageId === entry.messageId);
      const m = apply(known, {
        call: "send", record: fromQueued(entry), saved: saved(entry.messageId) !== undefined,
        // it waits its turn: the pump takes it
        chat: { deleting: deleting(entry.threadId), closing: closing(), busy: true },
      });
      settle();
      return m.answer?.answer === "gone" && m.answer.why === "removed" ? "removed" : "ok";
    },
    direct(turnId, threadId, words, retry, at) {
      const record: Queued = { id: turnId, threadId, rev: 0, words, behind: "reply", starts: 0, direct: true, stage: "queued", waitFor: "reply" };
      apply(undefined, {
        call: "send", record, saved: saved(words.messageId) !== undefined, start: { turnId, at, retry },
        chat: { deleting: deleting(threadId), closing: closing(), busy: false },
      });
      settle();
    },
    update(id, patch, by) {
      const rec = recs.get(id);
      if (rec === undefined || !(isWaiting(rec) || rec.stage === "starting")) return undefined;
      if (rec.stage === "starting") return "sending";
      const { editing, now, stopOthers, stopTurns, held, ...rest } = patch;
      const words = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<Words>;
      if (Object.keys(words).length > 0) apply(recs.get(id), { call: "change", base: rec.words.messageId, messageId: words.messageId ?? rec.words.messageId, words, by, baseSaved: false, older: true });
      if (editing !== undefined) apply(recs.get(id), { call: "edit", open: editing, by, older: true });
      // the person stopped the reply it waited behind; one going by Send now still goes
      const at = recs.get(id);
      if (held === true && at !== undefined && goes(at, { ...rules, pickSkipsEditing: false }) !== "next") apply(at, { call: "hold" });
      if (now === true) {
        const consent: StopConsent | undefined = stopOthers !== true ? undefined : stopTurns === undefined ? { kind: "standing" } : { kind: "named", replies: stopTurns };
        apply(recs.get(id), { call: "now", ...(consent === undefined ? {} : { consent }), stops: false });
      }
      settle();
      return "ok";
    },
    release(id, by) {
      const rec = recs.get(id);
      if (rec?.stage !== "editing" || (by !== undefined && rec.by !== by)) return;
      apply(rec, { call: "edit", open: false, by: rec.by, older: true });
      settle();
    },
    change({ id, base, messageId, ...words }, by) {
      return called(id, { call: "change", base, messageId, words, by, baseSaved: saved(base) !== undefined });
    },
    edit: ({ id, open }, by) => called(id, { call: "edit", open, by }),
    remove: ({ id }) => called(id, { call: "remove" }),
    now({ id, consent }) {
      const rec = recs.get(id);
      const stops = rec !== undefined && going(rec.threadId, id) !== undefined;
      return called(id, { call: "now", ...(consent === undefined ? {} : { consent }), stops });
    },
    hold: ({ id }) => called(id, { call: "hold" }),
    stop({ id }, at = Date.now()) {
      // by its own id, or by a turn taken for it
      const own = recs.get(id);
      const rec = own ?? ofTurn(id);
      if (own === undefined && isInFlight(rec) && rec.turnId !== id) {
        // The start it names is over and the message is on its way again. Stop still means stop
        // for its chat: a start not yet saved comes back, and what waits holds.
        if (rules.lateStopHolds) tell(rec.threadId, "late-stop");
        settle();
        return gone("sent");
      }
      const m = apply(rec, { call: "stop", at });
      settle();
      return answered(m, id);
    },

    pick({ chat, anyWork, busy }) {
      const can = (r: Waiting) => (r.words.draw !== undefined || chat) && !busy(r.threadId);
      // a Send now first: it waits only for its own chat
      for (const r of recs.values()) if (goes(r, rules) === "next" && isWaiting(r) && can(r)) return picked(r);
      // the rest go one reply at a time, each chat's in the order they were typed
      if (anyWork) return undefined;
      const looked = new Set<string>();
      for (const r of recs.values()) {
        const how = goes(r, rules);
        if (!isWaiting(r) || (how !== "queued" && how !== "retry") || looked.has(r.threadId)) continue;
        looked.add(r.threadId);
        // one that cannot go does not hold up another chat's that can
        if (how === "queued" && can(r)) return picked(r);
      }
      return undefined;
    },
    take(id, turnId, at) {
      const before = recs.get(id);
      const row = before === undefined ? undefined : toQueued(before);
      const m = apply(before, { event: "take", turnId, at });
      const attempt = m.next?.stage === "starting" && m.next.turnId === turnId ? m.next.attempt : undefined;
      if (attempt !== undefined) untold.set(id, { turnId, row });
      settle();
      return attempt;
    },
    begun(turnId) {
      const id = byTurn.get(turnId);
      if (id === undefined || untold.get(id)?.turnId !== turnId) return;
      untold.delete(id);
      dirty = true;
      settle();
    },
    sent(messageId) {
      for (const r of waitingWith(messageId)) apply(r, { event: "saved" });
      settle();
    },
    starting: (turnId, attempt) => stillStarting(ofTurn(turnId), turnId, attempt, rules),
    loading(turnId) {
      const rec = ofTurn(turnId);
      return apply(rec, { event: "load", turnId }).next !== rec;
    },
    started(turnId, attempt, question, model, { cold, drawing }) {
      const rec = ofTurn(turnId);
      const next = apply(rec, { event: "start", turnId, attempt, question, model, cold, drawing }).next;
      const ok = next !== rec && isAsked(next);
      if (ok) {
        savedWith(next.id, [question]);
        // why: a window's own copy of the same message has been asked too
        for (const r of waitingWith(question.id, next.id)) apply(r, { event: "saved" });
      }
      settle(true);
      return ok;
    },
    refused(turnId, attempt, why) {
      apply(ofTurn(turnId), { event: "refuse", turnId, attempt, why });
      settle(true);
    },
    heard(turnId, heard) {
      const rec = ofTurn(turnId);
      const e = heardAs(turnId, heard);
      if (!isLive(rec) || rec.turnId !== turnId || e === undefined) return undefined;
      const next = commit(rec, move(rec, e, rules).next);
      return isLive(next) ? shownStage(next) : undefined;
    },
    retrying(turnId) {
      const next = apply(ofTurn(turnId), { event: "retry", turnId }).next;
      settle();
      return isLive(next) && next.turnId === turnId ? shownStage(next) : undefined;
    },
    ended(turnId, end, at, rows = NO_ROWS) {
      const rec = ofTurn(turnId);
      const next = apply(rec, { event: "end", turnId, at, end }).next;
      if (next !== undefined && next !== rec) savedWith(next.id, rows);
      settle(true);
    },
    clocked(turnId) {
      const rec = ofTurn(turnId);
      // why: numbered again, so no window keeps the times it had for a newer change
      if (isAsked(rec) && rec.turnId === turnId && !pending.has(rec.id)) {
        const again: Rec = { ...rec, rev: ++counter };
        recs.set(rec.id, again);
        pending.set(rec.id, { last: again, saved: NO_ROWS });
      }
      if (!cutting) flush();
    },
    left(turnId) {
      const rec = ofTurn(turnId);
      // a record still on its way has lost its work without a word: that is said at once
      const lost = isInFlight(rec) && rec.turnId === turnId;
      apply(rec, { event: "left", turnId, at: Date.now() });
      cuts.delete(turnId);
      settle(!lost);
    },
    stoppedAt: (turnId) => cuts.get(turnId),
    of(turnId) {
      const rec = ofTurn(turnId);
      return isInFlight(rec) && rec.turnId === turnId ? rec : undefined;
    },
    question(turnId) {
      const rec = ofTurn(turnId);
      return isAsked(rec) && rec.turnId === turnId ? rec.question : undefined;
    },
    dropThread(threadId) {
      for (const r of inChat(threadId)) {
        // a removal in a chat that is gone needs no remembering
        if (r.stage === "removed" && r.why === "removed") {
          forget(r.id);
          dirty = true;
        } else apply(r, { event: "chat-deleted" });
      }
      settle();
    },
    notify: flush,
  };
}
