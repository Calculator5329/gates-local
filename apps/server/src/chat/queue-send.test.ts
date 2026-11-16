// The server sends its queue: a message queued behind a reply goes when that reply ends and
// leaves the queue at its start; a Stop holds it until Send now.
import { methods } from "@gates-local/contracts";
import * as S from "effect/Schema";
import { expect, it, onTestFinished, vi } from "vitest";
import { AppError } from "../app.ts";
import { MODEL, WAITING, rig, settle, until } from "../../test/send-rig.ts";
import { sendTaken } from "./send-started.ts";

it("a message queued behind a reply goes when that reply ends, and leaves the queue at its start", async () => {
  const r = rig();
  await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  expect(await r.h["reply.send"](r.entry("q1", "second"), { clientId: 1 })).toMatchObject({ answer: "done", reply: { stage: "queued" } });
  await settle();
  expect(r.queued()).toMatchObject([{ id: "q1", text: "second" }]);
  expect(r.starts(), "nothing goes while the reply before it runs").toEqual([]);
  r.open();
  await until(() => r.starts().length === 2 && r.queued().length === 0, "the queued message sent");
  expect(r.starts()).toEqual(["first", "second"]);
  expect(r.db.getMessage("m-q1")?.content).toBe("second");
  const listed = await r.h["reply.list"]({}, { clientId: 2 });
  expect(listed.filter((l) => WAITING.has(l.reply.stage)), "a second window sees the same queue").toEqual([]);
});

it("a Stop before the reply started holds what queued behind it; Send now sends it", async () => {
  const r = rig();
  const { id, turnId } = await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await r.h["reply.send"](r.entry("q1", "second"), { clientId: 1 });
  await r.h["reply.stop"]({ id: turnId }, { clientId: 1 });
  r.open();
  await until(() => r.latest("q1")?.stage === "held", "the queue held");
  await settle();
  expect(r.starts()).toEqual([]);
  await r.h["reply.now"]({ id: "q1" }, { clientId: 2 });
  await until(() => r.starts().length === 1 && r.queued().every((q) => q.id !== "q1"), "Send now sent it");
  expect(r.starts()).toEqual(["second"]);
  expect(r.queued().map((q) => [q.id, q.stage]), "the stopped message waits on hold").toEqual([[id, "held"]]);
});

it.each(["the hold first, as a window sends them", "the Stop first"])("a Stop that lands just after the reply ended still holds what queued behind it, and pulls back the one already on its way (%s)", async (order) => {
  const r = rig();
  const hold = async (id: string) => r.h["reply.hold"]({ id }, { clientId: 1 });
  const { turnId } = await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await r.h["reply.send"](r.entry("q1", "second"), { clientId: 1 });
  await r.h["reply.send"](r.entry("q2", "third"), { clientId: 1 });
  // the reply's last word reaches the server before the Stop: the queue moves on and q1 goes out
  r.openOne();
  await until(() => r.latest("q1")?.stage === "starting", "the next message on its way");
  expect(r.starts()).toEqual(["first"]);
  // the Stop and the window's holds, a round trip after the reply ended
  if (order === "the Stop first") {
    await r.h["reply.stop"]({ id: turnId }, { clientId: 1 });
    await hold("q1");
    await hold("q2");
  } else {
    // q1 is on its way when its hold comes: the hold is answered as too late, the Stop pulls it back
    expect(await hold("q1")).toMatchObject({ answer: "sending" });
    await hold("q2");
    await r.h["reply.stop"]({ id: turnId }, { clientId: 1 });
  }
  r.open();
  await settle();
  expect(r.starts(), "nothing behind a stopped reply goes on its own").toEqual(["first"]);
  expect(r.queued().map((q) => [q.id, q.stage === "held" ? q.held : q.stage])).toEqual([["q1", { why: "stopped" }], ["q2", { why: "stopped" }]]);
  expect(r.db.getMessage("m-q1"), "the pulled-back message was never saved").toBeUndefined();
});

