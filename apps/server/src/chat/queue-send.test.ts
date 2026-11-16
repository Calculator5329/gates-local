// The server sends its queue: a message queued behind a reply goes when that reply ends and
// leaves the queue at its start; a Stop holds it until Send now.
import { methods } from "@gates-local/contracts";
import * as S from "effect/Schema";
import { expect, it, onTestFinished, vi } from "vitest";
import { AppError } from "../app.ts";
import { MODEL, rig, settle, until } from "../../test/send-rig.ts";

it("a message queued behind a reply goes when that reply ends, and leaves the queue at its start", async () => {
  const r = rig();
  await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await settle();
  expect(r.queued()).toMatchObject([{ id: "q1", text: "second" }]);
  expect(r.starts(), "nothing goes while the reply before it runs").toEqual([]);
  r.open();
  await until(() => r.starts().length === 2 && r.queued().length === 0, "the queued message sent");
  expect(r.starts()).toEqual(["first", "second"]);
  expect(r.db.getMessage("m-q1")?.content).toBe("second");
  expect(await r.h["queue.list"]({}, { clientId: 2 }), "a second window sees the same queue").toEqual([]);
});

it("a Stop before the reply started holds what queued behind it; Send now sends it", async () => {
  const r = rig();
  const { turnId } = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await r.h["chat.cancel"]({ turnId }, { clientId: 1 });
  r.open();
  await until(() => r.queued()[0]?.held === true, "the queue held");
  await settle();
  expect(r.starts()).toEqual([]);
  await r.h["queue.update"]({ id: "q1", now: true }, { clientId: 2 });
  await until(() => r.starts().length === 1 && r.queued().length === 0, "Send now sent it");
  expect(r.starts()).toEqual(["second"]);
});

it.each(["the hold first, as a window sends them", "the Stop first"])("a Stop that lands just after the reply ended still holds what queued behind it, and pulls back the one already on its way (%s)", async (order) => {
  const r = rig();
  const hold = async (id: string) => r.h["queue.update"]({ id, held: true }, { clientId: 1 });
  const { turnId } = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await r.h["queue.add"](r.entry("q2", "third"), { clientId: 1 });
  // the reply's last word reaches the server before the Stop: the queue moves on and q1 goes out
  r.openOne();
  await until(() => r.queued()[0]?.sending !== undefined, "the next message on its way");
  expect(r.starts()).toEqual(["first"]);
  // the Stop and the window's holds, a round trip after the reply ended
  if (order === "the Stop first") {
    await r.h["chat.cancel"]({ turnId }, { clientId: 1 });
    await hold("q1");
    await hold("q2");
  } else {
    // q1 is on its way when its hold comes: the hold is answered as too late, the Stop pulls it back
    await expect(hold("q1")).rejects.toMatchObject({ code: "queue-sending" });
    await hold("q2");
    await r.h["chat.cancel"]({ turnId }, { clientId: 1 });
  }
  r.open();
  await settle();
  expect(r.starts(), "nothing behind a stopped reply goes on its own").toEqual(["first"]);
  expect(r.queued().map((q) => [q.id, q.held, q.sending, q.why])).toEqual([["q1", true, undefined, undefined], ["q2", true, undefined, undefined]]);
  expect(r.db.getMessage("m-q1"), "the pulled-back message was never saved").toBeUndefined();
});

it("a Stop that lands while a queued message's file is being saved still holds it, and nothing of it is saved", async () => {
  let stop: (() => void) | undefined;
  let readsWhileSending = 0;
  const r = rig({ fileOwnersRead: () => {
    if (r.queued()[0]?.sending === undefined) return;
    // the first read is the check when the send is taken; the second is inside the save
    if (++readsWhileSending === 2) stop?.();
  } });
  const { turnId } = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  const file = await r.h["files.attach"]({ name: "notes.txt", type: "text/plain", data: "aGVsbG8=" }, { clientId: 1 });
  await r.h["queue.add"]({ ...r.entry("q1", "second"), files: [file] }, { clientId: 1 });
  r.openOne();
  await until(() => r.queued()[0]?.sending !== undefined, "the queued message on its way");
  let stopped = false;
  stop = () => { stopped = true; void r.h["chat.cancel"]({ turnId }, { clientId: 1 }); };
  r.open();
  await until(() => stopped, "the Stop during the save");
  await settle();
  expect(r.starts(), "a message the Stop pulled back is not asked").toEqual(["first"]);
  expect(r.queued().map((q) => [q.id, q.held, q.sending])).toEqual([["q1", true, undefined]]);
  expect(r.db.getMessage("m-q1"), "the pulled-back message was never saved").toBeUndefined();
});

