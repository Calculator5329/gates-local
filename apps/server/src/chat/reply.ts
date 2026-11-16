// One record for each message, from the moment the server first hears of it until its reply
// has ended. A record is always in exactly one stage and each stage carries only its own data,
// so a message that is both on hold and on its way cannot be written down. `move` is the only
// place a stage changes: it takes the record and one call or one server event and gives back
// the answer and the record as it now is. It reads no clock, no file and no other record; what
// it needs to know of the rest of the app comes in with the call. The store (replies.ts) keeps
// the records and applies what `move` says, also to the other messages of the same chat.
import type { HeldWhy, Message, ReplyStage, StopConsent } from "@gates-local/contracts";
import type { SavedEntry } from "./queue-file.ts";

/** What a message was typed behind, as the window that typed it said. */
export type Behind = SavedEntry["waitFor"];
/** What a queued message waits for: what it was typed behind, or the reply before it running once more. */
export type Waits = Behind | "retry";
/**
 * The message itself, carried until its question is saved. `tools` and `retryOf` come only with
 * reply.send: the older queue row has no place for them.
 */
export type Words = Pick<SavedEntry, "messageId" | "text" | "at" | "images" | "files" | "model" | "numCtx" | "think" | "draw" | "drawCount">
  & { readonly tools?: boolean; readonly retryOf?: string };

interface Common {
  readonly id: string;
  readonly threadId: string;
  /** The number of the change that made the record what it is. The store gives it. */
  readonly rev: number;
}
/** A message whose question is not saved yet. */
interface Unsaved extends Common {
  readonly words: Words;
  readonly behind: Behind;
  /** How many times a start was taken for it. */
  readonly starts: number;
  /** A Retry, whose question is in the chat already: it never waits in the queue and no row is listed for it. */
  readonly direct: boolean;
}
export interface Queued extends Unsaved { readonly stage: "queued"; readonly waitFor: Waits }
export interface Held extends Unsaved { readonly stage: "held"; readonly why: HeldWhy }
export interface Next extends Unsaved { readonly stage: "next"; readonly consent?: StopConsent }
/** Where a message returns when its edit ends. */
export type Back =
  | { readonly stage: "queued"; readonly waitFor: Waits }
  | { readonly stage: "held"; readonly why: HeldWhy }
  | { readonly stage: "next"; readonly consent?: StopConsent };
export interface Editing extends Unsaved { readonly stage: "editing"; readonly by: number; readonly back: Back }
/** Taken: its start work runs and nothing of it is saved. */
export interface Starting extends Unsaved {
  readonly stage: "starting";
  readonly turnId: string;
  /** Which start this is: the work for an older one finds the record has moved on. */
  readonly attempt: number;
  readonly startedAt: number;
  /** It went by Send now, with the yes it had. */
  readonly now: boolean;
  readonly consent?: StopConsent;
  /** It waits behind a load of its own model. */
  readonly loading: boolean;
  /** A Retry of a question already in the chat: refused, it has no place to go back to. */
  readonly retry: boolean;
}
/** A reply whose question is saved. */
interface Asked extends Common {
  readonly turnId: string;
  readonly question: Message;
  readonly model: string;
  /** 1, then 2 while a failed reply runs once more. */
  readonly try: number;
}
export interface Live extends Asked {
  readonly stage: "loading" | "thinking" | "tool" | "writing";
  /** The calls running now. */
  readonly calls: readonly string[];
  /** The runtime has sent something for this try. */
  readonly heard: boolean;
}
export interface Drawing extends Asked { readonly stage: "drawing"; readonly jobs: readonly string[] }
export interface Stopping extends Asked { readonly stage: "stopping"; readonly stoppedAt: number; readonly drawing: boolean; readonly jobs?: readonly string[] }
export type StoppedBy = { readonly who: "person" } | { readonly who: "preempted"; readonly neededBy?: string } | { readonly who: "runtime" } | { readonly who: "closing" };
interface Over extends Common { readonly at: number; readonly turnId?: string; readonly questionId?: string }
export interface Done extends Over { readonly stage: "done"; readonly replyId?: string }
export interface Stopped extends Over { readonly stage: "stopped"; readonly by: StoppedBy }
export interface Failed extends Over { readonly stage: "failed"; readonly code: string; readonly message: string }
/** Never listed again; a late call is told so. */
export interface Removed extends Common { readonly stage: "removed"; readonly why: "removed" | "chat-deleted" }

