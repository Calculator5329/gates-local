// The reply's stages as a table: a case per cell. Each case puts one reply at a stage, makes one
// call or lets one server event happen, and checks the answer and the stage that follows, as
// every window is told it.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message, Params, Payload, QueuedMessage, Reply, ReplyAnswer, ReplyChange, ReplyRecord, ReplyStage } from "@gates-local/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { MODEL, type Rig, type RigHooks, rig, settle, until } from "../../test/send-rig.ts";
import { AppError } from "../app.ts";
import { type Replies, type SendNow, type Sent, createReplies } from "./replies.ts";
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
  "drawing": { ...askedPart, stage: "drawing", jobs: ["job-1"] },
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
  "its start work ends well, for a picture": { event: "start", turnId: "turn-1", attempt: 1, question: QUESTION, model: "preset", cold: false, drawing: true, jobs: ["job-1"] },
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

// ---------------------------------------------------------------- table 3: what every window is sent
// A case per change: the store alone takes the steps, and the case checks each change it sent
// the windows (reply.changed), that their numbers only rise, and that a window connecting now
// (reply.list) reads every record as it was last sent.

const ROW: QueuedMessage = { id: "q1", threadId: "t1", messageId: "m1", text: "words", at: 1, waitFor: "reply", model: MODEL, numCtx: 8192 };
const ANSWER: Message = { id: "a1", threadId: "t1", role: "assistant", content: "answer", createdAt: 3 };
const WARM = { cold: false, drawing: false };

function telling() {
  const told: ReplyChange[] = [];
  const q: Replies = createReplies({
    log: () => undefined, changed: () => undefined, told: (c) => told.push(c), saved: () => undefined, deleting: () => false, closing: () => false,
    // as the app does: the work's clock stops at the cut, and its record is sent again
    cut: (turnId) => q.clocked(turnId),
    clock: () => ({ stage: "waiting", startedAt: 5, workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {} }),
  });
  return { q, told };
}
type Telling = ReturnType<typeof telling>;

/** One change as a case names it: the stage ("loading" for a start behind its model's load, "silent" for a model not heard from yet), the rows sent with it, or why it left. */
const sent = (c: ReplyChange): string => {
  if (c.kind === "left") return `left ${c.why}`;
  const loading = c.reply.stage === "starting" && c.reply.loading === true ? " loading" : "";
  const silent = "silent" in c.reply && c.reply.silent === true ? " silent" : "";
  const stopped = c.reply.stage === "drawing" && c.reply.stoppedAt !== undefined ? " stopped" : "";
  return `${c.reply.stage}${loading}${silent}${stopped}${c.saved === undefined ? "" : ` +${c.saved.length}`}`;
};

const waits = ({ q }: Telling) => { q.add(ROW); };
const starts = (t: Telling) => { waits(t); t.q.take("q1", "turn-1", 5); t.q.begun("turn-1"); };
const asked = (t: Telling, how = WARM) => { starts(t); t.q.started("turn-1", 1, QUESTION, MODEL, how); t.q.notify(); };
const writes = (t: Telling) => { asked(t); t.q.heard("turn-1", { type: "delta", text: "some" }); t.q.clocked("turn-1"); };
const mine = ({ q }: Telling, retry = false) => { q.direct("turn-1", "t1", WORDS, retry, 5); };
/** reply.send from a window: the message under the window's own id, and what the server has at that moment. */
const SAID: Params<"reply.send"> = { id: "q1", threadId: "t1", messageId: "m1", text: "words", model: MODEL, numCtx: 8192 };
const FREE_NOW: SendNow = { at: 5, behind: "reply", busy: false, turnId: "turn-1" };
const sends = ({ q }: Pick<Telling, "q">, more: Partial<Params<"reply.send">> = {}, now: Partial<SendNow> = {}) => q.send({ ...SAID, ...more }, { ...FREE_NOW, ...now });
const RETRY = { retryOf: "m0" };

