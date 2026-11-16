import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import type { Message, Params, Reply, ReplyAnswer, ReplyChange, ReplyListed, StopConsent, WaitFor } from "@gates-local/contracts";
import {
  SOUND, fromQueued, heardAs, isAsked, isEnded, isInFlight, isLive, isWaiting, move, shownStage, stillStarting, toQueued,
  type Ahead, type Back, type Behind, type Drawing, type End, type Ended, type Heard, type Held, type InFlight, type Input, type Live, type Moved, type Next, type Queued, type Rec, type Refusal, type Rules, type Stopping, type Waiting, type Words,
} from "./reply.ts";
import { SavedEntry } from "./queue-file.ts";
import type { ReplyRecord, ReplyStage } from "./times.ts";

export type Entry = SavedEntry;

export interface Ready {
  readonly chat: boolean;
  readonly anyWork: boolean;
  readonly busy: (threadId: string) => boolean;
}

export interface Picked {
  readonly id: string;
  readonly threadId: string;
  readonly words: Words;
  readonly now: boolean;
  readonly consent?: StopConsent;
}

export interface SendNow {
  readonly at: number;
  readonly behind: Behind;
  // why: busy also while an ended start still gives back what it took
  readonly busy: boolean;
  readonly turnId: string;
}

export type Sent =
  | { readonly kind: "answer"; readonly answer: ReplyAnswer }
  // why: windows hear nothing of a start until `begun`, or only the refusal if refused first
  | { readonly kind: "start"; readonly attempt: number; readonly picked: Picked; readonly answer: () => ReplyAnswer }
  // why: a Retry never waits, so one that would have to is refused and makes no record
  | { readonly kind: "cannot" };

export interface RepliesDeps {
  readonly file?: string | undefined;
  readonly log: (line: string) => void;
  readonly told: (change: ReplyChange) => void;
  readonly saved: (messageId: string) => Message | undefined;
  readonly deleting: (threadId: string) => boolean;
  readonly closing: () => boolean;
  readonly cut: (turnId: string, at: number) => void;
  readonly clock: (turnId: string, now: number) => ReplyRecord | undefined;
  readonly rules?: Rules;
}

export interface Replies {
  list(): readonly Entry[];
  records(): readonly ReplyListed[];
  // why: the same send again is answered as the message now is, never taken twice
  send(params: Params<"reply.send">, now: SendNow): Sent;
  windowGone(by: number): void;
  change(params: Params<"reply.change">, by: number): ReplyAnswer;
  edit(params: Params<"reply.edit">, by: number): ReplyAnswer;
  remove(params: Params<"reply.remove">): ReplyAnswer;
  now(params: Params<"reply.now">): ReplyAnswer;
  hold(params: Params<"reply.hold">): ReplyAnswer;
  stop(params: Params<"reply.stop">, at?: number): ReplyAnswer;

  pick(ready: Ready): Picked | undefined;
  take(id: string, turnId: string, at: number): number | undefined;
  begun(turnId: string): void;
  sent(messageId: string): void;
  starting(turnId: string, attempt: number): boolean;
  loading(turnId: string): boolean;
  started(turnId: string, attempt: number, question: Message, model: string, how: { readonly cold: boolean; readonly drawing: boolean; readonly jobs?: readonly string[]; readonly chat?: number }): boolean;
  refused(turnId: string, attempt: number, why: Refusal): void;
  heard(turnId: string, heard: Heard): ReplyStage | undefined;
  retrying(turnId: string): ReplyStage | undefined;
  ended(turnId: string, end: End, at: number, saved?: readonly Message[], chat?: number): void;
  clocked(turnId: string): void;
  left(turnId: string): void;
  stoppedAt(turnId: string): number | undefined;
  of(turnId: string): InFlight | undefined;
  question(turnId: string): Message | undefined;
  dropThread(threadId: string): void;
  notify(): void;
}

const decodeEntry = S.decodeUnknownResult(SavedEntry);
const REMOVED_KEPT = 1000;
const ENDED_KEPT = 1000;

const listed = (r: Rec | undefined): boolean => r !== undefined && (isWaiting(r) || r.stage === "starting") && !r.direct;

function wireBack(back: Back): Extract<Reply, { stage: "editing" }>["back"] {
  if (back.stage === "queued") return { stage: "queued" };
  if (back.stage === "held") return { stage: "held", held: back.why };
  return { stage: "next", ...(back.consent === undefined ? {} : { consent: back.consent }) };
}

function goes(r: Rec, rules: Rules): "next" | "queued" | "retry" | undefined {
  if (!isWaiting(r) || r.direct) return undefined;
  const at = r.stage === "editing" ? (rules.pickSkipsEditing ? undefined : r.back) : r;
  if (at === undefined || at.stage === "held") return undefined;
  if (at.stage === "next") return "next";
  return at.waitFor === "retry" ? "retry" : "queued";
}

function picked(r: Waiting): Picked {
  const at = r.stage === "editing" ? r.back : r;
  const consent = at.stage === "next" ? at.consent : undefined;
  return { id: r.id, threadId: r.threadId, words: r.words, now: at.stage === "next", ...(consent === undefined ? {} : { consent }) };
}

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