export type Waiting = Queued | Held | Next | Editing;
export type InFlight = Starting | Live | Drawing | Stopping;
export type Ended = Done | Stopped | Failed;
export type Rec = Waiting | InFlight | Ended | Removed;
export type Stage = Rec["stage"];

export const WAITING: ReadonlySet<Stage> = new Set(["queued", "held", "next", "editing"]);
export const LIVE: ReadonlySet<Stage> = new Set(["loading", "thinking", "tool", "writing"]);
export const IN_FLIGHT: ReadonlySet<Stage> = new Set(["starting", "loading", "thinking", "tool", "writing", "drawing", "stopping"]);
export const ENDED: ReadonlySet<Stage> = new Set(["done", "stopped", "failed"]);

export const isWaiting = (r: Rec | undefined): r is Waiting => r !== undefined && WAITING.has(r.stage);
export const isLive = (r: Rec | undefined): r is Live => r !== undefined && LIVE.has(r.stage);
export const isInFlight = (r: Rec | undefined): r is InFlight => r !== undefined && IN_FLIGHT.has(r.stage);
export const isEnded = (r: Rec | undefined): r is Ended => r !== undefined && ENDED.has(r.stage);
/** Its question is saved and its reply has not ended. */
export const isAsked = (r: Rec | undefined): r is Live | Drawing | Stopping => isInFlight(r) && r.stage !== "starting";

/** Why a start was refused: the refusal's code and words, the replies in the way, what runs instead. */
export type Refusal = Omit<Extract<HeldWhy, { why: "refused" }>, "why">;

/** What the reply before a message in its chat did. */
export type Ahead =
  /** It was stopped, or its start was refused: what waited behind it holds. */
  | "stopped"
  /** A Stop named it after it had ended: what waited holds, and a start not yet saved comes back. */
  | "late-stop"
  /** It failed and runs once more. */
  | "retry"
  /** Its second try failed too. */
  | "failed"
  /** It ended well. */
  | "done";

/** How a reply ended. */
export type End =
  | { readonly how: "done"; readonly replyId?: string }
  | { readonly how: "failed"; readonly code: string; readonly message: string }
  | { readonly how: "stopped"; readonly by: StoppedBy };

/** A call that names one message. */
export type Call =
  /**
   * Send. `record`: the message as the call asks for it (waiting, on hold or next). `saved`: a
   * question with its messageId is in the chat. `start`: a start is offered with it, for a chat
   * with nothing running.
   */
  | {
    readonly call: "send";
    readonly record: Queued | Held | Next;
    readonly chat: { readonly deleting: boolean; readonly closing: boolean; readonly busy: boolean };
    readonly saved: boolean;
    readonly start?: { readonly turnId: string; readonly at: number; readonly retry: boolean };
  }
  /** `baseSaved`: a question named `base` is in the chat. */
  | { readonly call: "change"; readonly base: string; readonly messageId: string; readonly words: Partial<Words>; readonly by: number; readonly baseSaved: boolean }
  | { readonly call: "edit"; readonly open: boolean; readonly by: number }
  | { readonly call: "remove" }
  /** `stops`: the reply on its way in its chat stops in the same call. */
  | { readonly call: "now"; readonly consent?: StopConsent; readonly stops: boolean }
  | { readonly call: "hold" }
  | { readonly call: "stop"; readonly at: number };

/** Something the server did or heard. */
export type Event =
  /** The picker took it. */
  | { readonly event: "take"; readonly turnId: string; readonly at: number }
  /** Its model is loading, before its start. */
  | { readonly event: "load"; readonly turnId: string }
  /** Its start work ended well: its question was saved in this same step. */
  | { readonly event: "start"; readonly turnId: string; readonly attempt: number; readonly question: Message; readonly model: string; readonly cold: boolean; readonly drawing: boolean; readonly jobs?: readonly string[] }
  /** Its start was refused, or cut before anything was saved. */
  | { readonly event: "refuse"; readonly turnId: string; readonly attempt: number; readonly why: Refusal }
  /** A call started or ended. */
  | { readonly event: "tool"; readonly turnId: string; readonly callId: string; readonly running: boolean }
  /** Thinking text came. */
  | { readonly event: "think"; readonly turnId: string }
  /** A word of the answer came. */
  | { readonly event: "word"; readonly turnId: string }
  /** It failed and runs once more. */
  | { readonly event: "retry"; readonly turnId: string }
  | { readonly event: "end"; readonly turnId: string; readonly at: number; readonly end: End }
  /** The reply before it in its chat did this. */
  | { readonly event: "ahead"; readonly what: Ahead }
  /** The app started: this record is from the one a closed app left. */
  | { readonly event: "restart"; readonly at: number }
  | { readonly event: "chat-deleted" }
  /** A question with its messageId is in the chat: it was asked. */
  | { readonly event: "saved" }
  /** The work started for it has given back everything it took. */
  | { readonly event: "left"; readonly turnId: string; readonly at: number };

