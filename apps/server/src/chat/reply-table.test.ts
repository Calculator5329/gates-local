// The reply's stages as a table: a case per cell. Each case puts one reply at a stage, makes one
// call or lets one server event happen, and checks the answer and the stage that follows, as
// every window is told it.
import type { Message, Payload, QueuedMessage, Reply, ReplyAnswer, ReplyRecord, ReplyStage } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import { MODEL, type Rig, type RigHooks, rig, settle, until } from "../../test/send-rig.ts";
import { type Call as Asked, type Event, type Queued, type Rec, type Stage, type Words, fromQueued, heardAs, move, shownStage, stillStarting, toQueued } from "./reply.ts";

/** Where a case starts: a reply the server has taken and not started, one being written, one a Stop was taken for. */
type From = "starting" | "writing" | "stopping";

interface At {
  readonly r: Rig;
  readonly turnId: string;
}

const stageOf = ({ r, turnId }: At): ReplyStage | undefined => r.record(turnId)?.stage;
const over = ({ r, turnId }: At) => r.events(turnId).some((e) => e.type === "done" || e.type === "error");

const reach: Record<From, () => Promise<At>> = {
  starting: async () => {
    const r = rig({ drip: true });
    const { turnId } = await r.h["chat.send"]({ threadId: r.thread.id, content: "question", model: MODEL, numCtx: 16384 }, { clientId: 1 });
    return { r, turnId };
  },
  writing: async () => {
    const at = await reach.starting();
    at.r.open();
    await until(() => stageOf(at) === "writing", "the reply being written");
    return at;
  },
  stopping: async () => {
    const at = await reach.writing();
    await at.r.h["reply.stop"]({ id: at.turnId }, { clientId: 1 });
    return at;
  },
};

describe("a call on a reply at each stage", () => {
  // stage, call, the answer and the stage it carries, the stage every window is then told
  const cells: readonly (readonly [From, "stop" | "the older stop", Reply["stage"] | { cancelled: boolean }, ReplyStage])[] = [
    // sent from a composer and not started: no message waits for it here, so the answer is its words, on hold
    ["starting", "stop", "held", "stopping"],
    ["writing", "stop", "stopping", "stopping"],
    ["stopping", "stop", "stopping", "stopping"],
    ["starting", "the older stop", { cancelled: true }, "stopping"],
    ["writing", "the older stop", { cancelled: true }, "stopping"],
    ["stopping", "the older stop", { cancelled: false }, "stopping"],
  ];
  it.each(cells)("%s, %s: answered %o, then %s", async (from, call, answer, next) => {
    const at = await reach[from]();
    const before = at.r.record(at.turnId);
    const asked = Date.now();
    if (call === "stop") expect(await at.r.h["reply.stop"]({ id: at.turnId }, { clientId: 2 })).toMatchObject({ answer: "done", reply: { id: at.turnId, stage: answer } });
    else expect(await at.r.h["chat.cancel"]({ turnId: at.turnId }, { clientId: 2 })).toEqual(answer);
    const after = at.r.record(at.turnId);
    expect(after?.stage).toBe(next);
    if (from === "stopping") {
      // a second Stop moves nothing: the first one's moment stands
      expect(after).toEqual(before);
    } else {
      // every window is told the moment the server took the Stop, started or not
      expect(after?.stoppedAt).toBeGreaterThanOrEqual(asked);
      expect(after?.stoppedAt).toBeLessThanOrEqual(Date.now());
      expect(after?.startedAt).toBe(before?.startedAt ?? after?.startedAt);
    }
  });

  it("starting, stop: the answer is the words it was sent with, on hold, and nothing of it is saved", async () => {
    const at = await reach.starting();
    expect(await at.r.h["reply.stop"]({ id: at.turnId }, { clientId: 2 })).toMatchObject({ answer: "done", reply: { stage: "held", held: { why: "stopped" }, text: "question", model: MODEL, threadId: at.r.thread.id } });
    at.r.open();
    await until(() => over(at), "the stopped send's end");
    expect(at.r.starts()).toEqual([]);
    expect(at.r.db.getThread(at.r.thread.id).messages).toEqual([]);
  });
});

/** This window, and another one. */
const ME = 1;
const OTHER = 3;
/** The stage a waiting message starts a case in, or where it has gone. */
type Row = "no record" | "queued" | "held" | "editing, this window" | "editing, another window" | "next" | "starting" | "writing" | "stopping" | "ended" | "removed";
type Call = "change" | "change from older words" | "open edit" | "close edit" | "remove" | "send now" | "hold" | "stop";
type Answered = "done" | "sending" | "elsewhere" | "gone unknown" | "gone sent" | "gone removed";
/** The stage after: a waiting stage, off every list, its reply stopping, or as it was. */
type After = "queued" | "held" | "editing" | "next" | "removed" | "stopping" | "same";

/** The stage a window reads from the queue as it is pushed. */
const shown = (q: QueuedMessage | undefined): string =>
  q === undefined ? "none" : q.sending !== undefined ? "starting" : q.editing === true ? "editing" : q.now === true ? "next" : q.held === true ? "held" : "queued";
const q1 = (r: Rig) => r.queued().find((q) => q.id === "q1");

/** A message typed behind a reply that has not started: it waits. */
const behind = async (hooks: RigHooks = {}): Promise<Rig> => {
  const r = rig(hooks);
  await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: ME });
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: ME });
  return r;
};
/** A message the server took, with the turn it started for it. */
const taken = async (hooks: RigHooks = {}): Promise<At> => {
  const r = rig(hooks);
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: ME });
  await until(() => q1(r)?.sending !== undefined, "the message taken");
  return { r, turnId: q1(r)?.sending ?? "" };
};

const rows: Record<Row, () => Promise<Rig>> = {
  "no record": async () => rig(),
  queued: () => behind(),
  held: async () => {
    const r = await behind();
    await r.h["reply.hold"]({ id: "q1" }, { clientId: ME });
    return r;
  },
  "editing, this window": async () => {
    const r = await behind();
    await r.h["reply.edit"]({ id: "q1", open: true }, { clientId: ME });
    return r;
  },
  "editing, another window": async () => {
    const r = await behind();
    await r.h["reply.edit"]({ id: "q1", open: true }, { clientId: OTHER });
    return r;
  },
  next: async () => {
    const r = await behind();
    await r.h["reply.now"]({ id: "q1" }, { clientId: ME });
    return r;
  },
  starting: async () => (await taken()).r,
  writing: async () => {
    const at = await taken({ drip: true });
    at.r.open();
    await until(() => stageOf(at) === "writing", "the reply being written");
    return at.r;
  },
  stopping: async () => {
    const at = await taken({ drip: true });
    at.r.open();
    await until(() => stageOf(at) === "writing", "the reply being written");
    await at.r.h["reply.stop"]({ id: at.turnId }, { clientId: ME });
    return at.r;
  },
  ended: async () => {
    const at = await taken();
    at.r.open();
    await until(() => over(at), "the reply's end");
    return at.r;
  },
  removed: async () => {
    const r = await behind();
    await r.h["reply.remove"]({ id: "q1" }, { clientId: OTHER });
    return r;
  },
};

