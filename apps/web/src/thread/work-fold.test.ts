// The reply's work line, read from the rendered timeline: the server's note is not a call, the
// seconds are the server's reply record (decisions 2 and 33), a finished line is its icon at
// rest (decision 3), and a failed reply says so with Retry (decision 7).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ReplyTimes, ToolStep } from "@gates-local/contracts";
import { type LiveTurn, setState, type State, type TurnClock } from "../lib/store/store.ts";
import { reduceTurn, type TurnEvent } from "./turn.ts";

vi.mock("../lib/store/store.ts", async (original) => {
  const actual = await original<typeof import("../lib/store/store.ts")>();
  return { ...actual, useStore: <T,>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("../lib/session/index.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: () => "/f", loadEarlier: vi.fn(async () => false), earlierOf: () => 0, onEarlier: () => () => undefined }));
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: true })); vi.stubGlobal("window", {}); vi.useFakeTimers(); });
afterEach(() => { setState({ turns: {}, messages: {}, threadId: null }); vi.unstubAllGlobals(); vi.useRealTimers(); });

const T = "t";
const user: Message = { id: "u", threadId: T, role: "user", createdAt: 1, content: "Check my notes" };
const step = (callId: string, state: ToolStep["state"], durationMs?: number): ToolStep =>
  ({ callId, name: "shell", state, summary: "Searching your library", ...(durationMs === undefined ? {} : { durationMs }) });
const record = (patch: Partial<TurnClock>): TurnClock => ({ stage: "waiting", startedAt: 0, workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {}, ...patch });
/** A turn this client sent at 0. */
const sent = (): LiveTurn => ({ threadId: T, turnId: "turn", model: "m", startedAt: 0, thinking: "", text: "", tools: [] });
/** The server's saved times for a reply that ended at `secs` with `workMs` of work. */
const stamped = (reason: ReplyTimes["ended"]["reason"], secs: number, workMs?: number, why?: ReplyTimes["why"]): ReplyTimes =>
  ({ startedAt: 0, spans: [], callsAt: {}, ended: { reason, at: secs * 1000 }, ...(workMs === undefined ? {} : { workMs }), ...(why === undefined ? {} : { why }) });