export type Input = Call | Event;

export type Answer =
  /** `record`: as it now is; for a remove, as it was. */
  | { readonly answer: "done" | "sending" | "elsewhere"; readonly record: Rec }
  | { readonly answer: "gone"; readonly why: "sent" | "removed" | "chat-deleted" | "unknown"; readonly questionId?: string };

export interface Moved {
  /** For a call: what the caller is told. */
  readonly answer?: Answer;
  /** The record as it now is: the same object when nothing changed, none when there is no record. */
  readonly next: Rec | undefined;
  /** The other messages of its chat hear this. */
  readonly ahead?: Ahead;
  /** The work of this turn is cut now. `at`: a person's Stop, taken then. */
  readonly cut?: { readonly turnId: string; readonly at?: number };
  /** The reply on its way in its chat is stopped in the same step. */
  readonly stopChat?: true;
}

/**
 * The rules a broken variant turns off, one at a time, to show the test that guards each. Product
 * code never passes any: `SOUND` is the default everywhere, and only a test builds another.
 */
export interface Rules {
  /** A Stop that names a reply already ended still holds what waits in its chat. */
  readonly lateStopHolds: boolean;
  /** A remove of a message already on its way says so. */
  readonly removeAnswersHonestly: boolean;
  /** A change the server did not take is never answered as done. */
  readonly editAnswersHonestly: boolean;
  /** A send whose question is already saved is not queued again. */
  readonly sendChecksSaved: boolean;
  /** A restart holds every waiting message. */
  readonly restartHolds: boolean;
  /** The start work saves only while its record is still starting, for the same start. */
  readonly saveChecksStage: boolean;
  /** The picker never takes a message open in a composer. */
  readonly pickSkipsEditing: boolean;
  /** A restart drops a waiting message whose question is saved. */
  readonly restartReconciles: boolean;
  /** A removed message's id is remembered. */
  readonly removalIsRemembered: boolean;
}
export const SOUND: Rules = Object.freeze({
  lateStopHolds: true, removeAnswersHonestly: true, editAnswersHonestly: true, sendChecksSaved: true, restartHolds: true,
  saveChecksStage: true, pickSkipsEditing: true, restartReconciles: true, removalIsRemembered: true,
});

const unsaved = (r: Unsaved): Unsaved => ({ id: r.id, threadId: r.threadId, rev: r.rev, words: r.words, behind: r.behind, starts: r.starts, direct: r.direct });
const common = (r: Common): Common => ({ id: r.id, threadId: r.threadId, rev: r.rev });

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The waiting stage a record is in, as an edit keeps it. */
function backOf(r: Queued | Held | Next): Back {
  if (r.stage === "queued") return { stage: "queued", waitFor: r.waitFor };
  if (r.stage === "held") return { stage: "held", why: r.why };
  return { stage: "next", ...(r.consent === undefined ? {} : { consent: r.consent }) };
}
/** Back from an edit, with the words it now has. */
const returned = (r: Editing, words: Words = r.words): Queued | Held | Next => ({ ...unsaved(r), words, ...r.back });

const held = (r: Unsaved, why: HeldWhy, behind: Behind = r.behind): Held => ({ ...unsaved(r), behind, stage: "held", why });
const STOPPED: HeldWhy = { why: "stopped" };

/** On hold by a person: a hold it already has keeps its reason. */
function onHold(r: Waiting): Waiting {
  if (r.stage === "held") return r;
  if (r.stage === "editing") return r.back.stage === "held" ? r : { ...r, back: { stage: "held", why: STOPPED } };
  return held(r, STOPPED);
}