it("a Stop that lands while a queued message's file is being saved still holds it, and nothing of it is saved", async () => {
  let stop: (() => void) | undefined;
  let readsWhileSending = 0;
  const r = rig({ fileOwnersRead: () => {
    if (r.latest("q1")?.stage !== "starting") return;
    // the first read is the check when the send is taken; the second is inside the save
    if (++readsWhileSending === 2) stop?.();
  } });
  const { turnId } = await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  const file = await r.h["files.attach"]({ name: "notes.txt", type: "text/plain", data: "aGVsbG8=" }, { clientId: 1 });
  await r.h["reply.send"]({ ...r.entry("q1", "second"), files: [file] }, { clientId: 1 });
  r.openOne();
  await until(() => r.latest("q1")?.stage === "starting", "the queued message on its way");
  let stopped = false;
  stop = () => { stopped = true; void r.h["reply.stop"]({ id: turnId }, { clientId: 1 }); };
  r.open();
  await until(() => stopped, "the Stop during the save");
  await settle();
  expect(r.starts(), "a message the Stop pulled back is not asked").toEqual(["first"]);
  expect(r.queued().map((q) => [q.id, q.stage])).toEqual([["q1", "held"]]);
  expect(r.db.getMessage("m-q1"), "the pulled-back message was never saved").toBeUndefined();
});