const TOLD: Record<string, readonly [steps: (t: Telling) => void, told: readonly string[]]> = {
  "a message joins the list": [waits, ["queued"]],
  "the same message is sent again": [(t) => { waits(t); t.q.add(ROW); }, ["queued"]],
  "a waiting message is put on hold": [(t) => { waits(t); t.q.hold({ id: "q1" }); }, ["queued", "held"]],
  "a waiting message goes by Send now": [(t) => { waits(t); t.q.now({ id: "q1" }); }, ["queued", "next"]],
  "a waiting message is opened in a composer": [(t) => { waits(t); t.q.edit({ id: "q1", open: true }, 1); }, ["queued", "editing"]],
  "a waiting message gets new words": [(t) => { waits(t); t.q.change({ id: "q1", base: "m1", messageId: "m2", text: "new words" }, 1); }, ["queued", "queued"]],
  "a waiting message is removed": [(t) => { waits(t); t.q.remove({ id: "q1" }); }, ["queued", "left removed"]],
  "a waiting message's chat is deleted": [(t) => { waits(t); t.q.dropThread("t1"); }, ["queued", "left chat-deleted"]],
  "a waiting message is found asked": [(t) => { waits(t); t.q.sent("m1"); }, ["queued", "left settled"]],
  "a message is taken and its start is not answered yet": [(t) => { waits(t); t.q.take("q1", "turn-1", 5); }, ["queued"]],
  "a taken message's start work is under way": [starts, ["queued", "starting"]],
  "a taken message is refused before any work": [(t) => { waits(t); t.q.take("q1", "turn-1", 5); t.q.refused("turn-1", 1, WHY); t.q.notify(); }, ["queued", "held"]],
  "a start waits behind its model's load": [(t) => { starts(t); t.q.loading("turn-1"); t.q.clocked("turn-1"); }, ["queued", "starting", "starting loading"]],
  "a start is refused": [(t) => { starts(t); t.q.refused("turn-1", 1, WHY); t.q.notify(); }, ["queued", "starting", "held"]],
  "a start is stopped": [(t) => { starts(t); t.q.stop({ id: "q1" }); }, ["queued", "starting", "held"]],
  "a question is saved, its model in memory": [(t) => asked(t), ["queued", "starting", "thinking silent +1"]],
  "a question is saved, its model loading": [(t) => asked(t, { cold: true, drawing: false }), ["queued", "starting", "loading +1"]],
  "a picture's question is saved": [(t) => asked(t, { cold: false, drawing: true }), ["queued", "starting", "drawing +1"]],
  "a reply's first thought comes": [(t) => { asked(t); t.q.heard("turn-1", { type: "thinking", text: "hm" }); t.q.clocked("turn-1"); }, ["queued", "starting", "thinking silent +1", "thinking"]],
  "a reply's first word comes": [writes, ["queued", "starting", "thinking silent +1", "writing"]],
  "a reply calls a tool": [(t) => { asked(t); t.q.heard("turn-1", { type: "tool", step: { callId: "c1", state: "running" } }); t.q.clocked("turn-1"); }, ["queued", "starting", "thinking silent +1", "tool"]],
  "a reply's times change at the same stage": [(t) => { writes(t); t.q.clocked("turn-1"); }, ["queued", "starting", "thinking silent +1", "writing", "writing"]],
  "a reply runs once more": [(t) => { writes(t); t.q.retrying("turn-1"); }, ["queued", "starting", "thinking silent +1", "writing", "thinking"]],
  // the Stop, then the times as its cut left them
  "a reply is stopped": [(t) => { writes(t); t.q.stop({ id: "q1" }); }, ["queued", "starting", "thinking silent +1", "writing", "stopping", "stopping"]],
  // its engine may hold on a while: the windows hear the Stop was taken, on the record its cards belong to
  "a picture is stopped": [(t) => { asked(t, { cold: false, drawing: true }); t.q.stop({ id: "q1" }); }, ["queued", "starting", "drawing +1", "drawing stopped", "drawing stopped"]],
  "a reply ends well": [(t) => { writes(t); t.q.ended("turn-1", { how: "done", replyId: "a1" }, 9, [ANSWER]); t.q.notify(); }, ["queued", "starting", "thinking silent +1", "writing", "done +1"]],
  "a stopped reply ends with its words kept": [(t) => { writes(t); t.q.stop({ id: "q1" }); t.q.ended("turn-1", { how: "stopped", by: { who: "person" } }, 9, [ANSWER]); t.q.notify(); }, ["queued", "starting", "thinking silent +1", "writing", "stopping", "stopping", "stopped +1"]],
  "a reply fails with nothing written": [(t) => { asked(t); t.q.ended("turn-1", { how: "failed", code: "internal", message: "it broke" }, 9, [QUESTION]); t.q.notify(); }, ["queued", "starting", "thinking silent +1", "failed +1"]],
  "a reply's work leaves without a word": [(t) => { writes(t); t.q.left("turn-1"); }, ["queued", "starting", "thinking silent +1", "writing", "failed"]],
  "a reply starts and ends before the windows hear": [(t) => { starts(t); t.q.started("turn-1", 1, QUESTION, MODEL, WARM); t.q.ended("turn-1", { how: "done", replyId: "a1" }, 9, [ANSWER]); t.q.notify(); }, ["queued", "starting", "done +2"]],
  "a window's own send is taken": [(t) => mine(t), ["starting"]],
  "a window's own send is refused": [(t) => { mine(t); t.q.refused("turn-1", 1, WHY); t.q.notify(); }, ["starting", "left settled"]],
  "a window's own Retry is refused": [(t) => { mine(t, true); t.q.refused("turn-1", 1, WHY); t.q.notify(); }, ["starting", "failed"]],
  "a send waits behind its chat's reply": [(t) => { sends(t, {}, { busy: true }); }, ["queued"]],
  "a send waits for setup": [(t) => { sends(t, {}, { behind: "setup" }); }, ["queued"]],
  "a send is taken at once and its start is not answered yet": [(t) => { sends(t); }, []],
  "a send's start work is under way": [(t) => { sends(t); t.q.begun("turn-1"); }, ["starting"]],
  "a send is refused before any work": [(t) => { sends(t); t.q.refused("turn-1", 1, WHY); t.q.notify(); }, ["held"]],
  "a send's start is refused": [(t) => { sends(t); t.q.begun("turn-1"); t.q.refused("turn-1", 1, WHY); t.q.notify(); }, ["starting", "held"]],
  "a send's start is stopped": [(t) => { sends(t); t.q.begun("turn-1"); t.q.stop({ id: "q1" }); }, ["starting", "held"]],
  "a send's question is saved": [(t) => { sends(t); t.q.begun("turn-1"); t.q.started("turn-1", 1, QUESTION, MODEL, WARM); t.q.notify(); }, ["starting", "thinking silent +1"]],
  "a Retry's start work is under way": [(t) => { sends(t, RETRY); t.q.begun("turn-1"); }, ["starting"]],
  "a Retry is refused before any work": [(t) => { sends(t, RETRY); t.q.refused("turn-1", 1, WHY); t.q.notify(); }, ["failed"]],
  "a Retry's start is refused": [(t) => { sends(t, RETRY); t.q.begun("turn-1"); t.q.refused("turn-1", 1, WHY); t.q.notify(); }, ["starting", "failed"]],
  "a Retry's start is stopped, and its work leaves": [(t) => { sends(t, RETRY); t.q.begun("turn-1"); t.q.stop({ id: "q1" }); t.q.left("turn-1"); t.q.notify(); }, ["starting", "left settled", "left settled"]],
};