/** What a queued message does when the reply before it in its chat did `what`; none when it stays as it is. */
function behindIt(waitFor: Waits, what: Ahead, behind: Behind): Back | undefined {
  if (what === "stopped" || what === "late-stop") return { stage: "held", why: STOPPED };
  if (what === "failed") return { stage: "held", why: { why: "failed" } };
  if (what === "retry") return waitFor === "retry" ? undefined : { stage: "queued", waitFor: "retry" };
  return waitFor === "retry" ? { stage: "queued", waitFor: behind } : undefined;
}

const isPerson = (r: Rec): r is Waiting | InFlight => isWaiting(r) || isInFlight(r);
const LEFT_START = { code: "internal", message: "the start ended without saying why" };
const LEFT_REPLY = { code: "internal", message: "the reply ended without finishing" };

/** A call met a record that is not waiting: too late, and where it went. */
function late(r: Starting | Live | Drawing | Stopping | Ended | Removed): Moved {
  if (r.stage === "removed") return { answer: { answer: "gone", why: r.why }, next: r };
  if (isEnded(r)) return { answer: { answer: "gone", why: "sent", ...(r.questionId === undefined ? {} : { questionId: r.questionId }) }, next: r };
  return { answer: { answer: "sending", record: r }, next: r };
}

const done = (next: Rec, more: Omit<Moved, "answer" | "next"> = {}): Moved => ({ answer: { answer: "done", record: next }, next, ...more });
const UNKNOWN: Moved = { answer: { answer: "gone", why: "unknown" }, next: undefined };

function call(r: Rec | undefined, c: Call, rules: Rules): Moved {
  if (c.call === "send") {
    // the same send again: a message still waiting or starting is as it was asked for; later, the answer says where it went
    if (r !== undefined) return isWaiting(r) || r.stage === "starting" ? done(r) : late(r);
    if (c.chat.deleting) return { answer: { answer: "gone", why: "chat-deleted" }, next: undefined };
    if (c.saved && rules.sendChecksSaved) return { answer: { answer: "gone", why: "sent", questionId: c.record.words.messageId }, next: undefined };
    if (c.chat.closing) return done(held(c.record, { why: "restart" }));
    if (c.start === undefined || c.chat.busy) return done(c.record);
    const consent = c.record.stage === "next" ? c.record.consent : undefined;
    return done({
      ...unsaved(c.record), starts: 1, stage: "starting", turnId: c.start.turnId, attempt: 1, startedAt: c.start.at,
      now: c.record.stage === "next", ...(consent === undefined ? {} : { consent }), loading: false, retry: c.start.retry,
    });
  }
  if (r === undefined) {
    // a restart forgets where a message went: its saved question still says it was sent
    if (c.call === "change" && c.baseSaved) return { answer: { answer: "gone", why: "sent", questionId: c.base }, next: undefined };
    return UNKNOWN;
  }
  if (c.call === "stop") {
    if (isWaiting(r)) return done(onHold(r));
    // not waited for: its work finds the record moved on and saves nothing
    if (r.stage === "starting") return done(held(r, STOPPED, "reply"), { ahead: "stopped", cut: { turnId: r.turnId, at: c.at } });
    if (isLive(r) || r.stage === "drawing") {
      const { id, threadId, rev, turnId, question, model } = r;
      return done({ id, threadId, rev, turnId, question, model, try: r.try, stage: "stopping", stoppedAt: c.at, drawing: r.stage === "drawing", ...(r.stage === "drawing" ? { jobs: r.jobs } : {}) }, { ahead: "stopped", cut: { turnId, at: c.at } });
    }
    if (r.stage === "stopping") return done(r);
    // its last word beat the Stop: Stop still means stop for what waits in its chat
    return isEnded(r) && rules.lateStopHolds ? { ...late(r), ahead: "late-stop" } : late(r);
  }
  if (!isWaiting(r)) {
    if (!isInFlight(r)) return late(r);
    // the broken variants: a call that came too late is answered as if it had been done
    if (c.call === "remove" && !rules.removeAnswersHonestly) return done(r);
    if (c.call === "change" && !rules.editAnswersHonestly) return done(r);
    return late(r);
  }
  const theirs = r.stage === "editing" && (c.call === "change" || c.call === "edit") && r.by !== c.by;
  switch (c.call) {
    case "change": {
      if (theirs) return rules.editAnswersHonestly ? { answer: { answer: "elsewhere", record: r }, next: r } : done(r);
      // the same change again, after its answer was lost on the way back
      if (r.words.messageId === c.messageId && c.base !== c.messageId) return done(r);
      // the words are not the ones this change started from: another window changed them
      if (r.words.messageId !== c.base) return rules.editAnswersHonestly ? { answer: { answer: "elsewhere", record: r }, next: r } : done(r);
      const words: Words = { ...r.words, ...c.words, messageId: c.messageId };
      if (sameJson(words, r.words)) return done(r);
      // the words are the edit's save, which gives the message back; a new model alone leaves an edit open
      if (r.stage === "editing" && c.words.text !== undefined) return done(returned(r, words));
      return done({ ...r, words });
    }
    case "edit": {
      if (r.stage !== "editing") return done(c.open ? { ...unsaved(r), stage: "editing", by: c.by, back: backOf(r) } : r);
      if (theirs) return { answer: { answer: "elsewhere", record: r }, next: r };
      if (c.open) return done(r);
      return done(returned(r));
    }
    case "remove":
      return { answer: { answer: "done", record: r }, next: { ...common(r), stage: "removed", why: "removed" } };
    case "now": {
      const stopChat = c.stops ? { stopChat: true as const } : {};
      // asked again with no new yes: it is going next already, with the yes it had
      if (r.stage === "next" && c.consent === undefined) return done(r, stopChat);
      // an edit open on it, in any window, is over: that window's save is then answered as too late
      return done({ ...unsaved(r), stage: "next", ...(c.consent === undefined ? {} : { consent: c.consent }) }, stopChat);
    }
    case "hold":
      return done(onHold(r));
  }
}