/** The turn after each event at its time, as chat.ts applies them. */
function play(turn: LiveTurn, events: readonly (readonly [number, TurnEvent])[]): LiveTurn {
  return events.reduce<LiveTurn>((t, [at, e]) => reduceTurn(t, e, at) ?? t, turn);
}
/** A record pushed at `at`. */
const push = (at: number, patch: Partial<TurnClock>) => [at, { type: "reply", reply: record(patch) }] as const;

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
/** What the live line says on screen, its parts in order with one space between: the seconds, then the words. */
const says = (html: string) => lineOf(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** The finished reply's work seconds on its line; undefined when it has none. */
const bulb = (html: string) => /data-think="(\d+)"/.exec(html)?.[1];
/** The stop square's seconds; undefined when it shows none. */
const square = (html: string) => /class="stop-mark">.*?<span class="s">(\d+) s<\/span>/s.exec(html)?.[1];
/** The words on screen, tags and attributes out. */
const visible = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
    // layout B: the seconds' slot comes with the clock, at 0 s, and the words follow it
    expect(says(await live(4200, thinking))).toBe("0 s Thinking");
    expect(says(await live(5000, thinking))).toBe("1 s Thinking");
    const calling = play(thinking, [push(6000, { stage: "tool", readyAt: 4000, workMs: 2000 }), [6000, { type: "tool", step: step("a", "running") }]]);
    expect(says(await live(8000, calling))).toBe("4 s Searching your library");
    const writing = play(calling, [[9000, { type: "tool", step: step("a", "done", 3000) }], push(9000, { stage: "thinking", readyAt: 4000, workMs: 5000 }), push(10_000, { stage: "writing", readyAt: 4000, workMs: 6000, firstTokenAt: 10_000 }), [10_000, { type: "delta", text: "The" }]]);
    expect(says(await live(10_000, writing))).toBe("6 s Writing");
    expect(says(await live(40_000, writing)), "the writing is not work").toBe("6 s Writing");
  });

  it("a reply that goes straight to writing has no work to time: the dot and Writing, no seconds, for the whole reply", async () => {
    // a model that does not think, warm: ready at once, words from 1 s; "0 s" beside Writing read as a stuck clock
    const writing = play(sent(), [push(0, { stage: "waiting", readyAt: 0 }), push(1000, { stage: "writing", readyAt: 0, firstTokenAt: 1000 }), [1000, { type: "delta", text: "The" }]]);
    expect(says(await live(1200, writing))).toBe("Writing");
    expect(lineOf(await live(1200, writing))).not.toContain('class="lv-t"');
    expect(says(await live(30_000, writing)), "still no clock at the end").toBe("Writing");
    // a cold one: the load's words and Writing sit at the same left edge, after the dot
    const cold = play(sent(), [push(0, { stage: "loading" }), push(6000, { stage: "writing", readyAt: 6000, firstTokenAt: 6000 }), [6000, { type: "delta", text: "The" }]]);
    expect(says(await live(7000, cold))).toBe("Writing");
  });

  it("a reply that writes, then calls a tool, gains its seconds once, at the call, and keeps them", async () => {
    const wrote = play(sent(), [push(0, { stage: "writing", readyAt: 0, firstTokenAt: 0 }), [0, { type: "delta", text: "Let me look." }]]);
    expect(says(await live(2000, wrote))).toBe("Writing");
    const calling = play(wrote, [push(2000, { stage: "tool", readyAt: 0, firstTokenAt: 0 }), [2000, { type: "tool", step: step("a", "running") }]]);
    expect(says(await live(3000, calling))).toBe("1 s Searching your library");
    const after = play(calling, [[4000, { type: "tool", step: step("a", "done", 2000) }], push(4000, { stage: "writing", readyAt: 0, firstTokenAt: 0, workMs: 2000, toolMs: 2000, callsAt: { a: 2000 } }), [4000, { type: "delta", text: " Found it." }]]);
    expect(says(await live(9000, after))).toBe("2 s Writing");
  });

  it("a window that opened mid-reply has the same number as the one that sent it", async () => {
    // its turn is made from the reply's record, read at the window's own clock
    const listed: LiveTurn = { ...sent(), startedAt: 20_000 };
    const opened = play(listed, [push(20_000, { stage: "tool", readyAt: 2000, workMs: 18_000 }), [20_010, { type: "thinking", text: "eighteen seconds of thought" }], [20_010, { type: "tool", step: step("a", "running") }]]);
    expect(says(await live(25_000, opened))).toBe("23 s Searching your library");
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
    const stopped = play(sent(), [push(0, { stage: "thinking", readyAt: 0 }), [0, { type: "thinking", text: "Hm." }], push(2000, { stage: "tool", readyAt: 0, workMs: 2000 }), [2000, { type: "tool", step: step("a", "running") }], [17_000, { type: "tool", step: step("a", "done", 15_000) }], push(17_000, { stage: "thinking", readyAt: 0, workMs: 17_000 }), push(18_400, { stage: "stopping", readyAt: 0, workMs: 18_000, stoppedAt: 18_000 })]);
    const shown = await live(19_000, stopped);
    expect([bulb(shown), square(shown)]).toEqual(["18", "18"]);
    const after = await saved({ id: "s", threadId: T, role: "assistant", createdAt: 2, content: "", thinking: "Hm.", tools: stopped.tools, interrupted: true, times: stamped("stopped", 18, 18_000) });
    expect([bulb(after), square(after)]).toEqual(["18", "18"]);
  });

  it("stopped while thinking, with no calls and no words, the time shows once: in the line's name, not on the square", async () => {
    const stopped = play(sent(), [push(0, { stage: "thinking", readyAt: 0 }), [0, { type: "thinking", text: "Hm." }], push(3300, { stage: "stopping", readyAt: 0, workMs: 3000, stoppedAt: 3000 })]);
    const shown = await live(5000, stopped);
    expect(shown).toContain('class="stop-mark"');
    expect(square(shown)).toBeUndefined();
    expect(chipName(shown)).toBe("Thought for 3 s");
  });

  it("stopped before its first word, the row says Stopped once beside the square and keeps Regenerate, live and saved", async () => {
    const stopped = play(sent(), [push(0, { stage: "waiting", readyAt: 0 }), push(2300, { stage: "stopping", readyAt: 0, stoppedAt: 2000 })]);
    const shown = await live(2500, stopped);
    expect(visible(shown)).toMatch(/^Check my notes \d+:\d+ [AP]M Stopped 2 s$/);
    expect(shown.match(/>Stopped</g), "once on screen").toHaveLength(1);
    expect(shown).toContain('data-testid="chat.reply.regenerate"');
    const after = await saved({ id: "s", threadId: T, role: "assistant", createdAt: 2, content: "", interrupted: true, times: stamped("stopped", 2) });
    expect(after.match(/>Stopped</g)).toHaveLength(1);
    expect(after).toContain('data-testid="chat.reply.regenerate"');
    // one the server stopped says why in its own note, and a stopped reply with words says nothing more than the square
    const words = await saved({ id: "s", threadId: T, role: "assistant", createdAt: 2, content: "Half", interrupted: true, times: stamped("stopped", 2) });
    expect(words).not.toContain(">Stopped<");
  });
});