describe("table 3: what every window is sent as a record changes", () => {
  it.each(Object.entries(TOLD))("%s", (_name, [steps, told]) => {
    const t = telling();
    steps(t);
    expect(t.told.map(sent)).toEqual(told);
    // one counter: a later change never carries a lower number, and no two carry the same
    const revs = t.told.map((c) => (c.kind === "is" ? c.reply.rev : c.rev));
    expect(revs).toEqual([...new Set(revs)].toSorted((a, b) => a - b));
    // a window connecting now reads what the others were last sent: nothing ended, removed or settled
    const last = new Map(t.told.map((c) => [c.kind === "is" ? c.reply.id : c.id, c]));
    const listed = [...last.values()].flatMap((c) => c.kind === "is" && !["done", "stopped", "failed"].includes(c.reply.stage) ? [{ reply: c.reply }] : []);
    const read = t.q.records();
    // a start not answered yet is read as the start it is, ahead of the change that says so
    if (_name.includes("not answered yet")) expect(read).toMatchObject([{ reply: { id: "q1", stage: "starting" } }]);
    else expect(read).toEqual(listed);
  });

  it("an end carries what its record needs and the rows it saved", () => {
    const t = telling();
    writes(t);
    t.q.stop({ id: "q1" });
    t.q.ended("turn-1", { how: "stopped", by: { who: "person" } }, 9, [ANSWER]);
    t.q.notify();
    expect(t.told.at(-1)).toMatchObject({ kind: "is", reply: { id: "q1", threadId: "t1", stage: "stopped", questionId: "m1", replyId: "a1", by: { who: "person" } }, saved: [ANSWER] });
    const done = telling();
    writes(done);
    done.q.ended("turn-1", { how: "done", replyId: "a1" }, 9, [ANSWER]);
    done.q.notify();
    expect(done.told.at(-1)).toEqual({ kind: "is", reply: { id: "q1", threadId: "t1", rev: expect.any(Number) as number, stage: "done", at: 9, questionId: "m1", replyId: "a1" }, saved: [ANSWER] });
  });

  it("the step that saves a question carries the question", () => {
    const t = telling();
    asked(t);
    expect(t.told.at(-1)).toMatchObject({ kind: "is", reply: { id: "q1", stage: "thinking", questionId: "m1", model: MODEL, try: 1 }, saved: [QUESTION] });
  });

  it("changes made before the windows hear are sent once, as the record is then", () => {
    const t = telling();
    waits(t);
    t.q.take("q1", "turn-1", 5);
    t.q.loading("turn-1");
    t.q.started("turn-1", 1, QUESTION, MODEL, WARM);
    t.q.heard("turn-1", { type: "delta", text: "some" });
    expect(t.told.map(sent)).toEqual(["queued"]);
    t.q.notify();
    expect(t.told.map(sent)).toEqual(["queued", "writing +1"]);
  });

  it("the app sends a reply's whole life in order, and reply.list reads the same record", async () => {
    const at = await reach.writing();
    const live = at.r.told().at(-1);
    const listed = await at.r.h["reply.list"]({}, { clientId: 2 });
    expect(listed.map((l) => l.reply)).toEqual(live?.kind === "is" ? [live.reply] : []);
    expect(listed[0]?.soFar, "a reply being written lists its words so far").toBeDefined();
    at.r.finish();
    await until(() => over(at), "the reply's end");
    await until(() => at.r.told().some((c) => c.kind === "is" && c.reply.stage === "done"), "the end, sent to the windows");
    const told = at.r.told();
    expect(told.map(sent)).toEqual(["starting", "thinking silent +1", "writing", "done +1"]);
    expect(told.every((c) => (c.kind === "is" ? c.reply.id : c.id) === at.turnId)).toBe(true);
    const saved = at.r.db.getThread(at.r.thread.id).messages;
    expect(told.flatMap((c) => (c.kind === "is" ? c.saved ?? [] : []))).toEqual(saved);
    expect(await at.r.h["reply.list"]({}, { clientId: 2 })).toEqual([]);
    // the words of the reply name their record, so a window puts them on the reply it has by that id
    const words = at.r.pushes.flatMap((p) => p.channel === "chat.event" && (p.payload as Payload<"chat.event">).event.type === "delta" ? [(p.payload as Payload<"chat.event">).replyId] : []);
    expect(words).toEqual([at.turnId]);
    const parts = at.r.pushes.flatMap((p) => (p.channel === "reply.words" ? [(p.payload as Payload<"reply.words">).id] : []));
    expect(parts.length).toBeGreaterThan(0);
    expect(new Set(parts)).toEqual(new Set([at.turnId]));
  });

  it("a restart sends nothing: each window reads the records", () => {
    const told: ReplyChange[] = [];
    const root = path.join(os.homedir(), ".cache", "gates-local-tests");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "reply-table-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const deps = { file: path.join(dir, "queue.json"), log: () => undefined, changed: () => undefined, saved: () => undefined, deleting: () => false, closing: () => false, cut: () => undefined, clock: () => undefined };
    createReplies({ ...deps, told: () => undefined }).add(ROW);
    const again = createReplies({ ...deps, told: (c) => told.push(c) });
    expect(told).toEqual([]);
    expect(again.records()).toMatchObject([{ reply: { id: "q1", stage: "held", held: { why: "restart" } } }]);
  });
});