function event(r: Rec | undefined, e: Event, rules: Rules): Moved {
  if (r === undefined) return { next: undefined };
  const same: Moved = { next: r };
  switch (e.event) {
    case "take": {
      const takes = r.stage === "queued" || r.stage === "next" || (r.stage === "editing" && !rules.pickSkipsEditing);
      if (!takes) return same;
      const from = r.stage === "editing" ? r.back : r;
      const consent = from.stage === "next" ? from.consent : undefined;
      return { next: {
        ...unsaved(r), starts: r.starts + 1, stage: "starting", turnId: e.turnId, attempt: r.starts + 1, startedAt: e.at,
        now: from.stage === "next", ...(consent === undefined ? {} : { consent }), loading: false, retry: false,
      } };
    }
    case "load":
      return r.stage === "starting" && r.turnId === e.turnId && !r.loading ? { next: { ...r, loading: true } } : same;
    case "start": {
      // the work of an older start finds the record moved on: nothing changes, and it saves nothing
      if (r.stage !== "starting" || r.turnId !== e.turnId || r.attempt !== e.attempt) return same;
      const asked = { ...common(r), turnId: e.turnId, question: e.question, model: e.model, try: 1 };
      if (e.drawing) return { next: { ...asked, stage: "drawing", jobs: e.jobs ?? [] } };
      return { next: { ...asked, stage: e.cold ? "loading" : "thinking", calls: [], heard: false } };
    }
    case "refuse": {
      if (r.stage !== "starting" || r.turnId !== e.turnId || r.attempt !== e.attempt) return same;
      // a Retry has no place in the queue to go back to: its question is already in the chat
      if (r.retry) return { next: { ...common(r), stage: "failed", at: r.startedAt, turnId: r.turnId, code: e.why.code, message: e.why.message }, ahead: "stopped" };
      return { next: held(r, { why: "refused", ...e.why }, "reply"), ahead: "stopped" };
    }
    case "tool": {
      if (!isLive(r) || r.turnId !== e.turnId) return same;
      const calls = e.running ? (r.calls.includes(e.callId) ? r.calls : [...r.calls, e.callId]) : r.calls.filter((id) => id !== e.callId);
      // after a call the model reads its result: that is thinking until its next word
      const stage = calls.length > 0 ? "tool" : "thinking";
      return stage === r.stage && calls.length === r.calls.length && r.heard ? same : { next: { ...r, stage, calls, heard: true } };
    }
    case "think":
    case "word": {
      if (!isLive(r) || r.turnId !== e.turnId) return same;
      const stage = r.calls.length > 0 ? r.stage : e.event === "think" ? "thinking" : "writing";
      return stage === r.stage && r.heard ? same : { next: { ...r, stage, heard: true } };
    }
    case "retry": {
      if (!isLive(r) || r.turnId !== e.turnId) return same;
      // a model that was ready works on the reply again at once; one still loading keeps loading
      return { next: { ...r, try: r.try + 1, calls: [], ...(r.stage === "loading" ? {} : { stage: "thinking", heard: true }) }, ahead: "retry" };
    }
    case "end": {
      if (!isAsked(r) || r.turnId !== e.turnId) return same;
      const over = { ...common(r), at: e.at, turnId: r.turnId, questionId: r.question.id };
      if (e.end.how === "done") {
        // a Stop that lost to the last word cut nothing: the reply is done, and what waited still holds
        return { next: { ...over, stage: "done", ...(e.end.replyId === undefined ? {} : { replyId: e.end.replyId }) }, ahead: r.stage === "stopping" ? "stopped" : "done" };
      }
      if (r.stage === "stopping") return { next: { ...over, at: r.stoppedAt, stage: "stopped", by: { who: "person" } }, ahead: "stopped" };
      if (e.end.how === "stopped") return { next: { ...over, stage: "stopped", by: e.end.by }, ahead: "stopped" };
      // only a second failure is said on what waits behind it
      return { next: { ...over, stage: "failed", code: e.end.code, message: e.end.message }, ahead: r.try > 1 ? "failed" : "stopped" };
    }
    case "ahead": {
      if (e.what === "late-stop" && r.stage === "starting") return { next: held(r, STOPPED, "reply"), cut: { turnId: r.turnId } };
      // a message open in a composer waits behind that reply as it did before the edit
      if (r.stage === "editing" && r.back.stage === "queued") {
        const back = behindIt(r.back.waitFor, e.what, r.behind);
        return back === undefined ? same : { next: { ...r, back } };
      }
      if (r.stage !== "queued") return same;
      const back = behindIt(r.waitFor, e.what, r.behind);
      return back === undefined ? same : { next: { ...unsaved(r), ...back } };
    }
    case "restart": {
      if (isAsked(r)) return { next: { ...common(r), stage: "stopped", at: r.stage === "stopping" ? r.stoppedAt : e.at, turnId: r.turnId, questionId: r.question.id, by: { who: "closing" } } };
      if (!isPerson(r)) return same;
      if (r.stage === "held") {
        // a hold keeps its reason; "the reply before it failed" was about a reply the closed app took with it
        const why: HeldWhy = r.why.why === "failed" ? { why: "restart" } : r.why;
        return why === r.why && r.behind === "reply" ? same : { next: { ...r, why, behind: "reply" } };
      }
      // the broken variant: what waited goes on by itself after a restart
      if (!rules.restartHolds) return r.stage === "starting" ? { next: { ...unsaved(r), stage: "queued", waitFor: r.behind } } : r.stage === "editing" ? { next: returned(r) } : same;
      return { next: held(r, { why: "restart" }, "reply") };
    }
    case "chat-deleted":
      if (r.stage === "removed") return same;
      return { next: { ...common(r), stage: "removed", why: "chat-deleted" }, ...(isInFlight(r) ? { cut: { turnId: r.turnId } } : {}) };
    case "saved":
      return isWaiting(r) ? { next: { ...common(r), stage: "done", at: r.words.at, questionId: r.words.messageId } } : same;
    case "left": {
      const over = { ...common(r), at: e.at, turnId: e.turnId };
      // Its work is gone and never said how it ended. No record stays on its way without its work.
      if (r.stage === "starting" && r.turnId === e.turnId) {
        if (r.retry || r.direct) return { next: { ...over, stage: "failed", ...LEFT_START }, ahead: "stopped" };
        return { next: held(r, { why: "refused", ...LEFT_START }, "reply"), ahead: "stopped" };
      }
      if (isAsked(r) && r.turnId === e.turnId) return { next: { ...over, questionId: r.question.id, stage: "failed", ...LEFT_REPLY }, ahead: "stopped" };
      // a Retry's question is in the chat: the record of a start that never saved ends here
      if (r.stage !== "held" || !r.direct) return same;
      const why = r.why;
      return { next: why.why === "refused" ? { ...over, stage: "failed", code: why.code, message: why.message } : { ...over, stage: "stopped", by: { who: "person" } } };
    }
  }
}

