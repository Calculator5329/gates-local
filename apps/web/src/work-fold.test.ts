// The reply's work line, read from the rendered timeline: the server's note is not a call, the
// seconds are the server's reply record (decisions 2 and 33), a finished line is its icon at
// rest (decision 3), and a failed reply says so with Retry (decision 7).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ReplyRecord, ReplyTimes, ToolStep } from "@gates-local/contracts";
import { type LiveTurn, setState, type State } from "./store.ts";
import { reduceTurn, type TurnEvent } from "./session/turn.ts";

vi.mock("./store.ts", async (original) => {
  const actual = await original<typeof import("./store.ts")>();
  return { ...actual, useStore: <T,>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("./session.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: () => "/f" }));
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: true })); vi.stubGlobal("window", {}); vi.useFakeTimers(); });
afterEach(() => { setState({ turns: {}, messages: {}, threadId: null }); vi.unstubAllGlobals(); vi.useRealTimers(); });

const T = "t";
const user: Message = { id: "u", threadId: T, role: "user", createdAt: 1, content: "Check my notes" };
const step = (callId: string, state: ToolStep["state"], durationMs?: number): ToolStep =>
  ({ callId, name: "shell", state, summary: "Searching your library", ...(durationMs === undefined ? {} : { durationMs }) });
const record = (patch: Partial<ReplyRecord>): ReplyRecord => ({ stage: "waiting", startedAt: 0, workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {}, ...patch });
/** A turn this client sent at 0. */
const sent = (): LiveTurn => ({ gen: 1, threadId: T, turnId: "turn", model: "m", startedAt: 0, thinking: "", text: "", tools: [], pendingUser: null });
/** The server's saved times for a reply that ended at `secs` with `workMs` of work. */
const stamped = (reason: ReplyTimes["ended"]["reason"], secs: number, workMs?: number, why?: ReplyTimes["why"]): ReplyTimes =>
  ({ startedAt: 0, spans: [], callsAt: {}, ended: { reason, at: secs * 1000 }, ...(workMs === undefined ? {} : { workMs }), ...(why === undefined ? {} : { why }) });

/** The turn after each event at its time, as chat.ts applies them. */
function play(turn: LiveTurn, events: readonly (readonly [number, TurnEvent])[]): LiveTurn {
  return events.reduce<LiveTurn>((t, [at, e]) => reduceTurn(t, e, at) ?? t, turn);
}
/** A record pushed at `at`. */
const push = (at: number, patch: Partial<ReplyRecord>) => [at, { type: "reply", reply: record(patch) }] as const;

async function render(now: number, state: Partial<State>): Promise<string> {
  vi.setSystemTime(now);
  const { Timeline } = await import("./Thread.tsx");
  // no live turn unless the case gives one: a saved row is read alone
  setState({ threadId: T, turns: {}, ...state });
  return renderToStaticMarkup(createElement(Timeline, { threadId: T }));
}
const live = (now: number, turn: LiveTurn) => render(now, { messages: { [T]: [user] }, turns: { [T]: turn } });
const saved = (reply: Message) => render(99_000, { messages: { [T]: [user, reply] } });
/** The live line, as markup; "" when there is none. */
const lineOf = (html: string) => /<(?:button|div)[^>]*class="think fold run"[^>]*>([\s\S]*?)<\/(?:button|div)><\/div>/.exec(html)?.[1] ?? "";
/** What the live line says on screen: its visible words and seconds, not the hidden twin that holds its width. */
const says = (html: string) => lineOf(html).replace(/<span class="lv-wide"[^>]*>[^<]*<\/span>/, "").replace(/<[^>]+>/g, "");
/** The finished reply's work seconds on its line; undefined when it has none. */
const bulb = (html: string) => /data-think="(\d+)"/.exec(html)?.[1];
/** The stop square's seconds; undefined when it shows none. */
const square = (html: string) => /class="stop-mark">.*?<span class="s">(\d+) s<\/span>/s.exec(html)?.[1];
const chipName = (html: string) => /class="think fold"[^>]*aria-label="([^"]*)"/.exec(html)?.[1];