it("a Stop long after the reply ended still holds what waits in its chat, and leaves the reply being written alone", async () => {
  const r = rig({ drip: true });
  r.open();
  const first = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await until(() => r.record(first.turnId)?.stage === "writing", "the first reply being written");
  r.finish();
  await until(() => r.events(first.turnId).some((e) => e.type === "done"), "the first reply's end");
  // an hour passes: no length of time makes a Stop mean less
  const ended = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => Math.round(performance.timeOrigin + performance.now()) + 3_600_000);
  onTestFinished(() => clock.mockRestore());
  expect(Date.now() - ended).toBeGreaterThanOrEqual(3_600_000);
  const second = await r.h["chat.send"]({ threadId: r.thread.id, content: "second", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await until(() => r.record(second.turnId)?.stage === "writing", "the second reply being written");
  await r.h["queue.add"](r.entry("q1", "third"), { clientId: 1 });
  await r.h["queue.add"](r.entry("q2", "fourth"), { clientId: 1 });
  // the older call says no reply was stopped; what waits holds all the same
  expect(await r.h["chat.cancel"]({ turnId: first.turnId }, { clientId: 2 })).toEqual({ cancelled: false });
  expect(r.queued().map((q) => [q.id, q.held])).toEqual([["q1", true], ["q2", true]]);
  expect(await r.h["reply.stop"]({ id: first.turnId }, { clientId: 2 })).toMatchObject({ answer: "gone", why: "sent", question: { content: "first" } });
  expect(r.record(second.turnId)).toMatchObject({ stage: "writing" });
  expect(r.record(second.turnId)?.stoppedAt).toBeUndefined();
  r.finish();
  await until(() => r.events(second.turnId).some((e) => e.type === "done"), "the second reply's end");
  await settle();
  expect(r.starts(), "nothing held goes on its own").toEqual(["first", "second"]);
  expect(r.queued().map((q) => [q.id, q.held, q.sending])).toEqual([["q1", true, undefined], ["q2", true, undefined]]);
});

it("a row left open in a composer stays open through a dropped connection, and goes on once its window is gone", async () => {
  const r = rig();
  r.open();
  const dropped = new AbortController();
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  // queued with no reply running would go at once: hold it open in window 3 first
  await r.h["queue.update"]({ id: "q1", editing: true }, { clientId: 5, window: 3, signal: dropped.signal });
  await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await until(() => r.starts().includes("first"), "the reply");
  dropped.abort();
  r.finish();
  await settle();
  expect(r.starts(), "a row open in a composer waits, its socket gone").toEqual(["first"]);
  expect(r.queued()[0]).toMatchObject({ id: "q1", editing: true });
  // the window's next socket still holds the edit as its own
  expect(await r.h["reply.edit"]({ id: "q1", open: true }, { clientId: 6, window: 3 })).toMatchObject({ answer: "done" });
  r.app.windowGone(3);
  await until(() => r.starts().length === 2, "the row sent once its window was gone");
  expect(r.starts()).toEqual(["first", "second"]);
});

it("another window's edit of the same row does not end when the first editor's window is gone", async () => {
  const r = rig();
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await r.h["queue.update"]({ id: "q1", editing: true }, { clientId: 5, window: 3 });
  await r.h["queue.update"]({ id: "q1", editing: true }, { clientId: 6, window: 4 });
  r.app.windowGone(3);
  r.open();
  await settle();
  expect(r.queued()[0]).toMatchObject({ id: "q1", editing: true });
  expect(r.starts()).toEqual([]);
});

it("a queued message refused for memory keeps what runs instead, and goes with the context the person picks from it", async () => {
  const r = rig();
  const offer = { context: { numCtx: 8192, verdict: "fits" as const }, short: { needBytes: 2, gpuBytes: 1, ramBytes: 0, shortBytes: 1 } };
  r.refusals.push(Object.assign(new AppError("wont-fit", "qwen3.5:9b at 16k does not fit."), { offer }));
  r.open();
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await until(() => r.queued()[0]?.held === true, "the refusal");
  expect(r.queued()[0]?.why).toEqual({ code: "wont-fit", message: "qwen3.5:9b at 16k does not fit.", offer });
  // the note's smaller context, then Send now; the wire keeps the context
  const change = S.decodeUnknownSync(methods["queue.update"].params)({ id: "q1", model: MODEL, numCtx: 8192 });
  expect(change).toEqual({ id: "q1", model: MODEL, numCtx: 8192 });
  await r.h["queue.update"](change, { clientId: 1 });
  expect(r.queued()[0]).toMatchObject({ model: MODEL, numCtx: 8192 });
  await r.h["queue.update"]({ id: "q1", now: true }, { clientId: 1 });
  await until(() => r.starts().length === 1, "sent");
  expect(r.asked.at(-1)).toEqual({ model: MODEL, numCtx: 8192 });
});
