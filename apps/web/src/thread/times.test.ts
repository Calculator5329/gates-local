import { describe, expect, it } from "vitest";
import type { CatalogEntry, Message, ReplyTimes } from "@gates-local/contracts";
import { drawTimes } from "./times.ts";

const ended = { reason: "done", at: 9_000 } as const;
const times = (patch: Partial<ReplyTimes> = {}): ReplyTimes => ({ startedAt: 1_000, spans: [], callsAt: {}, ended, ...patch });
const reply = (t: ReplyTimes | undefined): Message => ({ id: "a1", threadId: "T", role: "assistant", content: "Done.", createdAt: 2, ...(t === undefined ? {} : { times: t }) });
const entry = (name: string, label: string): CatalogEntry => ({ name, label, purpose: "", downloadBytes: 0, installed: true, recommended: false });
const reload = (m: Message): Message => JSON.parse(JSON.stringify(m)) as Message;

describe("a saved row's times, drawn", () => {
  it("a saved reply's thinking rounds and where each call came are the row's own, the same in a second window and after a reload", () => {
    const spans = [{ from: 0, ms: 2_400 }, { from: 40, ms: 1_100 }];
    const callsAt = { c1: 40, c2: 90 };
    const row = reply(times({ workMs: 5_000, spans, callsAt }));
    expect(drawTimes(row, undefined).rounds).toEqual({ spans, callsAt });
    expect(drawTimes(reload(row), undefined).rounds).toEqual({ spans, callsAt });
    expect(drawTimes(reload(row), [entry("m", "M")]).rounds).toEqual({ spans, callsAt });
  });

  it("each part is undefined when the row has none: no spans and no calls is no rounds, while either one is", () => {
    expect(drawTimes(reply(times()), undefined)).toEqual({ workMs: undefined, waitMs: undefined, rounds: undefined, note: undefined });
    expect(drawTimes(reply(undefined), undefined)).toEqual({ workMs: undefined, waitMs: undefined, rounds: undefined, note: undefined });
    expect(drawTimes(reply(times({ spans: [{ from: 0, ms: 1_000 }] })), undefined).rounds).toEqual({ spans: [{ from: 0, ms: 1_000 }], callsAt: {} });
    expect(drawTimes(reply(times({ callsAt: { c1: 0 } })), undefined).rounds).toEqual({ spans: [], callsAt: { c1: 0 } });
  });

  it("a row hands back the same drawn object for the same times and catalog, and a new one when the catalog changes", () => {
    const row = reply(times({ workMs: 3_000, readyAt: 1_500, spans: [{ from: 0, ms: 3_000 }], ended: { reason: "preempted", at: 4_000 }, why: { code: "preempted", message: "m", neededBy: "big:9b" } }));
    const first = [entry("big:9b", "Big One")];
    const drawn = drawTimes(row, first);
    expect(drawTimes(row, first)).toBe(drawn);
    expect(drawTimes({ ...row }, first), "a re-rendered row with the same times").toBe(drawn);
    const second = [entry("big:9b", "Big Two")];
    const redrawn = drawTimes(row, second);
    expect(redrawn).not.toBe(drawn);
    expect(redrawn).toEqual({ ...drawn, note: { kind: "said", words: expect.stringContaining("Big Two") } });
    expect(drawTimes(row, second)).toBe(redrawn);
  });

  it("a row saved before the server kept its work seconds uses its thought, or else the time to its first word", () => {
    expect(drawTimes(reply(times({ firstTokenAt: 4_500 })), undefined).workMs).toBe(3_500);
    expect(drawTimes(reply(times({ thoughtMs: 2_000, firstTokenAt: 4_500 })), undefined).workMs).toBe(2_000);
    expect(drawTimes(reply(times({ workMs: 1_200, thoughtMs: 2_000, firstTokenAt: 4_500 })), undefined).workMs).toBe(1_200);
  });
});