describe("the server's note", () => {
  const note: ToolStep = { callId: "n", name: "note", state: "done", summary: "This model's 4K context is too small for its tools, so it answered without tools" };
  it("is not a call: no fold, and its sentence stays a plain line outside any fold", async () => {
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Hello.", thinking: "Say hello.", tools: [note] };
    const html = await saved(reply);
    expect(chipName(html)).toBe("Thought");
    expect(html).not.toContain("fold-list");
    expect(html.replace(/<div class="(fold-body|think-body)".*?<\/div>/gs, "")).toContain("answered without tools");
  });
  it("with no thought, the reply has no fold line at all", async () => {
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Hello.", tools: [note] };
    const html = await saved(reply);
    expect(html).not.toContain('class="think');
    expect(html).toContain("answered without tools");
  });
  it("while the reply has no words yet, the live line shows beside the note's line", async () => {
    const html = await live(5000, play({ ...sent(), tools: [note] }, [push(4000, { stage: "thinking", readyAt: 4000 })]));
    expect(lineOf(html)).toContain('class="run-dot"');
    expect(html).toContain("answered without tools");
  });
});

describe("the live line says the server's record (decisions 1, 2, 33)", () => {
  it("says nothing for a wait under a second, then Waiting, then the load, with no seconds before the model is ready", async () => {
    expect(says(await live(400, sent()))).toBe("");
    expect(lineOf(await live(400, sent())), "the dot is there from the send").toContain('class="run-dot"');
    expect(says(await live(1500, sent()))).toBe("Waiting");
    const loading = play(sent(), [push(1000, { stage: "loading" })]);
    expect(says(await live(9000, loading))).toBe("Loading into GPU memory…");
  });

  it("counts thinking and tool time, grows between pushes, and holds still while it writes", async () => {
    // loads 0-4 s, thinks 4-6 s, a call 6-9 s, thinks 9-10 s, writes from 10 s
    const thinking = play(sent(), [push(4000, { stage: "thinking", readyAt: 4000 }), [4100, { type: "thinking", text: "Look." }]]);
    expect(says(await live(5000, thinking))).toBe("Thinking · 1 s");
    const calling = play(thinking, [push(6000, { stage: "tool", readyAt: 4000, workMs: 2000 }), [6000, { type: "tool", step: step("a", "running") }]]);
    expect(says(await live(8000, calling))).toBe("Searching your library · 4 s");
    const writing = play(calling, [[9000, { type: "tool", step: step("a", "done", 3000) }], push(9000, { stage: "thinking", readyAt: 4000, workMs: 5000 }), push(10_000, { stage: "writing", readyAt: 4000, workMs: 6000, firstTokenAt: 10_000 }), [10_000, { type: "delta", text: "The" }]]);
    expect(says(await live(10_000, writing))).toBe("Writing · 6 s");
    expect(says(await live(40_000, writing)), "the writing is not work").toBe("Writing · 6 s");
  });

  it("a window that opened mid-reply has the same number as the one that sent it", async () => {
    const listed: LiveTurn = { ...sent(), startedAt: 20_000, listed: true };
    const opened = play(listed, [push(20_000, { stage: "tool", readyAt: 2000, workMs: 18_000 }), [20_010, { type: "start", model: "m", userMessage: user, replayed: true }], [20_010, { type: "thinking", text: "eighteen seconds of thought" }], [20_010, { type: "tool", step: step("a", "running") }]]);
    expect(says(await live(25_000, opened))).toBe("Searching your library · 23 s");
  });

  it("the same nodes from one stage to the next: words and digits change, nothing else", async () => {
    const t1 = play(sent(), [push(0, { stage: "thinking", readyAt: 0 }), [0, { type: "thinking", text: "Look." }], push(5000, { stage: "tool", readyAt: 0, workMs: 5000 }), [5000, { type: "tool", step: step("a", "running") }]]);
    const during = lineOf(await live(71_400, t1));
    expect(during).toContain('class="run-dot"');
    expect(during, "no spinner, no bulb").not.toMatch(/spin|i-bulb/);
    const t2 = play(t1, [[72_000, { type: "tool", step: step("a", "done", 67_000) }], push(72_000, { stage: "thinking", readyAt: 0, workMs: 72_000 }), [72_000, { type: "thinking", text: " More." }]]);
    const next = lineOf(await live(73_000, t2));
    expect(next.replace(/>[^<]*</g, "><")).toBe(during.replace(/>[^<]*</g, "><"));
  });
});

