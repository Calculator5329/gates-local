// The calls that name one reply (reply.change, reply.edit, reply.remove, reply.now, reply.hold,
// reply.stop), each answered with what happened to it: done, gone, already sending, or open
// elsewhere. The queue (queue.ts) keeps the waiting messages; this file says which stage each is
// in, as one record, and remembers the ones that left so a late call is told where its message
// went. Stop and Send now are each one step here: no window holds the rows behind a reply itself.
import type { HeldWhy, Message, Params, Reply, ReplyAnswer, StopConsent, WaitFor } from "@gates-local/contracts";
import type { Entry, Queue } from "./queue.ts";

/** A reply in flight as its turn has it; the record's id and number are put on by whoever asks. */
export type InFlight = (id: string, rev: number) => Reply;

export interface RepliesDeps {
  readonly queue: Queue;
  /** The saved message with this id. */
  readonly saved: (messageId: string) => Message | undefined;
  /** The reply in flight a turn id names, once its question is saved. */
  readonly flight: (turnId: string) => InFlight | undefined;
  /** The turn of the reply in flight in a chat. */
  readonly inChat: (threadId: string) => string | undefined;
  /** The Stop itself for a turn still held, started or not. Its chat, or none when the turn has left. */
  readonly stop: (turnId: string) => string | undefined;
  /** A turn stopped before its question was saved that came from no waiting message: its words, on hold. */
  readonly unsaved: (turnId: string) => InFlight | undefined;
}

export interface Replies {
  /** The queue changed: what changed is numbered, and what left is remembered. */
  changed(list: readonly Entry[]): void;
  /** A waiting message as one record. */
  record(q: Entry): Reply;
  change(params: Params<"reply.change">, by: number): ReplyAnswer;
  edit(params: Params<"reply.edit">, by: number): ReplyAnswer;
  remove(params: Params<"reply.remove">): ReplyAnswer;
  now(params: Params<"reply.now">): ReplyAnswer;
  hold(params: Params<"reply.hold">): ReplyAnswer;
  /** `id`: a waiting message's, or a turn's. */
  stop(params: Params<"reply.stop">): ReplyAnswer;
  /** A turn ended and left: a Stop that names it later still holds what waits in its chat. */
  settled(turnId: string, threadId: string, questionId: string | undefined): void;
  /** A window has this message open in its composer (the older queue.update). */
  lock(id: string, by: number): void;
  /** That window's edit is over: with `by`, only if the edit is still that window's. */
  release(id: string, by?: number): void;
}

/** Where a message that left the queue went. */
type Left = { readonly why: "sent"; readonly messageId: string; readonly turnId?: string } | { readonly why: "chat-deleted" };
/** Messages that left are remembered at most; the oldest go first. */
const LEFT_KEPT = 1000;

type Back = Extract<Reply, { stage: "editing" }>["back"];
type Found =
  | { readonly is: "waiting"; readonly q: Entry }
  | { readonly is: "late"; readonly answer: ReplyAnswer };

const consentOf = (q: Entry): StopConsent | undefined =>
  q.stopOthers !== true ? undefined : q.stopTurns === undefined ? { kind: "standing" } : { kind: "named", replies: q.stopTurns };

const heldWhy = (q: Entry): HeldWhy =>
  q.why !== undefined ? { why: "refused", ...q.why } : q.retry === "failed" ? { why: "failed" } : { why: "stopped" };

/** The waiting stage a message is in, or returns to when its edit ends. */
function backOf(q: Entry): Back {
  if (q.now === true) {
    const consent = consentOf(q);
    return { stage: "next", ...(consent === undefined ? {} : { consent }) };
  }
  // held while the reply before it runs once more: it goes on its own if that attempt ends well
  if (q.held === true && q.retry !== "running") return { stage: "held", held: heldWhy(q) };
  return { stage: "queued" };
}