it("a Stop long after the reply ended still holds what waits in its chat, and leaves the reply being written alone", async () => {
  const r = rig({ drip: true });
  r.open();
  const first = await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await until(() => r.record(first.turnId)?.stage === "writing", "the first reply being written");
  r.finish();
  await until(() => r.events(first.turnId).some((e) => e.type === "done"), "the first reply's end");
  // an hour passes: no length of time makes a Stop mean less
  const ended = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => Math.round(performance.timeOrigin + performance.now()) + 3_600_000);
  onTestFinished(() => clock.mockRestore());
  expect(Date.now() - ended).toBeGreaterThanOrEqual(3_600_000);
  const second = await sendTaken(r.app, { threadId: r.thread.id, content: "second", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await until(() => r.record(second.turnId)?.stage === "writing", "the second reply being written");
  await r.h["reply.send"](r.entry("q1", "third"), { clientId: 1 });
  await r.h["reply.send"](r.entry("q2", "fourth"), { clientId: 1 });
  expect(await r.h["reply.stop"]({ id: first.turnId }, { clientId: 2 })).toMatchObject({ answer: "gone", why: "sent", question: { content: "first" } });
  expect(r.queued().map((q) => [q.id, q.stage])).toEqual([["q1", "held"], ["q2", "held"]]);
  expect(r.record(second.turnId)).toMatchObject({ stage: "writing" });
  expect(r.record(second.turnId)?.stoppedAt).toBeUndefined();
  r.finish();
  await until(() => r.events(second.turnId).some((e) => e.type === "done"), "the second reply's end");
  await settle();
  expect(r.starts(), "nothing held goes on its own").toEqual(["first", "second"]);
  expect(r.queued().map((q) => [q.id, q.stage])).toEqual([["q1", "held"], ["q2", "held"]]);
});

it("a row left open in a composer stays open through a dropped connection, and goes on once its window is gone", async () => {
  const r = rig();
  const dropped = new AbortController();
  await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await r.h["reply.send"](r.entry("q1", "second"), { clientId: 1 });
  expect(await r.h["reply.edit"]({ id: "q1", open: true }, { clientId: 5, window: 3, signal: dropped.signal })).toMatchObject({ answer: "done", reply: { stage: "editing" } });
  r.open();
  await until(() => r.starts().includes("first"), "the reply");
  dropped.abort();
  r.finish();
  await settle();
  expect(r.starts(), "a row open in a composer waits, its socket gone").toEqual(["first"]);
  expect(r.latest("q1")).toMatchObject({ stage: "editing", by: "3" });
  // the window's next socket still holds the edit as its own
  expect(await r.h["reply.edit"]({ id: "q1", open: true }, { clientId: 6, window: 3 })).toMatchObject({ answer: "done" });
  r.app.windowGone(3);
  await until(() => r.starts().length === 2, "the row sent once its window was gone");
  expect(r.starts()).toEqual(["first", "second"]);
});

it("a row open in one window is not opened by a second, and the second window's going leaves the edit alone", async () => {
  const r = rig();
  await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await r.h["reply.send"](r.entry("q1", "second"), { clientId: 1 });
  await r.h["reply.edit"]({ id: "q1", open: true }, { clientId: 5, window: 3 });
  expect(await r.h["reply.edit"]({ id: "q1", open: true }, { clientId: 6, window: 4 })).toMatchObject({ answer: "elsewhere", reply: { stage: "editing", by: "3" } });
  r.app.windowGone(4);
  r.open();
  await settle();
  expect(r.latest("q1")).toMatchObject({ stage: "editing", by: "3" });
  expect(r.starts()).toEqual(["first"]);
});

it("a message refused for memory keeps what runs instead, and goes with the context the person picks from it", async () => {
  const r = rig();
  const offer = { context: { numCtx: 8192, verdict: "fits" as const }, short: { needBytes: 2, gpuBytes: 1, ramBytes: 0, shortBytes: 1 } };
  r.refusals.push(Object.assign(new AppError("wont-fit", "qwen3.5:9b at 16k does not fit."), { offer }));
  r.open();
  await r.h["reply.send"](r.entry("q1", "second"), { clientId: 1 });
  await until(() => r.latest("q1")?.stage === "held", "the refusal");
  expect(r.latest("q1")).toMatchObject({ held: { why: "refused", code: "wont-fit", message: "qwen3.5:9b at 16k does not fit.", offer } });
  // the note's smaller context, then Send now; the wire keeps the context
  const change = S.decodeUnknownSync(methods["reply.change"].params)({ id: "q1", base: "m-q1", messageId: "m-q1", model: MODEL, numCtx: 8192 });
  expect(change).toEqual({ id: "q1", base: "m-q1", messageId: "m-q1", model: MODEL, numCtx: 8192 });
  await r.h["reply.change"](change, { clientId: 1 });
  expect(r.latest("q1")).toMatchObject({ model: MODEL, numCtx: 8192 });
  await r.h["reply.now"]({ id: "q1" }, { clientId: 1 });
  await until(() => r.starts().length === 1, "sent");
  expect(r.asked.at(-1)).toEqual({ model: MODEL, numCtx: 8192 });
});

it("a message moved from a page's own older queue waits on hold, even with its chat free", async () => {
  const r = rig();
  r.open();
  expect(await r.h["reply.send"]({ ...r.entry("q1", "second"), held: true }, { clientId: 1 })).toMatchObject({ answer: "done", reply: { stage: "held", held: { why: "stopped" } } });
  await settle();
  expect(r.starts()).toEqual([]);
  await r.h["reply.now"]({ id: "q1" }, { clientId: 1 });
  await until(() => r.starts().length === 1, "Send now sent it");
});

it("a send into a chat with a reply on its way is refused as busy and leaves nothing waiting behind that reply", async () => {
  const r = rig();
  const first = await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await expect(sendTaken(r.app, { id: "q-busy", threadId: r.thread.id, content: "second", model: MODEL, numCtx: 16384 }, { clientId: 1 })).rejects.toMatchObject({ code: "turn-active" });
  expect((await r.h["reply.list"]({}, { clientId: 1 })).map((l) => l.reply.id)).toEqual([first.id]);
  r.open();
  await until(() => r.starts().length === 1, "the first reply");
  await settle();
  expect(r.starts(), "the refused send never goes on its own").toEqual(["first"]);
});

it("a start cut before anything of it is saved, by a delete in its chat, is back on hold at once and never asked", async () => {
  const r = rig();
  const earlier = r.db.appendMessage({ threadId: r.thread.id, role: "user", content: "earlier" });
  const { id } = await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  const deleting = r.h["messages.delete"]({ threadId: r.thread.id, messageId: earlier.id }, { clientId: 1 });
  expect(await r.h["reply.list"]({}, { clientId: 1 })).toMatchObject([{ reply: { id, stage: "held", held: { why: "refused", code: "cancelled" } } }]);
  r.open();
  await deleting;
  await settle();
  expect(r.starts(), "a cut start is not asked").toEqual([]);
  expect(r.latest(id)).toMatchObject({ stage: "held", held: { why: "refused", code: "cancelled" } });
});