const calls: Record<Call, (r: Rig) => ReplyAnswer | Promise<ReplyAnswer>> = {
  change: (r) => r.h["reply.change"]({ id: "q1", base: "m-q1", messageId: "m-q1b", text: "new words" }, { clientId: ME }),
  "change from older words": (r) => r.h["reply.change"]({ id: "q1", base: "m-q0", messageId: "m-q1b", text: "new words" }, { clientId: ME }),
  "open edit": (r) => r.h["reply.edit"]({ id: "q1", open: true }, { clientId: ME }),
  "close edit": (r) => r.h["reply.edit"]({ id: "q1", open: false }, { clientId: ME }),
  remove: (r) => r.h["reply.remove"]({ id: "q1" }, { clientId: ME }),
  "send now": (r) => r.h["reply.now"]({ id: "q1" }, { clientId: ME }),
  hold: (r) => r.h["reply.hold"]({ id: "q1" }, { clientId: ME }),
  stop: (r) => r.h["reply.stop"]({ id: "q1" }, { clientId: ME }),
};
/** The record of the reply last heard of, as every window was told it. */
const heard = (r: Rig): ReplyRecord | undefined =>
  r.pushes.flatMap((p) => { const e = p.channel === "chat.event" ? (p.payload as Payload<"chat.event">).event : undefined; return e?.type === "reply" ? [e.reply] : []; }).at(-1);

describe("a call on a waiting message at each stage", () => {
  const every: readonly Call[] = ["change", "open edit", "close edit", "remove", "send now", "hold"];
  /** One answer for every call: too late, or nothing there. */
  const all = (row: Row, answer: Answered) => every.map((call) => [row, call, answer, "same"] as const);
  // stage, call, the answer, the stage after
  const cells: readonly (readonly [Row, Call, Answered, After])[] = [
    ...all("no record", "gone unknown"),
    ["queued", "change", "done", "queued"],
    ["queued", "change from older words", "elsewhere", "same"],
    ["queued", "open edit", "done", "editing"],
    ["queued", "close edit", "done", "same"],
    ["queued", "remove", "done", "removed"],
    ["queued", "send now", "done", "next"],
    ["queued", "hold", "done", "held"],
    ["held", "change", "done", "held"],
    ["held", "change from older words", "elsewhere", "same"],
    ["held", "open edit", "done", "editing"],
    ["held", "close edit", "done", "same"],
    ["held", "remove", "done", "removed"],
    ["held", "send now", "done", "next"],
    ["held", "hold", "done", "same"],
    ["editing, this window", "change", "done", "queued"],
    ["editing, this window", "open edit", "done", "same"],
    ["editing, this window", "close edit", "done", "queued"],
    ["editing, this window", "remove", "done", "removed"],
    ["editing, this window", "send now", "done", "next"],
    ["editing, this window", "hold", "done", "editing"],
    ["editing, another window", "change", "elsewhere", "same"],
    ["editing, another window", "open edit", "elsewhere", "same"],
    ["editing, another window", "close edit", "elsewhere", "same"],
    ["editing, another window", "remove", "done", "removed"],
    ["editing, another window", "send now", "done", "next"],
    ["editing, another window", "hold", "done", "editing"],
    ["next", "change", "done", "next"],
    ["next", "change from older words", "elsewhere", "same"],
    ["next", "open edit", "done", "editing"],
    ["next", "close edit", "done", "same"],
    ["next", "remove", "done", "removed"],
    ["next", "send now", "done", "same"],
    ["next", "hold", "done", "held"],
    ...all("starting", "sending"),
    ...all("writing", "sending"),
    ...all("stopping", "sending"),
    ...all("ended", "gone sent"),
    ...all("removed", "gone removed"),
    // Stop, named by the waiting message's own id: while it waits a Stop is a hold; taken and not
    // yet saved it comes back on hold; once its reply is being written that reply stops
    ["no record", "stop", "gone unknown", "same"],
    ["queued", "stop", "done", "held"],
    ["held", "stop", "done", "same"],
    ["editing, this window", "stop", "done", "editing"],
    ["editing, another window", "stop", "done", "editing"],
    ["next", "stop", "done", "held"],
    ["starting", "stop", "done", "held"],
    ["writing", "stop", "done", "stopping"],
    ["stopping", "stop", "done", "same"],
    ["ended", "stop", "gone sent", "same"],
    ["removed", "stop", "gone removed", "same"],
  ];
  it.each(cells)("%s, %s: answered %s, then %s", async (row, call, answered, after) => {
    const r = await rows[row]();
    const before = r.queued();
    const reply = heard(r);
    const answer = await calls[call](r);
    expect(answer.answer === "gone" ? `gone ${answer.why}` : answer.answer).toBe(answered);
    const now = q1(r);
    // every window is told the stage after: by the queue as it is pushed, and by the reply's record
    if (after === "same") expect([r.queued(), heard(r)]).toEqual([before, reply]);
    else if (after === "stopping") expect([r.queued(), heard(r)?.stage]).toEqual([before, "stopping"]);
    else expect(shown(now)).toBe(after === "removed" ? "none" : after);
    if (answer.answer === "gone") {
      // a message that went out is answered with its saved question
      expect(answer.question?.id).toBe(answered === "gone sent" ? "m-q1" : undefined);
      return;
    }
    // the answer carries the record: as it now is, or for a remove as it was
    const told = answer.reply.stage;
    if (row === "writing" || row === "stopping") expect(told).toBe(call === "stop" ? "stopping" : row);
    else if (after === "removed") expect(told).toBe(shown(before.find((q) => q.id === "q1")));
    else expect(told).toBe(shown(now));
    if (call === "change" && answered === "done") expect(now).toMatchObject({ messageId: "m-q1b", text: "new words" });
    if (answered === "elsewhere" || answered === "sending") expect(now?.text ?? "second").toBe("second");
    // a hold on a message open in a composer waits for the edit: it returns on hold
    if ((call === "hold" || call === "stop") && answer.reply.stage === "editing") expect(answer.reply.back).toEqual({ stage: "held", held: { why: "stopped" } });
    // a message taken and stopped before its question was saved is on hold with its words, and none of it is saved
    if (row === "starting" && call === "stop") {
      expect(answer.reply).toMatchObject({ id: "q1", stage: "held", held: { why: "stopped" }, text: "second" });
      expect(r.db.getMessage("m-q1")).toBeUndefined();
    }
  });

  it("a Send now or a remove ends another window's edit, and that window's save is then answered as too late, never as done", async () => {
    const r = await rows["editing, another window"]();
    expect(await r.h["reply.now"]({ id: "q1" }, { clientId: ME })).toMatchObject({ answer: "done", reply: { stage: "next" } });
    // the editor saves: its edit is over, and the words it started from still stand
    expect(await r.h["reply.edit"]({ id: "q1", open: false }, { clientId: OTHER })).toMatchObject({ answer: "done", reply: { stage: "next" } });
    expect(await r.h["reply.change"]({ id: "q1", base: "m-q1", messageId: "m-q1c", text: "edited" }, { clientId: OTHER })).toMatchObject({ answer: "done", reply: { stage: "next", text: "edited" } });
    await r.h["reply.remove"]({ id: "q1" }, { clientId: ME });
    expect(await r.h["reply.change"]({ id: "q1", base: "m-q1c", messageId: "m-q1d", text: "again" }, { clientId: OTHER })).toEqual({ answer: "gone", why: "removed" });
  });

  it("the same change asked twice, its first answer lost, is done once", async () => {
    const r = await rows.queued();
    const change = { id: "q1", base: "m-q1", messageId: "m-q1b", text: "new words" };
    const first = await r.h["reply.change"](change, { clientId: ME });
    expect(await r.h["reply.change"](change, { clientId: ME })).toEqual(first);
  });

  it("a record's number grows with each change to it", async () => {
    const r = await rows.queued();
    const held = await r.h["reply.hold"]({ id: "q1" }, { clientId: ME });
    const next = await r.h["reply.now"]({ id: "q1" }, { clientId: ME });
    if (held.answer !== "done" || next.answer !== "done") throw new Error("not done");
    expect(next.reply.rev).toBeGreaterThan(held.reply.rev);
  });
});