/** The one step: what `input` does to `record`, and what the caller is told. */
export function move(record: Rec | undefined, input: Input, rules: Rules = SOUND): Moved {
  return "call" in input ? call(record, input, rules) : event(record, input, rules);
}

/** What a turn's stream sent, before its end. */
export type Heard =
  | { readonly type: "thinking" | "delta"; readonly text: string }
  | { readonly type: "tool"; readonly step: { readonly callId: string; readonly state: string } };

/** What the stream sent, as an event for its record; none for text with no words in it. */
export function heardAs(turnId: string, heard: Heard): Event | undefined {
  if (heard.type === "tool") return { event: "tool", turnId, callId: heard.step.callId, running: heard.step.state === "running" };
  if (heard.text === "") return undefined;
  return { event: heard.type === "thinking" ? "think" : "word", turnId };
}

/** Whether the work of start `attempt` for `turnId` may still write: the record is starting, for that start. */
export const stillStarting = (r: Rec | undefined, turnId: string, attempt: number, rules: Rules = SOUND): boolean =>
  !rules.saveChecksStage || (r !== undefined && r.stage === "starting" && r.turnId === turnId && r.attempt === attempt);

// ---------------------------------------------------------------- the older wire shapes, made from the record

/** A message as the queue's file has it, as a record: the flags a row can carry say one stage. */
export function fromQueued(q: SavedEntry): Queued | Held | Next {
  const words: Words = {
    messageId: q.messageId, text: q.text, at: q.at,
    ...(q.images === undefined ? {} : { images: q.images }),
    ...(q.files === undefined ? {} : { files: q.files }),
    ...(q.model === undefined ? {} : { model: q.model }),
    ...(q.numCtx === undefined ? {} : { numCtx: q.numCtx }),
    ...(q.think === undefined ? {} : { think: q.think }),
    ...(q.draw === undefined ? {} : { draw: q.draw }),
    ...(q.drawCount === undefined ? {} : { drawCount: q.drawCount }),
  };
  const base: Unsaved = { id: q.id, threadId: q.threadId, rev: 0, words, behind: q.waitFor, starts: 0, direct: false };
  if (q.now === true) return { ...base, stage: "next", ...(q.stopOthers !== true ? {} : { consent: q.stopTurns === undefined ? { kind: "standing" } : { kind: "named", replies: q.stopTurns } }) };
  // held while the reply before it runs once more: it goes on its own if that try ends well
  if (q.held === true && q.retry === "running") return { ...base, stage: "queued", waitFor: "retry" };
  if (q.held === true) return { ...base, stage: "held", why: q.why !== undefined ? { why: "refused", ...q.why } : q.retry === "failed" ? { why: "failed" } : STOPPED };
  return { ...base, stage: "queued", waitFor: q.waitFor };
}

