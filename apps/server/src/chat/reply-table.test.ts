// The reply's stages as a table: a case per cell. Each case puts one reply at a stage, makes one
// call or lets one server event happen, and checks the answer and the stage that follows, as
// every window is told it.
import type { Payload, QueuedMessage, Reply, ReplyAnswer, ReplyRecord, ReplyStage } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import { MODEL, type Rig, type RigHooks, rig, settle, until } from "../../test/send-rig.ts";

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