// ---------------------------------------------------------------- the one send call
// reply.send: the server decides whether the message starts or waits. A case per thing that can
// be in its way, and per answer.

/** What a send came to, as a case names it. */
const came = (s: Sent): string => {
  if (s.kind !== "answer") return s.kind;
  const a = s.answer;
  return a.answer === "gone" ? `gone ${a.why}` : `${a.answer} ${a.reply.stage}`;
};

const store = (app: { saved?: Message; deleting?: true; closing?: true } = {}) => createReplies({
  log: () => undefined, changed: () => undefined, told: () => undefined, cut: () => undefined, clock: () => undefined,
  saved: (id) => (app.saved?.id === id ? app.saved : undefined), deleting: () => app.deleting === true, closing: () => app.closing === true,
});

describe("the one send call: the server decides whether a message starts or waits", () => {

  it("nothing is in its way: taken at once, as its first start, with the words it was sent with", () => {
    const q = store();
    const s = sends({ q }, { think: true, tools: true });
    expect(s).toMatchObject({ kind: "start", attempt: 1, picked: { id: "q1", threadId: "t1", now: false, words: { messageId: "m1", text: "words", model: MODEL, numCtx: 8192, think: true, tools: true, at: 5 } } });
    expect(q.of("turn-1")).toMatchObject({ id: "q1", stage: "starting", turnId: "turn-1", attempt: 1, direct: false, retry: false });
    // read once its start is answered: the record as it then is
    q.begun("turn-1");
    expect(s.kind === "start" ? s.answer() : undefined).toMatchObject({ answer: "done", reply: { id: "q1", stage: "starting", attempt: 1 } });
  });

  it("a person is waiting on it: it goes as a Send now does, with the yes it was sent with", () => {
    expect(sends({ q: store() }, { askFirst: true })).toMatchObject({ kind: "start", picked: { now: true } });
    const consent = { kind: "named", replies: ["turn-9"] } as const;
    expect(sends({ q: store() }, { consent })).toMatchObject({ kind: "start", picked: { now: true, consent } });
  });

  const WAITS: readonly (readonly [string, Partial<SendNow>, unknown])[] = [
    ["a start or a reply is running in its chat", { busy: true }, { what: "reply" }],
    ["setup is running", { behind: "setup" }, { what: "setup" }],
    ["the first model is downloading", { behind: "download" }, { what: "download", model: MODEL }],
  ];
  it.each(WAITS)("%s: it waits, and the answer says for what", (_name, now, waitFor) => {
    const q = store();
    // a reply on its way in the chat, for the answer to name
    if (now.busy === true) q.direct("turn-0", "t1", { ...WORDS, messageId: "m0" }, false, 1);
    const s = sends({ q }, { askFirst: true }, now);
    expect(came(s)).toBe("done queued");
    expect(s).toMatchObject({ answer: { reply: { id: "q1", stage: "queued", waitFor: now.busy === true ? { what: "reply", reply: "turn-0" } : waitFor } } });
  });

  it("a message of its chat waits to go on its own: the new one waits behind it, and one on hold is not in its way", () => {
    const q = store();
    q.add({ ...ROW, id: "q0", messageId: "m0" });
    expect(came(sends({ q }))).toBe("done queued");
    expect(q.list().map((r) => r.id)).toEqual(["q0", "q1"]);
    const held = store();
    held.add({ ...ROW, id: "q0", messageId: "m0" });
    held.hold({ id: "q0" });
    expect(came(sends({ q: held }))).toBe("start");
    // another chat's waiting message is not in its way either
    const other = store();
    other.add({ ...ROW, id: "q0", messageId: "m0", threadId: "t2" });
    expect(came(sends({ q: other }))).toBe("start");
  });

  it("the same send again is answered as the message now is, and starts nothing twice", () => {
    const q = store();
    expect(came(sends({ q }))).toBe("start");
    expect(came(sends({ q }, {}, { turnId: "turn-2" }))).toBe("done starting");
    expect(q.of("turn-2")).toBeUndefined();
    // the same words under another id (the first answer never came back): the message the server has
    const again = sends({ q }, { id: "q2" }, { turnId: "turn-3" });
    expect(again).toMatchObject({ kind: "answer", answer: { answer: "done", reply: { id: "q1", stage: "starting" } } });
    expect(q.records().map((r) => r.reply.id)).toEqual(["q1"]);
  });

  it("its question is in the chat already: gone, sent, with the saved question, and no record", () => {
    const q = store({ saved: QUESTION });
    expect(sends({ q })).toEqual({ kind: "answer", answer: { answer: "gone", why: "sent", question: QUESTION } });
    expect(q.records()).toEqual([]);
  });

  it("its chat is being deleted: gone, and no record", () => {
    const q = store({ deleting: true });
    expect(came(sends({ q }))).toBe("gone chat-deleted");
    expect(q.records()).toEqual([]);
  });

  it("the app is closing: kept on hold for the restart, and nothing starts", () => {
    const q = store({ closing: true });
    expect(sends({ q })).toMatchObject({ kind: "answer", answer: { answer: "done", reply: { stage: "held", held: { why: "restart" } } } });
    expect(q.of("turn-1")).toBeUndefined();
  });

  it("a Retry never waits: with anything in its way, or the app closing, no record is made", () => {
    for (const now of WAITS.map(([, n]) => n)) {
      const q = store();
      expect(came(sends({ q }, RETRY, now))).toBe("cannot");
      expect(q.records()).toEqual([]);
    }
    const closing = store({ closing: true });
    expect(came(sends({ q: closing }, RETRY))).toBe("cannot");
    expect(closing.records()).toEqual([]);
  });

  it("a Retry is on no list of waiting messages, and carries the question it repeats", () => {
    const q = store();
    expect(sends({ q }, RETRY)).toMatchObject({ kind: "start", picked: { words: { retryOf: "m0" } } });
    q.begun("turn-1");
    expect(q.list()).toEqual([]);
    expect(q.records()).toMatchObject([{ reply: { id: "q1", stage: "starting", retryOf: "m0" } }]);
  });

  it("the older pages' list shows a sent message once its start is answered, without what their rows cannot carry", () => {
    const q = store();
    sends({ q }, { tools: true });
    expect(q.list()).toEqual([]);
    q.begun("turn-1");
    expect(q.list()).toEqual([{ id: "q1", threadId: "t1", messageId: "m1", text: "words", model: MODEL, numCtx: 8192, at: 5, waitFor: "reply", sending: "turn-1" }]);
  });
});