function flags(back: Back): Partial<SavedEntry> {
  if (back.stage === "next") return { now: true, ...(back.consent === undefined ? {} : { stopOthers: true, ...(back.consent.kind === "named" ? { stopTurns: back.consent.replies } : {}) }) };
  if (back.stage === "queued") return back.waitFor === "retry" ? { held: true, retry: "running" } : {};
  if (back.why.why === "refused") {
    const { code, message, blocking, offer } = back.why;
    return { held: true, why: { code, message, ...(blocking === undefined ? {} : { blocking }), ...(offer === undefined ? {} : { offer }) } };
  }
  return { held: true, ...(back.why.why === "failed" ? { retry: "failed" } : {}) };
}

/** The record as a row of the queue every window is sent; none for a record that is on no list. */
export function toQueued(r: Rec): SavedEntry | undefined {
  if (!(isWaiting(r) || r.stage === "starting") || r.direct) return undefined;
  const { tools: _tools, retryOf: _retryOf, ...words } = r.words;
  const row = { id: r.id, threadId: r.threadId, ...words, waitFor: r.behind };
  if (r.stage === "starting") return { ...row, ...(r.now ? flags({ stage: "next", ...(r.consent === undefined ? {} : { consent: r.consent }) }) : {}), sending: r.turnId };
  if (r.stage === "editing") return { ...row, ...flags(r.back), editing: true };
  return { ...row, ...flags(backOf(r)) };
}

/** The stage a turn's older reply record says for this record. */
export function shownStage(r: InFlight): ReplyStage {
  if (r.stage === "starting") return r.loading ? "loading" : "waiting";
  if (r.stage === "drawing") return "waiting";
  // its model is in memory and has said nothing yet
  if (r.stage === "thinking" && !r.heard) return "waiting";
  return r.stage;
}