export function createReplies({ queue, saved, flight, inChat, stop, unsaved }: RepliesDeps): Replies {
  /** Which connection has each message open in its composer. */
  const editors = new Map<string, number>();
  /** Each version of a queue entry, numbered when it was made: an entry is replaced, never changed. */
  const revs = new WeakMap<Entry, number>();
  let counter = 0;
  /** Each message's starts: the turn of the latest, how many there were, and when it was taken. */
  const starts = new Map<string, { readonly turnId: string; readonly attempt: number; readonly at: number }>();
  const left = new Map<string, Left>();
  /** Turns that ended, with their chat and saved question. Bounded by count, never by time. */
  const ended = new Map<string, { readonly threadId: string; readonly questionId: string | undefined }>();
  let last = queue.list();

  const revOf = (q: Entry): number => {
    let rev = revs.get(q);
    if (rev === undefined) revs.set(q, (rev = ++counter));
    return rev;
  };

  function changed(list: readonly Entry[]): void {
    for (const q of list) {
      if (revs.has(q)) continue;
      revs.set(q, ++counter);
      const start = starts.get(q.id);
      if (q.sending !== undefined && start?.turnId !== q.sending) starts.set(q.id, { turnId: q.sending, attempt: (start?.attempt ?? 0) + 1, at: Date.now() });
    }
    for (const was of last) {
      if (list.some((q) => q.id === was.id)) continue;
      editors.delete(was.id);
      starts.delete(was.id);
      if (queue.removed(was.id)) continue;
      // it went out (its question is saved, or its turn was taken), or its chat was deleted under it
      const sent = was.sending !== undefined || saved(was.messageId) !== undefined;
      left.set(was.id, sent ? { why: "sent", messageId: was.messageId, ...(was.sending === undefined ? {} : { turnId: was.sending }) } : { why: "chat-deleted" });
      for (const old of left.keys()) {
        if (left.size <= LEFT_KEPT) break;
        left.delete(old);
      }
    }
    last = list;
  }

  function waitFor(q: Entry): WaitFor | undefined {
    if (q.waitFor === "setup") return { what: "setup" };
    if (q.waitFor === "download") return { what: "download", ...(q.model === undefined ? {} : { model: q.model }) };
    const reply = inChat(q.threadId);
    return reply === undefined ? undefined : { what: q.retry === "running" ? "retry" : "reply", reply };
  }

  function record(q: Entry): Reply {
    const words = {
      id: q.id, threadId: q.threadId, rev: revOf(q), messageId: q.messageId, text: q.text, at: q.at,
      ...(q.images === undefined ? {} : { images: q.images }),
      ...(q.files === undefined ? {} : { files: q.files }),
      ...(q.model === undefined ? {} : { model: q.model }),
      ...(q.numCtx === undefined ? {} : { numCtx: q.numCtx }),
      ...(q.think === undefined ? {} : { think: q.think }),
      ...(q.draw === undefined ? {} : { draw: q.draw }),
      ...(q.drawCount === undefined ? {} : { drawCount: q.drawCount }),
    };
    if (q.sending !== undefined) {
      const start = starts.get(q.id);
      return { ...words, stage: "starting", attempt: start?.attempt ?? 1, startedAt: start?.at ?? q.at };
    }
    const back = backOf(q);
    if (q.editing === true) return { ...words, stage: "editing", by: String(editors.get(q.id) ?? 0), back };
    if (back.stage !== "queued") return { ...words, ...back };
    const wait = waitFor(q);
    return { ...words, stage: "queued", ...(wait === undefined ? {} : { waitFor: wait }) };
  }

  /** The message a call names: still waiting, or where it went. */
  function find(id: string): Found {
    const q = queue.list().find((x) => x.id === id);
    if (q !== undefined) return q.sending === undefined ? { is: "waiting", q } : { is: "late", answer: { answer: "sending", reply: record(q) } };
    if (queue.removed(id)) return { is: "late", answer: { answer: "gone", why: "removed" } };
    const l = left.get(id);
    if (l === undefined) return { is: "late", answer: { answer: "gone", why: "unknown" } };
    if (l.why === "chat-deleted") return { is: "late", answer: { answer: "gone", why: "chat-deleted" } };
    const going = l.turnId === undefined ? undefined : flight(l.turnId);
    if (going !== undefined) return { is: "late", answer: { answer: "sending", reply: going(id, counter) } };
    const question = saved(l.messageId);
    return { is: "late", answer: { answer: "gone", why: "sent", ...(question === undefined ? {} : { question }) } };
  }

  /** The record as it now is, after a change this call made or found already made. */
  const done = (id: string, was: Entry): ReplyAnswer => ({ answer: "done", reply: record(queue.list().find((x) => x.id === id) ?? was) });
  /** Open in another window's composer. */
  const theirs = (q: Entry, by: number) => q.editing === true && editors.get(q.id) !== by;

  /**
   * Stop for one turn, in one step: a message taken for it and not yet saved goes back to its
   * place on hold, the turn stops, and what would have gone on its own behind it holds. Its
   * chat, or none when the turn has left.
   */
  function stopTurn(turnId: string): string | undefined {
    queue.pullBack(turnId);
    const threadId = stop(turnId);
    if (threadId !== undefined) queue.ended(threadId, "stopped");
    return threadId;
  }

  return {
    changed,
    record,
    change({ id, base, messageId, ...words }, by) {
      const found = find(id);
      if (found.is === "late") {
        // a restart forgets where a message went: its saved question still says it was sent
        const question = found.answer.answer === "gone" && found.answer.why === "unknown" ? saved(base) : undefined;
        return question === undefined ? found.answer : { answer: "gone", why: "sent", question };
      }
      const { q } = found;
      if (theirs(q, by)) return { answer: "elsewhere", reply: record(q) };
      // the same change again, after its answer was lost on the way back
      if (q.messageId === messageId && base !== messageId) return done(id, q);
      // the words are not the ones this change started from: another window changed them
      if (q.messageId !== base) return { answer: "elsewhere", reply: record(q) };
      // the words are the edit's save, which gives the message back; a new model alone leaves an edit open
      const saves = words.text !== undefined;
      queue.change(id, { ...words, messageId, ...(saves ? { editing: false } : {}) });
      if (saves) editors.delete(id);
      return done(id, q);
    },
    edit({ id, open }, by) {
      const found = find(id);
      if (found.is === "late") return found.answer;
      const { q } = found;
      if (theirs(q, by)) return { answer: "elsewhere", reply: record(q) };
      if (open) editors.set(id, by);
      else editors.delete(id);
      queue.change(id, { editing: open });
      return done(id, q);
    },
    remove({ id }) {
      const found = find(id);
      if (found.is === "late") return found.answer;
      const was = record(found.q);
      queue.remove(id);
      return { answer: "done", reply: was };
    },
    now({ id, consent }) {
      const found = find(id);
      if (found.is === "late") return found.answer;
      // an edit open on it, in any window, is over: that window's save is then answered as too late
      editors.delete(id);
      // asked again with no new yes: it is going next already, with the yes it had
      const again = found.q.now === true && found.q.editing !== true && consent === undefined;
      if (!again) queue.change(id, { now: true, ...(consent === undefined ? {} : { stopOthers: true as const, ...(consent.kind === "named" ? { stopTurns: consent.replies } : {}) }) });
      // the reply on its way in its chat stops in this same call: no window sends a Stop after it
      const going = inChat(found.q.threadId);
      if (going !== undefined) stopTurn(going);
      return done(id, found.q);
    },
    hold({ id }) {
      const found = find(id);
      if (found.is === "late") return found.answer;
      queue.hold(id);
      return done(id, found.q);
    },
    stop({ id }) {
      const rows = queue.list();
      // by its own id, by the turn taken for it, or by the turn it was pulled back from
      const q = rows.find((x) => x.id === id) ?? rows.find((x) => x.sending === id || (x.sending === undefined && starts.get(x.id)?.turnId === id));
      if (q !== undefined && q.sending === undefined) {
        // waiting: a Stop on it is a hold
        queue.hold(q.id);
        return done(q.id, q);
      }
      const l = left.get(id);
      const turnId = q?.sending ?? (l?.why === "sent" ? l.turnId : undefined) ?? id;
      if (stopTurn(turnId) !== undefined) {
        // taken and not yet saved: it is back in its place, on hold
        if (q !== undefined) return done(q.id, q);
        const going = flight(turnId) ?? unsaved(turnId);
        if (going !== undefined) return { answer: "done", reply: going(id, counter) };
        // its last event is out and it is leaving: too late, and what waits behind it holds
        const found = find(id);
        return found.is === "late" && found.answer.answer === "gone" && found.answer.why === "sent" ? found.answer : { answer: "gone", why: "sent" };
      }
      const was = ended.get(turnId);
      if (was === undefined) {
        const found = find(id);
        return found.is === "late" ? found.answer : done(id, found.q);
      }
      // The reply's last word beat the Stop here. Stop still means stop: what went out behind it
      // and is not saved yet comes back, also one that went by Send now, and the rest holds.
      const next = inChat(was.threadId);
      if (next !== undefined && queue.pullBack(next)) stop(next);
      queue.ended(was.threadId, "stopped");
      const question = was.questionId === undefined ? undefined : saved(was.questionId);
      return { answer: "gone", why: "sent", ...(question === undefined ? {} : { question }) };
    },
    settled(turnId, threadId, questionId) {
      ended.set(turnId, { threadId, questionId });
      for (const old of ended.keys()) {
        if (ended.size <= LEFT_KEPT) break;
        ended.delete(old);
      }
    },
    lock(id, by) {
      editors.set(id, by);
    },
    release(id, by) {
      if (by !== undefined && editors.get(id) !== by) return;
      editors.delete(id);
      queue.change(id, { editing: false });
    },
  };
}