// why: a Retry's question is in the chat already, so no window lists its record
const keptBySender = (r: Rec): boolean => isWaiting(r) && r.direct;

const revOf = (c: ReplyChange): number => (c.kind === "is" ? c.reply.rev : c.rev);

export function createReplies({ file, log, told, saved, deleting, closing, cut, clock, rules = SOUND }: RepliesDeps): Replies {
  const recs = new Map<string, Rec>();
  const byTurn = new Map<string, string>();
  const removedIds = new Set<string>();
  const endedIds = new Set<string>();
  const cuts = new Map<string, number>();
  const toCut: { readonly turnId: string; readonly at: number }[] = [];
  const untold = new Map<string, { readonly turnId: string; readonly row: Entry | undefined }>();
  let counter = 0;
  let dirty = false;
  const pending = new Map<string, { readonly last: Rec; readonly saved: readonly Message[]; readonly chat?: number }>();
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

  function commit(prev: Rec | undefined, next: Rec | undefined): Rec | undefined {
    if (next === undefined || next === prev) return prev;
    const rec: Rec = { ...next, rev: ++counter };
    recs.set(rec.id, rec);
    const was = pending.get(rec.id);
    pending.set(rec.id, { last: rec, saved: was?.saved ?? NO_ROWS, ...(was?.chat === undefined ? {} : { chat: was.chat }) });
    const taken = untold.get(rec.id);
    if (taken !== undefined && !(rec.stage === "starting" && rec.turnId === taken.turnId)) untold.delete(rec.id);
    if (listed(prev) || listed(rec) || rec.stage === "removed") dirty = true;
    if (isInFlight(rec)) byTurn.set(rec.turnId, rec.id);
    else if (rec.stage === "removed" && rec.why === "removed") {
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
  const going = (threadId: string, not?: string): InFlight | undefined => inChat(threadId).find((r): r is InFlight => isInFlight(r) && r.id !== not);
  const ofTurn = (turnId: string): Rec | undefined => {
    const id = byTurn.get(turnId);
    return id === undefined ? undefined : recs.get(id);
  };
  const cutLater = (c: Moved["cut"]) => {
    if (c !== undefined) toCut.push({ turnId: c.turnId, at: c.at ?? Date.now() });
  };
  const tell = (threadId: string, what: Ahead, not?: string) => {
    for (const other of inChat(threadId)) {
      if (other.id === not) continue;
      const m = move(other, { event: "ahead", what }, rules);
      commit(other, m.next);
      cutLater(m.cut);
    }
  };

  function apply(rec: Rec | undefined, input: Input): Moved {
    const m = move(rec, input, rules);
    const next = commit(rec, m.next);
    cutLater(m.cut);
    const at = next ?? m.next;
    if (at === undefined) return m;
    if (m.ahead !== undefined) tell(at.threadId, m.ahead, at.id);
    if (m.stopChat === true) {
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
  }
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
    return reply === undefined ? undefined : { what: r.waitFor === "retry" ? "retry" : "reply", reply: reply.id };
  }

  function flying(r: Live | Drawing | Stopping, id: string): Reply | undefined {
    const c = clock(r.turnId, Date.now());
    if (c === undefined) return undefined;
    const common = { id, threadId: r.threadId, rev: r.rev };
    if (r.stage === "drawing" || (r.stage === "stopping" && r.drawing)) return { ...common, stage: "drawing", questionId: r.question.id, preset: r.model, startedAt: c.startedAt, jobs: r.jobs ?? [], ...(r.stage === "stopping" ? { stoppedAt: r.stoppedAt } : {}) };
    const times = {
      questionId: r.question.id, model: r.model, startedAt: c.startedAt, workMs: c.workMs, toolMs: c.toolMs, try: r.try, spans: c.spans, callsAt: c.callsAt,
      ...(c.readyAt === undefined ? {} : { readyAt: c.readyAt }),
      ...(c.firstTokenAt === undefined ? {} : { firstTokenAt: c.firstTokenAt }),
    };
    if (r.stage === "stopping") return { ...common, ...times, stage: "stopping", stoppedAt: r.stoppedAt };
    return { ...common, ...times, stage: r.stage, ...(r.stage === "thinking" && !r.heard ? { silent: true as const } : {}) };
  }

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

  function changeOf(r: Rec, rows: readonly Message[], chat: number | undefined): ReplyChange | undefined {
    const left = (why: "removed" | "chat-deleted" | "settled"): ReplyChange => ({ kind: "left", id: r.id, threadId: r.threadId, rev: r.rev, why });
    if (r.stage === "removed") return left(r.why);
    if (keptBySender(r)) return left("settled");
    const reply = isEnded(r) ? over(r, rows) : wire(r, r.id);
    if (reply === undefined) return isEnded(r) ? left("settled") : undefined;
    return { kind: "is", reply, ...(rows.length === 0 ? {} : { saved: rows, ...(chat === undefined ? {} : { chatNumber: chat }) }) };
  }

  function tellWindows(): void {
    if (pending.size === 0) return;
    const changes: ReplyChange[] = [];
    for (const [id, p] of pending) {
      if (untold.has(id)) continue;
      pending.delete(id);
      const change = changeOf(recs.get(id) ?? p.last, p.saved, p.chat);
      if (change !== undefined) changes.push(change);
    }
    for (const c of changes.toSorted((a, b) => revOf(a) - revOf(b))) told(c);
  }
  // why: rows saved without the chat's number leave the change with none, so every window reads
  const savedWith = (id: string, rows: readonly Message[], chat: number | undefined) => {
    const p = pending.get(id);
    if (p !== undefined && rows.length > 0) pending.set(id, { last: p.last, saved: [...p.saved, ...rows], ...(chat === undefined ? {} : { chat }) });
  };

  const gone = (why: "sent" | "removed" | "chat-deleted" | "unknown", questionId?: string): ReplyAnswer => {
    const question = questionId === undefined ? undefined : saved(questionId);
    return { answer: "gone", why, ...(question === undefined ? {} : { question }) };
  };

  function answered(m: Moved, askedId: string): ReplyAnswer {
    const a = m.answer;
    if (a === undefined) return gone("unknown");
    if (a.answer === "gone") return gone(a.why, a.questionId);
    const now = recs.get(a.record.id);
    const reply = wire(now !== undefined && now.stage !== "removed" ? now : a.record, askedId);
    return reply === undefined ? gone("sent") : { answer: a.answer, reply };
  }

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
      const question = rules.restartReconciles ? saved(q.messageId) : undefined;
      if (question !== undefined && question.threadId === q.threadId && question.role === "user") {
        apply(rec, { event: "saved" });
        asked = true;
      } else apply(rec, { event: "restart", at: Date.now() });
    }
    toCut.length = 0;
    dirty = asked;
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
    send({ id, threadId, askFirst, consent, held, ...said }, { at, behind, busy, turnId }) {
      const retry = said.retryOf !== undefined;
      const known = recs.get(id) ?? [...recs.values()].find((r) => (isWaiting(r) || r.stage === "starting") && r.words.messageId === said.messageId);
      // why: behind what already waits in its chat, so the order they were typed in is kept
      const waits = behind !== "reply" || busy || going(threadId) !== undefined
        || inChat(threadId).some((r) => goes(r, { ...rules, pickSkipsEditing: false }) !== undefined);
      if (known === undefined && retry && (waits || closing())) return { kind: "cannot" };
      const starts = known === undefined && !waits && held === undefined;
      const part = { id, threadId, rev: 0, words: { ...said, at }, behind, starts: 0, direct: retry };
      // why: a person waits on a send that starts now, so it goes as Send now does, with its yes
      const record: Queued | Held | Next = held === true ? { ...part, stage: "held", why: { why: "stopped" } }
        : starts && (askFirst === true || consent !== undefined)
          ? { ...part, stage: "next", ...(consent === undefined ? {} : { consent }) }
          : { ...part, stage: "queued", waitFor: behind };
      const m = apply(known, {
        call: "send", record, saved: saved(said.messageId) !== undefined,
        chat: { deleting: deleting(threadId), closing: closing(), busy: waits },
        ...(starts ? { start: { turnId, at, retry } } : {}),
      });
      const taken = m.next;
      if (known !== undefined || taken?.stage !== "starting" || taken.turnId !== turnId) {
        settle();
        return { kind: "answer", answer: answered(m, id) };
      }
      untold.set(id, { turnId, row: undefined });
      settle();
      const { attempt, words, now } = taken;
      return { kind: "start", attempt, picked: { id, threadId, words, now, ...(taken.consent === undefined ? {} : { consent: taken.consent }) }, answer: () => answered(m, id) };
    },
    windowGone(by) {
      for (const rec of recs.values()) if (rec.stage === "editing" && rec.by === by) apply(rec, { call: "edit", open: false, by });
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
      const own = recs.get(id);
      const rec = own ?? ofTurn(id);
      if (own === undefined && isInFlight(rec) && rec.turnId !== id) {
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
      for (const r of recs.values()) if (goes(r, rules) === "next" && isWaiting(r) && can(r)) return picked(r);
      if (anyWork) return undefined;
      const looked = new Set<string>();
      for (const r of recs.values()) {
        const how = goes(r, rules);
        if (!isWaiting(r) || (how !== "queued" && how !== "retry") || looked.has(r.threadId)) continue;
        looked.add(r.threadId);
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
    started(turnId, attempt, question, model, { cold, drawing, jobs, chat }) {
      const rec = ofTurn(turnId);
      const next = apply(rec, { event: "start", turnId, attempt, question, model, cold, drawing, ...(jobs === undefined ? {} : { jobs }) }).next;
      const ok = next !== rec && isAsked(next);
      if (ok) {
        savedWith(next.id, [question], chat);
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
    ended(turnId, end, at, rows = NO_ROWS, chat) {
      const rec = ofTurn(turnId);
      const next = apply(rec, { event: "end", turnId, at, end }).next;
      if (next !== undefined && next !== rec) savedWith(next.id, rows, chat);
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