describe("a finished reply's line (decisions 3 and 4)", () => {
  it("is its icon and chevron at rest, its words in its name, and the numbers under the reply", async () => {
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Done.", thinking: "Hm.", tools: [step("a", "done", 10)],
      times: stamped("done", 11, 4500), stats: { completionTokens: 140, evalDurationMs: 10_000 } };
    const html = await saved(reply);
    expect(bulb(html)).toBe("5");
    expect(chipName(html)).toBe("5 s · 1 step");
    expect(html).toMatch(/class="lv-i"><svg[^>]*><use href="#i-check"/);
    expect(html).toContain("4.5 s · 14 tok/s");
    expect(html).not.toContain("to first token");
  });

  it("a thought alone is the bulb", async () => {
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Done.", thinking: "Hm.", times: stamped("done", 4, 3000) };
    const html = await saved(reply);
    expect(chipName(html)).toBe("Thought for 3 s");
    expect(html).toMatch(/class="lv-i"><svg[^>]*><use href="#i-bulb"/);
  });

  it("a failed step turns the icon red and is counted; one Stop cut short is not", async () => {
    const failed: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Tennessine.", thinking: "Which table?",
      tools: [step("a", "error", 900), step("b", "error", 900), step("c", "done", 10)], times: stamped("done", 71, 71_000) };
    const html = await saved(failed);
    expect(html).toMatch(/class="lv-i bad"><svg[^>]*><use href="#i-alert"/);
    expect(chipName(html)).toBe("71 s · 3 steps, 2 failed");
    const cut: Message = { ...failed, tools: [{ ...step("a", "error", 900), stopped: true }], interrupted: true, times: stamped("stopped", 9, 3000) };
    const stopped = await saved(cut);
    expect(stopped).not.toContain("lv-i bad");
    expect(stopped).toContain('data-st="cut"');
    expect(chipName(stopped)).toBe("3 s · 1 step");
  });

  it("a turn that ended on an error with no failed step has no red mark on its line", async () => {
    const calls = play(sent(), [push(0, { stage: "thinking", readyAt: 0 }), [0, { type: "thinking", text: "Hm." }], [1000, { type: "tool", step: step("a", "done", 1000) }], [3000, { type: "error", code: "model-error", message: "The model failed." }]]);
    expect(await live(4000, calls)).not.toContain("lv-i bad");
  });
});

describe("a stopped reply's time", () => {
  it("the line keeps the work and the square keeps Stop's seconds, live and saved: thinking 2 s, a 15 s call, Stop at 18 s", async () => {
    const stopped = play(sent(), [push(0, { stage: "thinking", readyAt: 0 }), [0, { type: "thinking", text: "Hm." }], push(2000, { stage: "tool", readyAt: 0, workMs: 2000 }), [2000, { type: "tool", step: step("a", "running") }], [17_000, { type: "tool", step: step("a", "done", 15_000) }], push(17_000, { stage: "thinking", readyAt: 0, workMs: 17_000 }), [18_000, { type: "stop" }]]);
    const shown = await live(19_000, stopped);
    expect([bulb(shown), square(shown)]).toEqual(["18", "18"]);
    const after = await saved({ id: "s", threadId: T, role: "assistant", createdAt: 2, content: "", thinking: "Hm.", tools: stopped.tools, interrupted: true, times: stamped("stopped", 18, 18_000) });
    expect([bulb(after), square(after)]).toEqual(["18", "18"]);
  });

  it("stopped while thinking, with no calls and no words, the time shows once: in the line's name, not on the square", async () => {
    const stopped = play(sent(), [push(0, { stage: "thinking", readyAt: 0 }), [0, { type: "thinking", text: "Hm." }], [3000, { type: "stop" }]]);
    const shown = await live(5000, stopped);
    expect(shown).toContain('class="stop-mark"');
    expect(square(shown)).toBeUndefined();
    expect(chipName(shown)).toBe("Thought for 3 s");
  });
});

describe("a reply that did not finish (decision 7)", () => {
  it("says so once, with Retry and the runtime's words in the tip, and is never drawn as stopped", async () => {
    const failed = play(sent(), [push(0, { stage: "writing", readyAt: 0, attempt: 2 }), [500, { type: "delta", text: "Half" }], [1000, { type: "error", code: "stream-error", message: "model runner has unexpectedly stopped" }]]);
    const html = await live(2000, failed);
    expect(html).toMatch(/data-testid="chat.reply.failed" data-tip="model runner has unexpectedly stopped"><svg[\s\S]*?<span>The reply didn&#x27;t finish.<\/span>/);
    expect(html).toContain('data-testid="chat.reply.retry"');
    expect(html).not.toContain('class="stop-mark"');
    const after = await saved({ id: "s", threadId: T, role: "assistant", createdAt: 2, content: "Half", interrupted: true, times: stamped("failed", 1, undefined, { code: "stream-error", message: "model runner has unexpectedly stopped" }) });
    expect(after).toContain("The reply didn&#x27;t finish.");
    expect(after).toContain('data-testid="chat.reply.retry"');
    expect(after).not.toContain('class="stop-mark"');
  });
});