const said = (r: Rig, more: Partial<Params<"reply.send">> = {}): Params<"reply.send"> => ({ id: "q1", threadId: r.thread.id, messageId: "m-q1", text: "question", model: MODEL, numCtx: 16384, ...more });
const toldStages = (r: Rig) => r.told().map(sent);

describe("reply.send, through the app", () => {

  it("a free chat: answered with the message starting under the window's id, and its whole life is told under that id", async () => {
    const r = rig();
    r.open();
    expect(await r.h["reply.send"](said(r), { clientId: ME })).toMatchObject({ answer: "done", reply: { id: "q1", stage: "starting", text: "question" } });
    await until(() => toldStages(r).at(-1) === "done +1", "the reply's end");
    expect(toldStages(r)).toEqual(["starting", "thinking silent +1", "writing", "done +1"]);
    expect(r.told().every((c) => (c.kind === "is" ? c.reply.id : c.id) === "q1")).toBe(true);
    expect(r.db.getThread(r.thread.id).messages.map((m) => [m.role, m.id === "m-q1" || m.role === "assistant"])).toEqual([["user", true], ["assistant", true]]);
  });

  it("a chat with a reply on its way: it waits behind it, and goes when that reply has ended", async () => {
    const r = rig({ drip: true });
    r.open();
    await r.h["reply.send"](said(r, { id: "q0", messageId: "m-q0", text: "first" }), { clientId: ME });
    expect(await r.h["reply.send"](said(r), { clientId: ME })).toMatchObject({ answer: "done", reply: { id: "q1", stage: "queued", waitFor: { what: "reply" } } });
    await until(() => r.starts().length === 1, "the first reply's start");
    r.finish();
    await until(() => r.starts().length === 2, "the second message's start");
    expect(r.starts()).toEqual(["first", "question"]);
    r.finish();
  });

  it("a start refused for memory: one record on hold with the reason and what runs instead, told once, and nothing saved", async () => {
    const r = rig();
    const offer = { context: { numCtx: 8192, verdict: "fits" as const }, short: { needBytes: 2, gpuBytes: 1, ramBytes: 0, shortBytes: 1 } };
    r.refusals.push(Object.assign(new AppError("wont-fit", "it does not fit"), { offer }));
    r.open();
    await r.h["reply.send"](said(r), { clientId: ME });
    await until(() => toldStages(r).at(-1) === "held", "the refusal");
    expect(toldStages(r)).toEqual(["starting", "held"]);
    expect(r.told().at(-1)).toMatchObject({ kind: "is", reply: { id: "q1", stage: "held", text: "question", held: { why: "refused", code: "wont-fit", message: "it does not fit", offer } } });
    expect(await r.h["reply.list"]({}, { clientId: OTHER })).toMatchObject([{ reply: { id: "q1", stage: "held" } }]);
    expect(r.db.getThread(r.thread.id).messages).toEqual([]);
    // the same send again does not start it: it is on hold until a person sends it
    expect(await r.h["reply.send"](said(r), { clientId: ME })).toMatchObject({ answer: "done", reply: { stage: "held" } });
    await settle();
    expect(r.starts()).toEqual([]);
    // the smaller context taken on the row in another window, then Send now
    expect(await r.h["reply.change"]({ id: "q1", base: "m-q1", messageId: "m-q1", numCtx: 8192 }, { clientId: OTHER })).toMatchObject({ answer: "done", reply: { numCtx: 8192 } });
    await r.h["reply.now"]({ id: "q1" }, { clientId: OTHER });
    await until(() => r.asked.length === 1, "the message asked of the model");
    expect(r.asked).toEqual([{ model: MODEL, numCtx: 8192 }]);
  });

  it("the same words sent twice, the first answer lost: asked once", async () => {
    const r = rig();
    r.open();
    await r.h["reply.send"](said(r), { clientId: ME });
    await until(() => toldStages(r).at(-1) === "done +1", "the reply's end");
    expect(await r.h["reply.send"](said(r, { id: "q2" }), { clientId: ME })).toMatchObject({ answer: "gone", why: "sent", question: { id: "m-q1", content: "question" } });
    expect(await r.h["reply.send"](said(r), { clientId: ME })).toMatchObject({ answer: "gone", why: "sent" });
    await settle();
    expect(r.asked.length).toBe(1);
  });

  it("a request wrong in itself is an error, and makes no record", async () => {
    const r = rig();
    await expect(r.h["reply.send"](said(r, { images: ["not a picture"] }), { clientId: ME })).rejects.toMatchObject({ code: "image-input" });
    await expect(r.h["reply.send"](said(r, { threadId: "no-such-chat" }), { clientId: ME })).rejects.toThrow();
    expect(await r.h["reply.list"]({}, { clientId: ME })).toEqual([]);
    expect(r.told()).toEqual([]);
  });

  it("a Retry replaces the unfinished rows of the question it repeats, and with its chat busy it is an error", async () => {
    const r = rig({ drip: true });
    r.open();
    await r.h["reply.send"](said(r), { clientId: ME });
    await until(() => toldStages(r).at(-1) === "writing", "the reply being written");
    // busy: a Retry does not wait
    await expect(r.h["reply.send"](said(r, { id: "q2", messageId: "m-q2", retryOf: "m-q1" }), { clientId: ME })).rejects.toMatchObject({ code: "turn-active" });
    await r.h["reply.stop"]({ id: "q1" }, { clientId: ME });
    await until(() => toldStages(r).at(-1)?.startsWith("stopped") === true, "the stopped reply's end");
    await until(() => r.app.activeTurns() === 0, "its work gone");
    expect(await r.h["reply.send"](said(r, { id: "q2", messageId: "m-q2", retryOf: "m-q1" }), { clientId: ME })).toMatchObject({ answer: "done", reply: { id: "q2", stage: "starting", retryOf: "m-q1" } });
    await until(() => r.starts().length === 2, "the Retry's start");
    r.finish();
    await until(() => toldStages(r).at(-1) === "done +1", "the Retry's end");
    expect(r.db.getThread(r.thread.id).messages.map((m) => [m.role, m.id === "m-q2" || m.role === "assistant", m.interrupted])).toEqual([["user", true, undefined], ["assistant", true, undefined]]);
  });

  it("a refused Retry is an error to the window that pressed it, and a failed record with nothing saved", async () => {
    const r = rig();
    r.open();
    await r.h["reply.send"](said(r), { clientId: ME });
    await until(() => toldStages(r).at(-1) === "done +1", "the first reply's end");
    await until(() => r.app.activeTurns() === 0, "its work gone");
    const before = r.db.getThread(r.thread.id).messages;
    r.refusals.push(new AppError("wont-fit", "it does not fit"));
    await r.h["reply.send"](said(r, { id: "q2", messageId: "m-q2", retryOf: "m-q1" }), { clientId: ME });
    await until(() => toldStages(r).at(-1) === "failed", "the refusal");
    expect(r.told().at(-1)).toMatchObject({ kind: "is", reply: { id: "q2", stage: "failed", code: "wont-fit", message: "it does not fit" } });
    expect(r.db.getThread(r.thread.id).messages).toEqual(before);
    expect(await r.h["reply.list"]({}, { clientId: ME })).toEqual([]);
  });
});