describe("a reply that did not finish (decision 7)", () => {
  it("says so once, with Retry, and keeps the runtime's words off the tip, and is never drawn as stopped", async () => {
    const failed = play(sent(), [push(0, { stage: "writing", readyAt: 0, attempt: 2 }), [500, { type: "delta", text: "Half" }], [1000, { type: "error", code: "stream-error", message: "model runner has unexpectedly stopped" }]]);
    const html = await live(2000, failed);
    expect(html).toMatch(/data-testid="chat.reply.failed" data-why="model runner has unexpectedly stopped"><svg[\s\S]*?<span>The reply didn&#x27;t finish.<\/span>/);
    expect(html).toContain('data-testid="chat.reply.retry"');
    expect(html).not.toContain('class="stop-mark"');
    const after = await saved({ id: "s", threadId: T, role: "assistant", createdAt: 2, content: "Half", interrupted: true, times: stamped("failed", 1, undefined, { code: "stream-error", message: "model runner has unexpectedly stopped" }) });
    expect(after).toContain("The reply didn&#x27;t finish.");
    expect(after).toContain('data-testid="chat.reply.retry"');
    expect(after).not.toContain('class="stop-mark"');
  });
});

const styles = async () => (await import("node:fs")).readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function declsOf(body: string): Record<string, string> {
  return Object.fromEntries(body.split(";").filter((d) => d.includes(":")).map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));
}
function ruleOf(css: string, selector: string): Record<string, string> | undefined {
  const body = new RegExp(`(?:^|[}\\n])${escRe(selector)}\\{([^}]*)\\}`).exec(css)?.[1];
  return body === undefined ? undefined : declsOf(body);
}
function rulesShowing(css: string, target: string, decl: string): string[][] {
  return [...css.matchAll(/(?:^|[}\n])([^{}\n]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[2] ?? "").split(";").includes(decl) && (m[1] ?? "").split(",").some((s) => s.trim().endsWith(target)))
    .map((m) => (m[1] ?? "").split(",").map((s) => s.trim()));
}
function mediaBody(css: string, query: string): string {
  let out = "";
  for (let at = css.indexOf(`@media ${query}{`); at >= 0; at = css.indexOf(`@media ${query}{`, at + 1)) {
    let depth = 0;
    const open = css.indexOf("{", at);
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { out += css.slice(open + 1, i) + "\n"; break; }
    }
  }
  return out;
}
const runName = (html: string) => {
  const opening = /<button[^>]*class="think fold run"[^>]*>/.exec(html)?.[0] ?? "";
  return /aria-label="([^"]*)"/.exec(opening)?.[1] ?? visible(lineOf(html).replace(/<(\w+)[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/\1>/g, ""));
};
const foldItems = (html: string) => [...(/<ol class="fold-list"[^>]*>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? "").matchAll(/<li( class="fold-th")?>/g)].map((m) => (m[1] === undefined ? "call" : "think"));
const roundNames = (html: string) => [...html.matchAll(/data-testid="chat\.fold\.thinking"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
const roundWords = (html: string) => [...html.matchAll(/data-testid="chat\.fold\.thinking"[\s\S]*?<span class="wr-h">([^<]*)<\/span>/g)].map((m) => m[1]);
const LONG = "Searching your library for every note that mentions the quarterly plan, its budget and who signed it";

describe("the work line's words, seconds, rounds and name", () => {
  it("a reply queued behind another says its wait as its own figure, and its work seconds start when the model is ready", async () => {
    const queued = play(sent(), [push(0, { stage: "waiting" })]);
    expect(says(await live(5000, queued)), "no clock while it waits its turn").toBe("Waiting");
    const thinking = play(queued, [push(6000, { stage: "thinking", readyAt: 6000 }), [6000, { type: "thinking", text: "Hm." }]]);
    expect(says(await live(7000, thinking))).toBe("1 s Thinking");
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Done.", thinking: "Hm.",
      times: { startedAt: 0, readyAt: 6000, workMs: 2000, spans: [], callsAt: {}, ended: { reason: "done", at: 12_000 } } };
    const html = await saved(reply);
    expect(bulb(html)).toBe("2");
    expect(visible(/<span class="meta">([\s\S]*?)<\/span><\/div>/.exec(html)?.[1] ?? "")).toBe("6.0 s · 2.0 s");
  });

  it("a sent message's actions sit under its bubble at its right edge, in a row whose space is kept while hidden", async () => {
    const html = await render(99_000, { messages: { [T]: [user] } });
    expect(html).toMatch(/<div class="u-row"><div class="bubble">Check my notes<\/div><div class="u-act">/);
    const css = await styles();
    expect(ruleOf(css, ".u-row")).toMatchObject({ display: "flex", "flex-direction": "column", "align-items": "flex-end" });
    expect(ruleOf(css, ".u-act")).toMatchObject({ opacity: "0" });
    expect(ruleOf(mediaBody(css, "(hover:none)"), ".u-act")).toEqual({ visibility: "hidden" });
    expect(css).not.toMatch(/\.u-act\{[^}]*display:none/);
  });

  it("a finished reply that worked for less than half a second still says one second, and one with no record of its work says no seconds", async () => {
    const quick: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Done.", thinking: "Hm.", times: stamped("done", 1, 300) };
    const html = await saved(quick);
    expect(bulb(html)).toBe("1");
    expect(chipName(html)).toBe("Thought for 1 s");
    const unknown = await saved({ id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Done.", thinking: "Hm." });
    expect(bulb(unknown)).toBeUndefined();
    expect(chipName(unknown)).toBe("Thought");
  });

  it("the live line is the sidebar's breathing dot, the seconds in a slot of fixed width, then the words, and a long call's words end in an ellipsis at the line's edge", async () => {
    const calling = play(sent(), [push(0, { stage: "thinking", readyAt: 0 }), [0, { type: "thinking", text: "Look." }], push(2000, { stage: "tool", readyAt: 0, workMs: 2000 }),
      [2000, { type: "tool", step: { ...step("a", "running"), summary: LONG } }]]);
    const line = lineOf(await live(5000, calling));
    expect(line).toBe(`<span class="run-dot"></span><span class="lv-t" aria-hidden="true">5 s</span><span class="lv-w"><span>${LONG}</span></span>`);
    const css = await styles();
    expect(ruleOf(css, ".think.fold .lv-w>span")).toMatchObject({ "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" });
    expect(ruleOf(css, ".think.fold .lv-t")).toMatchObject({ flex: "none", "min-width": "4ch" });
    const dot = ruleOf(css, ".run-dot::before");
    const sidebar = ruleOf(css, ".sb-row .live");
    for (const p of ["width", "height", "border-radius", "background", "animation"]) expect(dot?.[p], p).toBe(sidebar?.[p]);
  });

  it("a running line's name never ticks: Thinking while it thinks, the call count once it calls, never its seconds", async () => {
    const thinking = play(sent(), [push(0, { stage: "thinking", readyAt: 0 }), [0, { type: "thinking", text: "Look." }]]);
    for (const at of [3000, 7000]) {
      const html = await live(at, thinking);
      expect(says(html), "the seconds are on screen").toBe(`${at / 1000} s Thinking`);
      expect(runName(html)).toBe("Thinking");
    }
    const calling = play(thinking, [push(8000, { stage: "tool", readyAt: 0, workMs: 8000 }), [8000, { type: "tool", step: step("a", "running") }]]);
    for (const at of [9000, 14_000]) expect(runName(await live(at, calling))).toBe("Working, 1 tool call");
  });

  it("a finished line's words come back on hover and on keyboard focus, as the same words in the same place", async () => {
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Done.", thinking: "Hm.", tools: [step("a", "done", 10)], times: stamped("done", 11, 4500) };
    const html = await saved(reply);
    expect(html).toMatch(/<span class="lv-i"><svg[^>]*><use href="#i-check"><\/use><\/svg><\/span><span class="lv-h">5 s · 1 step<\/span><span class="th-x">/);
    const css = await styles();
    expect(ruleOf(css, ".lv-h")).toMatchObject({ display: "none" });
    const shown = rulesShowing(css, ".lv-h", "display:inline");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toEqual(expect.arrayContaining([".think.fold:hover .lv-h", ".think.fold:focus-visible .lv-h"]));
  });

  it("a call still running when the turn ended on an error, or when its save was interrupted, is shown as cut short, not running", async () => {
    const failed = play(sent(), [push(0, { stage: "thinking", readyAt: 0 }), [0, { type: "thinking", text: "Hm." }], push(1000, { stage: "tool", readyAt: 0, workMs: 1000 }),
      [1000, { type: "tool", step: step("a", "running") }], [3000, { type: "error", code: "model-error", message: "The model failed." }]]);
    const ended = await live(4000, failed);
    expect(ended).toContain('data-st="cut"');
    expect(ended).toContain("Shell · stopped");
    expect(ended).not.toContain("running");
    const interrupted = await saved({ id: "s", threadId: T, role: "assistant", createdAt: 2, content: "Half", thinking: "Hm.", tools: [step("a", "running")], interrupted: true,
      times: stamped("failed", 3, 1000, { code: "stream-error", message: "model runner has unexpectedly stopped" }) });
    expect(interrupted).toContain('data-st="cut"');
    expect(interrupted).toContain("Shell · stopped");
  });

  it("an older reply with no record of its rounds lists its whole thought first, then its calls, and the thought says no seconds", async () => {
    const older: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Done.", thinking: "First I plan. Then I look.",
      tools: [step("a", "done", 1000), step("b", "done", 2000)], times: stamped("done", 9, 5000) };
    const html = await saved(older);
    expect(foldItems(html)).toEqual(["think", "call", "call"]);
    expect(html).toMatch(/class="think-body"[^>]*>First I plan\. Then I look\.<\/div>/);
    expect(roundNames(html)).toEqual(["Thought"]);
  });

  it("an opened reply splits its work seconds by round: a round shows the sum of its own spans, and a round with none says Thought", async () => {
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Done.", thinking: "Look first. Then more.", tools: [step("a", "done", 4000)],
      times: { startedAt: 0, workMs: 8800, spans: [{ from: 0, ms: 1400 }, { from: 5, ms: 1400 }, { from: 15, ms: 2000 }], callsAt: { a: 11 }, ended: { reason: "done", at: 11_000 } } };
    const html = await saved(reply);
    expect(foldItems(html)).toEqual(["think", "call", "think"]);
    expect(bulb(html)).toBe("9");
    expect(roundWords(html)).toEqual(["3 s", "2 s"]);
    expect(html).toContain("4.0 s");
    const none: Message = { ...reply, times: { startedAt: 0, workMs: 6800, spans: [{ from: 0, ms: 1400 }, { from: 5, ms: 1400 }], callsAt: { a: 11 }, ended: { reason: "done", at: 9000 } } };
    const quiet = await saved(none);
    expect(bulb(quiet)).toBe("7");
    expect(roundWords(quiet)).toEqual(["3 s", "Thought"]);
    expect(roundNames(quiet)).toEqual(["Thought for 3 s", "Thought"]);
  });
});