/** Every waiting message's stage, by its id. */
const stages = (r: Rig) => Object.fromEntries(r.queued().map((q) => [q.id, shown(q)]));
/** A reply being written, sent from a composer, with two messages waiting behind it. */
const writingWithTwo = async (): Promise<At> => {
  const at = await reach.writing();
  await at.r.h["queue.add"](at.r.entry("q1", "second"), { clientId: ME });
  await at.r.h["queue.add"](at.r.entry("q2", "third"), { clientId: ME });
  return at;
};

describe("Stop and Send now, each one step", () => {
  it("writing, stop: when the call is answered the reply is stopping and what waits behind it is on hold", async () => {
    const at = await writingWithTwo();
    expect(await at.r.h["reply.stop"]({ id: at.turnId }, { clientId: OTHER })).toMatchObject({ answer: "done", reply: { id: at.turnId, stage: "stopping" } });
    expect(stages(at.r)).toEqual({ q1: "held", q2: "held" });
    await until(() => over(at), "the stopped reply's end");
    await settle();
    expect(at.r.starts(), "nothing behind a stopped reply goes on its own").toEqual(["question"]);
    expect(stages(at.r)).toEqual({ q1: "held", q2: "held" });
  });

  it("starting, stop by the turn taken for it: the message is back on hold with the rest, named by its own id, and nothing of it is saved", async () => {
    const at = await taken();
    await at.r.h["queue.add"](at.r.entry("q2", "third"), { clientId: ME });
    expect(await at.r.h["reply.stop"]({ id: at.turnId }, { clientId: OTHER })).toMatchObject({ answer: "done", reply: { id: "q1", stage: "held", held: { why: "stopped" }, text: "second" } });
    expect(stages(at.r)).toEqual({ q1: "held", q2: "held" });
    at.r.open();
    await until(() => over(at), "the stopped send's end");
    await settle();
    expect(at.r.starts()).toEqual([]);
    expect(at.r.db.getMessage("m-q1")).toBeUndefined();
    // asked again, by the turn it was pulled back from: the same message, as it is
    expect(await at.r.h["reply.stop"]({ id: at.turnId }, { clientId: ME })).toMatchObject({ answer: "done", reply: { id: "q1", stage: "held" } });
    expect(stages(at.r)).toEqual({ q1: "held", q2: "held" });
  });

  it("writing, send now on a message behind it: in that one call the reply is stopping, the message goes next and the rest holds; it goes once the reply has ended", async () => {
    const at = await writingWithTwo();
    expect(await at.r.h["reply.now"]({ id: "q2" }, { clientId: OTHER })).toMatchObject({ answer: "done", reply: { id: "q2", stage: "next" } });
    expect(stageOf(at)).toBe("stopping");
    expect(stages(at.r)).toEqual({ q1: "held", q2: "next" });
    // a Stop after it holds only what would go on its own: the message going next stays next
    const stopped = at.r.record(at.turnId);
    expect(await at.r.h["reply.stop"]({ id: at.turnId }, { clientId: ME })).toMatchObject({ answer: "done", reply: { stage: "stopping" } });
    expect(at.r.record(at.turnId)).toEqual(stopped);
    expect(stages(at.r)).toEqual({ q1: "held", q2: "next" });
    await until(() => at.r.starts().length === 2, "the message sent");
    expect(at.r.starts()).toEqual(["question", "third"]);
    expect(stages(at.r)).toEqual({ q1: "held" });
  });

  it("starting, send now on a message behind it: the one taken comes back on hold unsaved, and the other goes", async () => {
    const at = await taken();
    await at.r.h["queue.add"](at.r.entry("q2", "third"), { clientId: ME });
    expect(await at.r.h["reply.now"]({ id: "q2" }, { clientId: OTHER })).toMatchObject({ answer: "done", reply: { id: "q2", stage: "next" } });
    expect(stages(at.r)).toEqual({ q1: "held", q2: "next" });
    at.r.open();
    await until(() => at.r.starts().length === 1, "the message sent");
    expect(at.r.starts()).toEqual(["third"]);
    expect(at.r.db.getMessage("m-q1")).toBeUndefined();
    expect(stages(at.r)).toEqual({ q1: "held" });
  });

  it("ended, stop: the answer is too late, and still a message that went out behind it by Send now comes back unsaved and the rest holds", async () => {
    const r = rig();
    const first = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: ME });
    await r.h["queue.add"](r.entry("q1", "second"), { clientId: ME });
    await r.h["reply.hold"]({ id: "q1" }, { clientId: ME });
    r.openOne();
    await until(() => over({ r, turnId: first.turnId }), "the first reply's end");
    await settle();
    // the reply has ended on its own; Send now takes the held message, and one more waits behind it
    await r.h["reply.now"]({ id: "q1" }, { clientId: ME });
    await until(() => q1(r)?.sending !== undefined, "the message taken");
    await r.h["queue.add"](r.entry("q2", "third"), { clientId: ME });
    expect(stages(r)).toEqual({ q1: "starting", q2: "queued" });
    expect(await r.h["reply.stop"]({ id: first.turnId }, { clientId: OTHER })).toMatchObject({ answer: "gone", why: "sent", question: { content: "first" } });
    expect(stages(r)).toEqual({ q1: "held", q2: "held" });
    r.open();
    await settle();
    expect(r.starts()).toEqual(["first"]);
    expect(r.db.getMessage("m-q1")).toBeUndefined();
    expect(stages(r)).toEqual({ q1: "held", q2: "held" });
  });

  it("no reply by that id, stop: answered as unknown, and nothing waiting changes", async () => {
    const r = await behind();
    const before = r.queued();
    expect(await r.h["reply.stop"]({ id: "no-such-turn" }, { clientId: ME })).toEqual({ answer: "gone", why: "unknown" });
    expect(r.queued()).toEqual(before);
  });
});

describe("a server event on a reply at each stage", () => {
  it("stopping, its end: the saved reply ends at the moment of the Stop, so its seconds are the record's in every window", async () => {
    const at = await reach.stopping();
    const stopped = at.r.record(at.turnId);
    await until(() => over(at), "the stopped reply's end");
    const end = at.r.events(at.turnId).findLast((e) => e.type === "error");
    expect(end?.ended).toEqual({ reason: "stopped", at: stopped?.stoppedAt });
    const saved = at.r.db.getThread(at.r.thread.id).messages.find((m) => m.role === "assistant");
    expect(saved).toMatchObject({ content: "some words", interrupted: true });
    expect(saved?.times?.startedAt).toBe(stopped?.startedAt);
    expect(saved?.times?.ended).toEqual({ reason: "stopped", at: stopped?.stoppedAt });
  });

  it("starting, stopped before it began: it ends stopped at the moment of the Stop and nothing of a reply is saved", async () => {
    const at = await reach.starting();
    await at.r.h["chat.cancel"]({ turnId: at.turnId }, { clientId: 1 });
    const stopped = at.r.record(at.turnId);
    at.r.open();
    await until(() => over(at), "the stopped send's end");
    expect(at.r.events(at.turnId).some((e) => e.type === "start")).toBe(false);
    expect(at.r.db.getThread(at.r.thread.id).messages.filter((m) => m.role === "assistant")).toEqual([]);
    expect(stopped?.stage).toBe("stopping");
  });

  it("writing, its last word: the record ends and carries no Stop", async () => {
    const at = await reach.writing();
    at.r.finish();
    await until(() => over(at), "the reply's end");
    expect(at.r.events(at.turnId).findLast((e) => e.type === "done")?.message.times?.ended.reason).toBe("done");
    expect(at.r.record(at.turnId)?.stoppedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the two tables, cell by cell
// The record module alone: one record at each stage, one call or one event, and the answer and
// the record that follow. A cell that names no change must give back the very same record.

const WORDS: Words = { messageId: "m1", text: "words", at: 1 };
const QUESTION: Message = { id: "m1", threadId: "t1", role: "user", content: "words", createdAt: 2 };
const unsavedPart = { id: "q1", threadId: "t1", rev: 7, words: WORDS, behind: "reply" as const, starts: 0, direct: false };
const askedPart = { id: "q1", threadId: "t1", rev: 7, turnId: "turn-1", question: QUESTION, model: MODEL, try: 1 };
const overPart = { id: "q1", threadId: "t1", rev: 7, at: 9, turnId: "turn-1", questionId: "m1" };

/** One record at every stage; "no record" is a message the server has never heard of. */
const AT = {
  "no record": undefined,
  "queued": { ...unsavedPart, stage: "queued", waitFor: "reply" },
  "held": { ...unsavedPart, stage: "held", why: { why: "failed" } },
  "editing (this window)": { ...unsavedPart, stage: "editing", by: 1, back: { stage: "queued", waitFor: "reply" } },
  "editing (another window)": { ...unsavedPart, stage: "editing", by: 2, back: { stage: "queued", waitFor: "reply" } },
  "next": { ...unsavedPart, stage: "next" },
  "starting": { ...unsavedPart, starts: 1, stage: "starting", turnId: "turn-1", attempt: 1, startedAt: 5, now: false, loading: false, retry: false },
  "loading": { ...askedPart, stage: "loading", calls: [], heard: false },
  "thinking": { ...askedPart, stage: "thinking", calls: [], heard: true },
  "tool": { ...askedPart, stage: "tool", calls: ["c1"], heard: true },
  "writing": { ...askedPart, stage: "writing", calls: [], heard: true },
  "drawing": { ...askedPart, stage: "drawing" },
  "stopping": { ...askedPart, stage: "stopping", stoppedAt: 8, drawing: false },
  "done": { ...overPart, stage: "done", replyId: "a1" },
  "stopped": { ...overPart, stage: "stopped", by: { who: "person" } },
  "failed": { ...overPart, stage: "failed", code: "internal", message: "it broke" },
  "removed": { id: "q1", threadId: "t1", rev: 7, stage: "removed", why: "removed" },
} as const satisfies Record<string, Rec | undefined>;
type Stood = keyof typeof AT;
const ROWS = Object.keys(AT) as Stood[];
const LIVE_ROWS = ["loading", "thinking", "tool", "writing"] as const satisfies readonly Stood[];
const ENDED_ROWS = ["done", "stopped", "failed"] as const satisfies readonly Stood[];

const FREE = { deleting: false, closing: false, busy: false };
const asQueued: Queued = { ...unsavedPart, rev: 0, stage: "queued", waitFor: "reply" };
/** Every call, made by window 1. */
const CALLS = {
  "send (same id again)": { call: "send", record: asQueued, chat: FREE, saved: false },
  "change": { call: "change", base: "m1", messageId: "m2", words: { text: "new words" }, by: 1, baseSaved: false },
  "open edit": { call: "edit", open: true, by: 1 },
  "close edit": { call: "edit", open: false, by: 1 },
  "remove": { call: "remove" },
  "send now": { call: "now", stops: true },
  "hold": { call: "hold" },
  "stop": { call: "stop", at: 20 },
} as const satisfies Record<string, Asked>;
type CallName = keyof typeof CALLS;

/** What a cell says: the answer, and the stage that follows ("same": the very same record; "none": still no record). */
type Cell = readonly [answer: "done" | "sending" | "elsewhere" | "gone sent" | "gone removed" | "gone unknown", next: Stage | "same" | "none"];
const all = (cell: Cell, but: Partial<Record<CallName, Cell>> = {}): Record<CallName, Cell> => ({
  "send (same id again)": cell, "change": cell, "open edit": cell, "close edit": cell, "remove": cell, "send now": cell, "hold": cell, "stop": cell, ...but,
});
/** A send of an id the server has not heard of, with this about its chat and its start. */
const send = (with_: Partial<Extract<Asked, { call: "send" }>>) => move(undefined, { ...CALLS["send (same id again)"], ...with_ });
const LIVE_CELLS = all(["sending", "same"], { stop: ["done", "stopping"] });
const ENDED_CELLS = all(["gone sent", "same"]);
const TABLE_1: Record<Stood, Record<CallName, Cell>> = {
  // a send with an id the server has not heard of makes the record (the cases below say which stage)
  "no record": all(["gone unknown", "none"], { "send (same id again)": ["done", "queued"] }),
  "queued": { "send (same id again)": ["done", "same"], "change": ["done", "queued"], "open edit": ["done", "editing"], "close edit": ["done", "same"], "remove": ["done", "removed"], "send now": ["done", "next"], "hold": ["done", "held"], "stop": ["done", "held"] },
  "held": { "send (same id again)": ["done", "same"], "change": ["done", "held"], "open edit": ["done", "editing"], "close edit": ["done", "same"], "remove": ["done", "removed"], "send now": ["done", "next"], "hold": ["done", "same"], "stop": ["done", "same"] },
  "editing (this window)": { "send (same id again)": ["done", "same"], "change": ["done", "queued"], "open edit": ["done", "same"], "close edit": ["done", "queued"], "remove": ["done", "removed"], "send now": ["done", "next"], "hold": ["done", "editing"], "stop": ["done", "editing"] },
  "editing (another window)": { "send (same id again)": ["done", "same"], "change": ["elsewhere", "same"], "open edit": ["elsewhere", "same"], "close edit": ["elsewhere", "same"], "remove": ["done", "removed"], "send now": ["done", "next"], "hold": ["done", "editing"], "stop": ["done", "editing"] },
  "next": { "send (same id again)": ["done", "same"], "change": ["done", "next"], "open edit": ["done", "editing"], "close edit": ["done", "same"], "remove": ["done", "removed"], "send now": ["done", "same"], "hold": ["done", "held"], "stop": ["done", "held"] },
  "starting": all(["sending", "same"], { "send (same id again)": ["done", "same"], "stop": ["done", "held"] }),
  "loading": LIVE_CELLS, "thinking": LIVE_CELLS, "tool": LIVE_CELLS, "writing": LIVE_CELLS, "drawing": LIVE_CELLS,
  "stopping": all(["sending", "same"], { stop: ["done", "same"] }),
  "done": ENDED_CELLS, "stopped": ENDED_CELLS, "failed": ENDED_CELLS,
  "removed": all(["gone removed", "same"]),
};

describe("table 1: every call on a record at every stage", () => {
  const cells = ROWS.flatMap((row) => (Object.keys(CALLS) as CallName[]).map((name) => [row, name, ...TABLE_1[row][name]] as const));
  it.each(cells)("%s × %s: answered %s, then %s", (row, name, answer, next) => {
    const rec: Rec | undefined = AT[row];
    const moved = move(rec, CALLS[name]);
    const said = moved.answer;
    expect(said?.answer === "gone" ? `gone ${said.why}` : said?.answer).toBe(answer);
    if (next === "none") expect(moved.next).toBeUndefined();
    else if (next === "same") expect(moved.next).toBe(rec);
    else {
      expect(moved.next?.stage).toBe(next);
      expect(moved.next).not.toBe(rec);
    }
    // the store numbers a change; the table never does
    if (moved.next !== undefined && rec !== undefined) expect(moved.next.rev).toBe(rec.rev);
    // "done" and "sending" and "elsewhere" carry the record as it now is; a remove, as it was
    if (said !== undefined && said.answer !== "gone") expect(said.record).toBe(name === "remove" && answer === "done" ? rec : moved.next);
    if (said?.answer === "gone" && said.why === "sent") expect(said.questionId).toBe("m1");
  });

  it("a change gives the record its new words in the stage it was in, and an edit's save gives the message back", () => {
    for (const row of ["queued", "held", "next", "editing (this window)"] as const) {
      const next = move(AT[row], CALLS.change).next;
      expect(next).toMatchObject({ words: { messageId: "m2", text: "new words", at: 1 }, starts: 0 });
    }
    expect(move(AT.held, CALLS.change).next).toMatchObject({ stage: "held", why: { why: "failed" } });
  });
  it("a change from older words is answered elsewhere, the same change again is done, and a new model alone leaves an edit open", () => {
    expect(move(AT.queued, { ...CALLS.change, base: "m0" })).toMatchObject({ answer: { answer: "elsewhere" }, next: AT.queued });
    const once = move(AT.queued, CALLS.change).next;
    expect(move(once, CALLS.change)).toMatchObject({ answer: { answer: "done" }, next: once });
    expect(move(AT["editing (this window)"], { ...CALLS.change, words: { model: "other" } }).next).toMatchObject({ stage: "editing", by: 1, words: { model: "other", messageId: "m2" } });
  });
  it("a change for a message the server does not know, whose words are saved in the chat: gone, sent", () => {
    expect(move(undefined, { ...CALLS.change, baseSaved: true })).toEqual({ answer: { answer: "gone", why: "sent", questionId: "m1" }, next: undefined });
  });
  it("an edit keeps where the message returns: a hold keeps its reason, Send now keeps its yes", () => {
    const consent = { kind: "named", replies: ["r1"] } as const;
    const next = move(AT.queued, { call: "now", consent, stops: false }).next;
    const open = move(next, CALLS["open edit"]).next;
    expect(open).toMatchObject({ stage: "editing", by: 1, back: { stage: "next", consent } });
    expect(move(open, CALLS["close edit"]).next).toEqual(next);
    expect(move(move(AT.held, CALLS["open edit"]).next, CALLS["close edit"]).next).toEqual(AT.held);
    // on hold while open: it returns on hold
    expect(move(move(AT["editing (this window)"], CALLS.hold).next, CALLS["close edit"]).next).toMatchObject({ stage: "held", why: { why: "stopped" } });
  });
  it("the older calls: an edit is taken over and ended by any window, and a change checks nothing", () => {
    expect(move(AT["editing (another window)"], { call: "edit", open: true, by: 1, older: true }).next).toMatchObject({ stage: "editing", by: 1 });
    expect(move(AT["editing (another window)"], { call: "edit", open: false, by: 1, older: true }).next).toMatchObject({ stage: "queued" });
    expect(move(AT["editing (another window)"], { ...CALLS.change, base: "m0", older: true }).next).toMatchObject({ stage: "editing", by: 2, words: { text: "new words" } });
  });
  it("Send now: a new yes replaces the old one, and the reply on its way in its chat is stopped in the same step", () => {
    const consent = { kind: "standing" } as const;
    expect(move(AT.next, { call: "now", consent, stops: true })).toMatchObject({ next: { stage: "next", consent }, stopChat: true });
    expect(move(AT.queued, CALLS["send now"]).stopChat).toBe(true);
    expect(move(AT.queued, { call: "now", stops: false }).stopChat).toBeUndefined();
    expect(move(AT.starting, CALLS["send now"]).stopChat).toBeUndefined();
  });
  it("Stop: a start is cut and its message is back on hold at once, a reply stands at the Stop, and both hold what waits in the chat", () => {
    expect(move(AT.starting, CALLS.stop)).toMatchObject({ next: { stage: "held", why: { why: "stopped" }, behind: "reply", starts: 1 }, ahead: "stopped", cut: { turnId: "turn-1", at: 20 } });
    for (const row of [...LIVE_ROWS, "drawing"] as const) {
      expect(move(AT[row], CALLS.stop)).toMatchObject({ next: { stage: "stopping", stoppedAt: 20, turnId: "turn-1", question: QUESTION, drawing: row === "drawing" }, ahead: "stopped", cut: { turnId: "turn-1", at: 20 } });
    }
    // asked again: the first Stop's moment stands and nothing is cut twice
    expect(move(AT.stopping, CALLS.stop)).toEqual({ answer: { answer: "done", record: AT.stopping }, next: AT.stopping });
    // a hold of a waiting message cuts nothing and holds nothing else
    expect(move(AT.queued, CALLS.stop)).toEqual({ answer: { answer: "done", record: { ...AT.queued, stage: "held", why: { why: "stopped" }, waitFor: undefined } }, next: expect.anything() });
  });
  it("a late Stop: the reply had ended, and what waits in its chat still holds", () => {
    for (const row of ENDED_ROWS) expect(move(AT[row], CALLS.stop)).toEqual({ answer: { answer: "gone", why: "sent", questionId: "m1" }, next: AT[row], ahead: "late-stop" });
    for (const row of ENDED_ROWS) expect(move(AT[row], CALLS.hold).ahead).toBeUndefined();
    expect(move(AT.removed, CALLS.stop).ahead).toBeUndefined();
  });

  describe("a send with an id the server has not heard of", () => {
    const start = { turnId: "turn-1", at: 5, retry: false };
    it("its chat is being deleted: gone, chat deleted", () => {
      expect(send({ chat: { ...FREE, deleting: true }, start })).toEqual({ answer: { answer: "gone", why: "chat-deleted" }, next: undefined });
    });
    it("its question is already saved: gone, sent, and nothing is queued", () => {
      expect(send({ saved: true, start })).toEqual({ answer: { answer: "gone", why: "sent", questionId: "m1" }, next: undefined });
    });
    it("the app is closing: kept on hold for the restart", () => {
      expect(send({ chat: { ...FREE, closing: true }, start }).next).toMatchObject({ stage: "held", why: { why: "restart" } });
    });
    it("a start is offered and its chat has nothing running: starting, its first start", () => {
      expect(send({ start }).next).toMatchObject({ stage: "starting", turnId: "turn-1", attempt: 1, starts: 1, startedAt: 5, now: false, loading: false, retry: false });
    });
    it("its chat has a reply on its way, or no start is offered: queued", () => {
      expect(send({ chat: { ...FREE, busy: true }, start }).next).toMatchObject({ stage: "queued", waitFor: "reply" });
      expect(send({}).next).toMatchObject({ stage: "queued", waitFor: "reply" });
    });
    it("asked for on hold or as next: made so", () => {
      expect(send({ record: { ...unsavedPart, stage: "held", why: { why: "stopped" } } }).next).toMatchObject({ stage: "held" });
      expect(send({ record: { ...unsavedPart, stage: "next" } }).next).toMatchObject({ stage: "next" });
    });
  });
});

const WHY = { code: "wont-fit", message: "it does not fit" };
/** Every server event; turn-1 is the start the records above were taken for. */
const EVENTS = {
  "the picker takes it": { event: "take", turnId: "turn-2", at: 30 },
  "its model is loading": { event: "load", turnId: "turn-1" },
  "its start work ends well": { event: "start", turnId: "turn-1", attempt: 1, question: QUESTION, model: MODEL, cold: false, drawing: false },
  "its start work ends well, its model cold": { event: "start", turnId: "turn-1", attempt: 1, question: QUESTION, model: MODEL, cold: true, drawing: false },
  "its start work ends well, for a picture": { event: "start", turnId: "turn-1", attempt: 1, question: QUESTION, model: "preset", cold: false, drawing: true },
  "an older start's work ends well": { event: "start", turnId: "turn-0", attempt: 0, question: QUESTION, model: MODEL, cold: false, drawing: false },
  "its start is refused": { event: "refuse", turnId: "turn-1", attempt: 1, why: WHY },
  "an older start is refused": { event: "refuse", turnId: "turn-0", attempt: 0, why: WHY },
  "a call starts": { event: "tool", turnId: "turn-1", callId: "c2", running: true },
  "its call ends": { event: "tool", turnId: "turn-1", callId: "c1", running: false },
  "thinking comes": { event: "think", turnId: "turn-1" },
  "a word comes": { event: "word", turnId: "turn-1" },
  "it fails and runs once more": { event: "retry", turnId: "turn-1" },
  "its last word": { event: "end", turnId: "turn-1", at: 40, end: { how: "done", replyId: "a1" } },
  "it fails for good": { event: "end", turnId: "turn-1", at: 40, end: { how: "failed", code: "internal", message: "it broke" } },
  "another load needs its memory": { event: "end", turnId: "turn-1", at: 40, end: { how: "stopped", by: { who: "preempted", neededBy: "other" } } },
  "the runtime changes": { event: "end", turnId: "turn-1", at: 40, end: { how: "stopped", by: { who: "runtime" } } },
  "another turn's last word": { event: "end", turnId: "turn-0", at: 40, end: { how: "done" } },
  "the reply before it is stopped": { event: "ahead", what: "stopped" },
  "a late Stop names the reply before it": { event: "ahead", what: "late-stop" },
  "the reply before it runs once more": { event: "ahead", what: "retry" },
  "the reply before it fails twice": { event: "ahead", what: "failed" },
  "the reply before it ends well": { event: "ahead", what: "done" },
  "the app restarts": { event: "restart", at: 50 },
  "its chat is deleted": { event: "chat-deleted" },
  "its question is found saved": { event: "saved" },
  "its work has left": { event: "left", turnId: "turn-1", at: 60 },
  "another turn's work has left": { event: "left", turnId: "turn-0", at: 60 },
} as const satisfies Record<string, Event>;
type EventName = keyof typeof EVENTS;

/** The stage after, with what else must be so; a cell not written here changes nothing. */
type Then = Stage | readonly [Stage, Record<string, unknown>];
const liveTo = (to: Then, but: Partial<Record<Stood, Then>> = {}): Partial<Record<Stood, Then>> => ({ loading: to, thinking: to, tool: to, writing: to, ...but });
const waitingBehind = (to: Then, back: Record<string, unknown>): Partial<Record<Stood, Then>> =>
  ({ "queued": to, "editing (this window)": ["editing", { back }], "editing (another window)": ["editing", { back }] });
const HELD_RESTART: Then = ["held", { why: { why: "restart" }, behind: "reply" }];
const BY_CLOSING: Then = ["stopped", { by: { who: "closing" }, questionId: "m1" }];
const LEFT_UNFINISHED: Then = ["failed", { code: "internal", questionId: "m1", at: 60, turnId: "turn-1" }];
const TABLE_2: Record<EventName, Partial<Record<Stood, Then>>> = {
  "the picker takes it": { queued: ["starting", { turnId: "turn-2", attempt: 1, starts: 1, startedAt: 30, now: false }], next: ["starting", { turnId: "turn-2", attempt: 1, now: true }] },
  "its model is loading": { starting: ["starting", { loading: true }] },
  "its start work ends well": { starting: ["thinking", { heard: false, try: 1, question: QUESTION, turnId: "turn-1" }] },
  "its start work ends well, its model cold": { starting: ["loading", { heard: false, calls: [] }] },
  "its start work ends well, for a picture": { starting: ["drawing", { model: "preset" }] },
  "an older start's work ends well": {},
  "its start is refused": { starting: ["held", { why: { why: "refused", ...WHY }, behind: "reply", starts: 1 }] },
  "an older start is refused": {},
  "a call starts": liveTo(["tool", { heard: true }], { tool: ["tool", { calls: ["c1", "c2"] }] }),
  "its call ends": { loading: ["thinking", { heard: true }], tool: ["thinking", { calls: [] }], writing: "thinking" },
  "thinking comes": { loading: ["thinking", { heard: true }], writing: "thinking" },
  "a word comes": { loading: ["writing", { heard: true }], thinking: "writing" },
  "it fails and runs once more": liveTo(["thinking", { try: 2, calls: [], heard: true }], { loading: ["loading", { try: 2 }] }),
  "its last word": { ...liveTo(["done", { at: 40, questionId: "m1", replyId: "a1", turnId: "turn-1" }]), drawing: "done", stopping: "done" },
  "it fails for good": { ...liveTo(["failed", { at: 40, code: "internal", message: "it broke", questionId: "m1" }]), drawing: "failed", stopping: ["stopped", { by: { who: "person" }, at: 8 }] },
  "another load needs its memory": { ...liveTo(["stopped", { by: { who: "preempted", neededBy: "other" }, at: 40 }]), drawing: "stopped", stopping: ["stopped", { by: { who: "person" }, at: 8 }] },
  "the runtime changes": { ...liveTo(["stopped", { by: { who: "runtime" } }]), drawing: "stopped", stopping: ["stopped", { by: { who: "person" } }] },
  "another turn's last word": {},
  "the reply before it is stopped": waitingBehind(["held", { why: { why: "stopped" } }], { stage: "held", why: { why: "stopped" } }),
  "a late Stop names the reply before it": { ...waitingBehind(["held", { why: { why: "stopped" } }], { stage: "held", why: { why: "stopped" } }), starting: ["held", { why: { why: "stopped" }, behind: "reply" }] },
  "the reply before it runs once more": waitingBehind(["queued", { waitFor: "retry" }], { stage: "queued", waitFor: "retry" }),
  "the reply before it fails twice": waitingBehind(["held", { why: { why: "failed" } }], { stage: "held", why: { why: "failed" } }),
  "the reply before it ends well": {},
  "the app restarts": {
    // on hold behind a reply that failed twice: that reply went with the closed app, so the hold says the restart
    "held": HELD_RESTART,
    "queued": HELD_RESTART, "next": HELD_RESTART, "editing (this window)": HELD_RESTART, "editing (another window)": HELD_RESTART, "starting": HELD_RESTART,
    "loading": BY_CLOSING, "thinking": BY_CLOSING, "tool": BY_CLOSING, "writing": BY_CLOSING, "drawing": BY_CLOSING, "stopping": ["stopped", { by: { who: "closing" }, at: 8 }],
  },
  "its chat is deleted": Object.fromEntries(ROWS.filter((row) => row !== "no record" && row !== "removed").map((row) => [row, ["removed", { why: "chat-deleted" }] as const])),
  "its question is found saved": { "queued": ["done", { questionId: "m1" }], "held": "done", "next": "done", "editing (this window)": "done", "editing (another window)": "done" },
  // the work is gone and never said how it ended: no record stays on its way without its work
  "its work has left": {
    starting: ["held", { why: { why: "refused", code: "internal" }, behind: "reply", starts: 1 }],
    ...liveTo(LEFT_UNFINISHED), drawing: LEFT_UNFINISHED, stopping: LEFT_UNFINISHED,
  },
  "another turn's work has left": {},
};

describe("table 2: every server event on a record at every stage", () => {
  const cells = (Object.keys(EVENTS) as EventName[]).flatMap((name) => ROWS.map((row) => {
    const after = TABLE_2[name][row];
    return [name, row, after === undefined ? "nothing changes" : typeof after === "string" ? after : after[0]] as const;
  }));
  it.each(cells)("%s × %s: %s", (name, row) => {
    const rec: Rec | undefined = AT[row];
    const moved = move(rec, EVENTS[name]);
    const after = TABLE_2[name][row];
    // an event answers no one
    expect(moved.answer).toBeUndefined();
    if (after === undefined) {
      expect(moved.next).toBe(rec);
      expect(moved.ahead).toBeUndefined();
      expect(moved.cut).toBeUndefined();
      return;
    }
    expect(moved.next).not.toBe(rec);
    expect(moved.next).toMatchObject({ id: "q1", threadId: "t1", rev: 7, stage: typeof after === "string" ? after : after[0], ...(typeof after === "string" ? {} : after[1]) });
  });

  it("what a reply's own event tells the messages behind it in its chat", () => {
    const told = (name: EventName, row: Stood) => move(AT[row], EVENTS[name]).ahead;
    expect(told("its start is refused", "starting")).toBe("stopped");
    expect(told("it fails and runs once more", "writing")).toBe("retry");
    expect(told("its last word", "writing")).toBe("done");
    // a Stop that lost to the last word: the reply is done, and what waited was held at the Stop
    expect(told("its last word", "stopping")).toBe("stopped");
    expect(told("another load needs its memory", "thinking")).toBe("stopped");
    expect(told("the runtime changes", "tool")).toBe("stopped");
    // only a second failure is said on what waits: a first one that cannot run again holds it as a Stop does
    expect(told("it fails for good", "writing")).toBe("stopped");
    expect(move({ ...AT.writing, try: 2 }, EVENTS["it fails for good"]).ahead).toBe("failed");
    expect(told("it fails for good", "stopping")).toBe("stopped");
  });
  it("a start pulled back by a late Stop, and a reply in a chat being deleted, have their work cut", () => {
    expect(move(AT.starting, EVENTS["a late Stop names the reply before it"]).cut).toEqual({ turnId: "turn-1" });
    for (const row of ["starting", ...LIVE_ROWS, "drawing", "stopping"] as const) expect(move(AT[row], EVENTS["its chat is deleted"]).cut).toEqual({ turnId: "turn-1" });
    expect(move(AT.queued, EVENTS["its chat is deleted"]).cut).toBeUndefined();
  });
  it("a message that waited behind a second try goes on when that try ends well, and holds when it fails", () => {
    const waits = move(AT.queued, EVENTS["the reply before it runs once more"]).next;
    expect(move(waits, EVENTS["the reply before it ends well"]).next).toEqual(AT.queued);
    expect(move(waits, EVENTS["the reply before it fails twice"]).next).toMatchObject({ stage: "held", why: { why: "failed" } });
    // a message a person put on hold is never released by a reply's second try
    expect(move(AT.held, EVENTS["the reply before it runs once more"]).next).toBe(AT.held);
    expect(move(AT.next, EVENTS["the reply before it is stopped"]).next).toBe(AT.next);
  });
  it("a refused Retry of a question already in the chat fails: it has no place to go back to", () => {
    expect(move({ ...AT.starting, retry: true }, EVENTS["its start is refused"]).next).toMatchObject({ stage: "failed", ...WHY, turnId: "turn-1" });
  });
  it("the second start of a message is its attempt 2, and the work of its first start changes nothing", () => {
    const back = move(AT.starting, CALLS.stop).next;
    const again = move(move(back, { call: "now", stops: false }).next, EVENTS["the picker takes it"]).next;
    expect(again).toMatchObject({ stage: "starting", turnId: "turn-2", attempt: 2, starts: 2, now: true });
    expect(move(again, EVENTS["its start work ends well"]).next).toBe(again);
    expect(move(again, EVENTS["its start is refused"]).next).toBe(again);
    expect(stillStarting(again, "turn-1", 1)).toBe(false);
    expect(stillStarting(again, "turn-2", 2)).toBe(true);
    expect(stillStarting(back, "turn-1", 1)).toBe(false);
    expect(stillStarting(undefined, "turn-1", 1)).toBe(false);
  });
  it("a send from a window that keeps its own words leaves no record waiting once its stopped or refused start has left", () => {
    const direct = { ...AT.starting, direct: true };
    expect(move(move(direct, CALLS.stop).next, EVENTS["its work has left"]).next).toMatchObject({ stage: "stopped", by: { who: "person" }, at: 60 });
    expect(move(move(direct, EVENTS["its start is refused"]).next, EVENTS["its work has left"]).next).toMatchObject({ stage: "failed", ...WHY });
  });
  it("work that left without saying how it ended: what waited behind it holds, and a start with no place in the queue fails", () => {
    for (const row of ["starting", ...LIVE_ROWS, "drawing", "stopping"] as const) expect(move(AT[row], EVENTS["its work has left"]).ahead).toBe("stopped");
    expect(move({ ...AT.starting, direct: true }, EVENTS["its work has left"]).next).toMatchObject({ stage: "failed", code: "internal", at: 60, turnId: "turn-1" });
    expect(move({ ...AT.starting, retry: true }, EVENTS["its work has left"]).next).toMatchObject({ stage: "failed", code: "internal" });
    // a message the server lists, on hold: its stopped start leaving changes nothing
    const back = move(AT.starting, CALLS.stop).next;
    expect(move(back, EVENTS["its work has left"]).next).toBe(back);
  });
  it("a restart keeps the reason of a hold a person or a refusal made, and what it waited behind is over", () => {
    const stopped = { ...AT.held, why: { why: "stopped" } } as const;
    expect(move(stopped, EVENTS["the app restarts"]).next).toBe(stopped);
    const refused = { ...AT.held, behind: "download", why: { why: "refused", ...WHY } } as const;
    expect(move(refused, EVENTS["the app restarts"]).next).toEqual({ ...refused, behind: "reply" });
    // a reply cut by the Stop before the app closed keeps that Stop's moment
    expect(move(AT.stopping, EVENTS["the app restarts"]).next).toMatchObject({ at: 8 });
    expect(move(AT.writing, EVENTS["the app restarts"]).next).toMatchObject({ at: 50 });
  });
  it("what a turn's stream sends, as the record's events: text with no words in it is none", () => {
    expect(heardAs("turn-1", { type: "thinking", text: "hm" })).toEqual(EVENTS["thinking comes"]);
    expect(heardAs("turn-1", { type: "delta", text: "a" })).toEqual(EVENTS["a word comes"]);
    expect(heardAs("turn-1", { type: "delta", text: "" })).toBeUndefined();
    expect(heardAs("turn-1", { type: "thinking", text: "" })).toBeUndefined();
    expect(heardAs("turn-1", { type: "tool", step: { callId: "c2", state: "running" } })).toEqual(EVENTS["a call starts"]);
    expect(heardAs("turn-1", { type: "tool", step: { callId: "c1", state: "done" } })).toEqual(EVENTS["its call ends"]);
  });
});

describe("the older shapes are made from the record", () => {
  const row: QueuedMessage = { id: "q1", threadId: "t1", messageId: "m1", text: "words", at: 1, waitFor: "setup", model: MODEL, numCtx: 8192 };
  const why = { code: "wont-fit", message: "it does not fit" };
  it.each<readonly [string, Partial<QueuedMessage>, Stage]>([
    ["waiting", {}, "queued"],
    ["on hold", { held: true }, "held"],
    ["on hold, refused", { held: true, why }, "held"],
    ["on hold behind a reply that failed twice", { held: true, retry: "failed" }, "held"],
    ["waiting while the reply before it runs once more", { held: true, retry: "running" }, "queued"],
    ["going next", { now: true }, "next"],
    ["going next with a standing yes", { now: true, stopOthers: true }, "next"],
    ["going next with a yes for named replies", { now: true, stopOthers: true, stopTurns: ["r1"] }, "next"],
  ])("a queue row %s is one stage, and the row made from that record is the same row", (_name, flags, stage) => {
    const rec = fromQueued({ ...row, ...flags });
    expect(rec.stage).toBe(stage);
    expect(toQueued(rec)).toEqual({ ...row, ...flags });
  });
  it("a row with flags that disagree is still one stage: Send now wins over a hold", () => {
    expect(fromQueued({ ...row, now: true, held: true, retry: "failed" })).toMatchObject({ stage: "next" });
    expect(toQueued(fromQueued({ ...row, now: true, held: true, retry: "failed" }))).toEqual({ ...row, now: true });
  });
  it("each stage's row: an edit keeps its place's flags, a start says its turn, and a reply being answered is on no list", () => {
    expect(toQueued(AT.queued)).toEqual({ id: "q1", threadId: "t1", ...WORDS, waitFor: "reply" });
    expect(toQueued(AT.held)).toEqual({ id: "q1", threadId: "t1", ...WORDS, waitFor: "reply", held: true, retry: "failed" });
    expect(toQueued(AT["editing (this window)"])).toEqual({ id: "q1", threadId: "t1", ...WORDS, waitFor: "reply", editing: true });
    expect(toQueued(move(AT.queued, EVENTS["the reply before it runs once more"]).next!)).toMatchObject({ held: true, retry: "running" });
    expect(toQueued(AT.starting)).toEqual({ id: "q1", threadId: "t1", ...WORDS, waitFor: "reply", sending: "turn-1" });
    expect(toQueued({ ...AT.starting, now: true, consent: { kind: "standing" } })).toMatchObject({ now: true, stopOthers: true, sending: "turn-1" });
    expect(toQueued({ ...AT.starting, direct: true })).toBeUndefined();
    for (const stage of [...LIVE_ROWS, "drawing", "stopping", ...ENDED_ROWS, "removed"] as const) expect(toQueued(AT[stage])).toBeUndefined();
  });
  it("the stage a turn's older record says", () => {
    expect(shownStage(AT.starting)).toBe("waiting");
    expect(shownStage({ ...AT.starting, loading: true })).toBe("loading");
    expect(shownStage(AT.loading)).toBe("loading");
    // its model is in memory and has said nothing yet
    expect(shownStage({ ...AT.thinking, heard: false })).toBe("waiting");
    expect(shownStage(AT.thinking)).toBe("thinking");
    expect(shownStage(AT.tool)).toBe("tool");
    expect(shownStage(AT.writing)).toBe("writing");
    expect(shownStage(AT.stopping)).toBe("stopping");
    expect(shownStage(AT.drawing)).toBe("waiting");
  });
});
