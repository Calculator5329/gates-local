// The work fold's chip, read from the rendered timeline: the server's note is
// not a call, the bulb's seconds come from the turn's clock and never go down,
// and the red mark means only that the last call failed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ReplyTimes, ToolStep } from "@gates-local/contracts";
import { getState, type LiveTurn, setState, type State } from "./store.ts";
import { type ChatEvent, reduceTurn, type TurnEvent, type WorkClock } from "./session/turn.ts";

vi.mock("./store.ts", async (original) => {
  const actual = await original<typeof import("./store.ts")>();
  return { ...actual, useStore: <T,>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("./session.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: () => "/f" }));
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: true })); vi.stubGlobal("window", {}); vi.useFakeTimers(); });
afterEach(() => { setState({ turns: {}, messages: {}, threadId: null }); vi.unstubAllGlobals(); vi.useRealTimers(); });

/**
 * The times the server stamps on the saved row (chat row 32), as the clock this turn kept gives
 * them: the server keeps the same rounds (apps/server/src/chat/times.ts).
 */
const stamped = (clock: WorkClock | undefined, reason: ReplyTimes["ended"]["reason"], secs: number): ReplyTimes =>
  ({ startedAt: 0, spans: clock?.spans ?? [], callsAt: clock?.at ?? {}, ended: { reason, at: secs * 1000 } });

const T = "t";
const user: Message = { id: "u", threadId: T, role: "user", createdAt: 1, content: "Check my notes" };
const step = (callId: string, state: ToolStep["state"], durationMs?: number): ToolStep =>
  ({ callId, name: "shell", state, summary: "Searching your library", ...(durationMs === undefined ? {} : { durationMs }) });
/** A turn this client started at 0 and watched from there. */
const watched = (): LiveTurn => ({ gen: 1, threadId: T, turnId: "turn", model: "m", startedAt: 0, thinking: "", text: "", tools: [], pendingUser: null,
  clock: { thinking: false, since: 0, from: 0, total: 0, spans: [], at: {} } });

/** The turn after each event at its time, as chat.ts applies them. */
function play(turn: LiveTurn, events: readonly (readonly [number, TurnEvent])[]): LiveTurn {
  return events.reduce<LiveTurn>((t, [at, e]) => reduceTurn(t, e, at) ?? t, turn);
}

async function render(now: number, state: Partial<State>): Promise<string> {
  vi.setSystemTime(now);
  const { Timeline } = await import("./Thread.tsx");
  // no live turn unless the case gives one: a saved row is read alone
  setState({ threadId: T, turns: {}, ...state });
  return renderToStaticMarkup(createElement(Timeline, { threadId: T }));
}
const live = (now: number, turn: LiveTurn) => render(now, { messages: { [T]: [user] }, turns: { [T]: turn } });
/** The thinking seconds the line carries (the turn's clock); undefined when it has none. */
const bulb = (html: string) => /data-think="(\d+)"/.exec(html)?.[1];
/** The stop square's seconds; undefined when it shows none. */
const square = (html: string) => /class="stop-mark">.*?<span class="s">(\d+) s<\/span>/s.exec(html)?.[1];
const chipName = (html: string) => /class="think fold"[^>]*aria-label="([^"]*)"/.exec(html)?.[1];

describe("the server's note", () => {
  const note: ToolStep = { callId: "n", name: "note", state: "done", summary: "This model's 4K context is too small for its tools, so it answered without tools" };
  it("is not a call: no chip, and its sentence stays a plain line outside any fold", async () => {
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Hello.", thinking: "Say hello.", tools: [note] };
    const html = await render(0, { messages: { [T]: [user, reply] } });
    expect(html).not.toContain("think fold");
    expect(html).not.toContain("tool call");
    expect(html.replace(/<div class="(fold-body|think-body)".*?<\/div>/gs, "")).toContain("answered without tools");
  });
  it("with no thought, the reply has no chip and no thought line at all", async () => {
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Hello.", tools: [note] };
    const html = await render(0, { messages: { [T]: [user, reply] } });
    expect(html).not.toContain('class="think');
    expect(html).toContain("answered without tools");
  });
  it("while the reply has no words yet, the Working row shows beside the note's line", async () => {
    const html = await live(5000, { ...watched(), tools: [note] });
    expect(html).toContain('class="working"');
    expect(html).toContain("answered without tools");
  });
});

describe("the bulb's seconds are the turn's clock", () => {
  it("A: think 0-5 s, call 5-7 s, think 7-10 s, answer: 5, then 6, then 8, and the saved reply keeps 8", async () => {
    const t1 = play(watched(), [[100, { type: "thinking", text: "Look." }], [5000, { type: "tool", step: step("a", "running") }]]);
    expect(bulb(await live(6000, t1))).toBe("5");
    const t2 = play(t1, [[7000, { type: "tool", step: step("a", "done", 2000) }], [7000, { type: "thinking", text: " Again." }]]);
    expect(bulb(await live(8000, t2))).toBe("6");
    const t3 = play(t2, [[10000, { type: "delta", text: "The" }]]);
    expect(bulb(await live(10400, t3))).toBe("8");
    const saved: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "The", thinking: t3.thinking, tools: t3.tools, times: stamped(t3.clock, "done", 11) };
    expect(bulb(await render(99_000, { messages: { [T]: [user, saved] } }))).toBe("8");
  });

  it("B: text before a call keeps the turn busy: words stay, no red mid-run, and the number ends at the true 5, never dropping", async () => {
    // thinks 0-3 s, writes "Let me check." at 3 s, a call 3.5-8.5 s that fails, thinks 8.5-10 s, answers
    const t1 = play(watched(), [[0, { type: "thinking", text: "Hm." }], [3000, { type: "delta", text: "Let me check." }], [3500, { type: "tool", step: step("a", "running") }]]);
    const during = await live(5000, t1);
    expect(bulb(during)).toBe("3");
    expect(during).toContain('class="lv-w">Searching your library<');
    expect(chipName(during)).toBe("Working, 1 tool call");
    const t2 = play(t1, [[8500, { type: "tool", step: step("a", "error", 5000) }], [8500, { type: "thinking", text: " Retry." }]]);
    const after = await live(9000, t2);
    expect(bulb(after)).toBe("4");
    expect(after).not.toContain('class="lv-bad"');
    expect(after).toContain('class="lv-w">Thinking<');
    const t3 = play(t2, [[10000, { type: "delta", text: " Done." }]]);
    expect(bulb(await live(10000, t3))).toBe("5");
    const saved: Message = { id: "b", threadId: T, role: "assistant", createdAt: 2, content: t3.text, thinking: t3.thinking, tools: [step("a", "error", 5000), step("c", "done", 10)], times: stamped(t3.clock, "done", 11) };
    expect(bulb(await render(99_000, { messages: { [T]: [user, saved] } }))).toBe("5");
  });

  it("C: a turn not watched from its start shows the bulb with no number, and a remount reads the same number", async () => {
    const { clock: _none, ...unwatched } = play(watched(), [[0, { type: "thinking", text: "Hm." }], [2000, { type: "tool", step: step("a", "running") }]]);
    const html = await live(7000, unwatched);
    expect(html).toContain("think fold");
    expect(bulb(html)).toBeUndefined();
    const seen = play(watched(), [[0, { type: "thinking", text: "Hm." }], [2000, { type: "tool", step: step("a", "running") }]]);
    expect(bulb(await live(7000, seen))).toBe("2");
    expect(bulb(await live(8000, play(seen, [[8000, { type: "tool", step: step("a", "done", 6000) }]])))).toBe("2");
  });

  it("over random event orders, the shown number never goes down", async () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 40; run++) {
      let turn = watched();
      let now = 0, shown = 0, calls = 0;
      for (let i = 0; i < 14; i++) {
        now += Math.floor(rand() * 2500);
        const r = rand();
        const running = turn.tools.find((s) => s.state === "running");
        const event: TurnEvent = r < 0.4 ? { type: "thinking", text: "x" }
          : r < 0.6 ? (running ? { type: "tool", step: step(running.callId, rand() < 0.5 ? "done" : "error", 1) } : { type: "tool", step: step(`c${++calls}`, "running") })
          : r < 0.8 ? { type: "delta", text: "y" } : { type: "tool", step: step(`c${++calls}`, "running") };
        turn = reduceTurn(turn, event, now) ?? turn;
        if (turn.tools.length === 0 || turn.thinking === "") continue;
        // read between events, never before a time already read
        for (const at of [now, now + 400, now + 900]) {
          const n = Number(bulb(await live(at, turn)));
          expect(n, `run ${run}, event ${i}, at ${at}`).toBeGreaterThanOrEqual(shown);
          shown = n;
        }
        now += 900;
      }
    }
  });
});

/** A stopped reply's bulb and square numbers, live at `now` and saved after. */
async function both(turn: LiveTurn, now: number, secs: number) {
  const saved: Message = { id: "s", threadId: T, role: "assistant", createdAt: 2, content: turn.text, thinking: turn.thinking, tools: turn.tools, times: stamped(turn.clock, "stopped", secs) };
  const shown = await live(now, turn);
  const after = await render(99_000, { messages: { [T]: [user, saved] } });
  return { live: [bulb(shown), square(shown)], saved: [bulb(after), square(after)] };
}

describe("a stopped reply's time", () => {
  it("with calls, the bulb keeps the thinking and the square keeps Stop's seconds: thinking 2 s, a 15 s call, Stop at 18 s", async () => {
    const stopped = play(watched(), [[0, { type: "thinking", text: "Hm." }], [2000, { type: "tool", step: step("a", "running") }], [17_000, { type: "tool", step: step("a", "done", 15_000) }], [18_000, { type: "stop" }]]);
    expect(await both(stopped, 19_000, 18)).toEqual({ live: ["2", "18"], saved: ["2", "18"] });
  });

  it("with calls and thinking on both sides of one, each number keeps its own time", async () => {
    const stopped = play(watched(), [[0, { type: "thinking", text: "Hm." }], [2000, { type: "tool", step: step("a", "done", 10) }], [2000, { type: "thinking", text: " More." }], [4000, { type: "stop" }]]);
    expect(await both(stopped, 9000, 4)).toEqual({ live: ["4", "4"], saved: ["4", "4"] });
  });

  it("with calls and no thinking, the square carries the seconds", async () => {
    const stopped = play(watched(), [[0, { type: "tool", step: step("a", "running") }], [6000, { type: "stop" }]]);
    expect(await both(stopped, 7000, 6)).toEqual({ live: [undefined, "6"], saved: [undefined, "6"] });
  });

  it("with calls and a turn not watched from its start, the square still carries the seconds", async () => {
    const { clock: _none, ...unwatched } = play(watched(), [[0, { type: "thinking", text: "Hm." }], [2000, { type: "tool", step: step("a", "done", 10) }], [4000, { type: "stop" }]]);
    expect(await both(unwatched, 9000, 4)).toEqual({ live: [undefined, "4"], saved: [undefined, "4"] });
  });

  it("stopped while thinking, with no calls and no words, the time shows once: on the thought line, not on the square", async () => {
    const stopped = play(watched(), [[0, { type: "thinking", text: "Hm." }], [3000, { type: "stop" }]]);
    const shown = await live(5000, stopped);
    expect(shown).toContain('class="stop-mark"');
    expect(square(shown)).toBeUndefined();
    expect(shown).toMatch(/Thought for 3 s/);
  });
});

/** A chat wired to the store with nothing else behind it; its frames run when `frames()` is called. */
async function chat() {
  const pending: (() => void)[] = [];
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => pending.push(f));
  const { createChat } = await import("./session/chat.ts");
  const c = createChat({
    applyServerEvent: ((fn: (s: State) => Partial<State> | undefined) => { const patch = fn(getState()); if (patch !== undefined) setState(patch); }) as never,
    call: (async () => ({})) as never,
    codeOf: () => "x",
    createThread: async () => null,
    creatingDraft: () => false,
    loadThread: async () => {},
    loading: () => false,
    noteMessage: () => {},
    withMessage: (s, t, m) => ({ ...s.messages, [t]: [...(s.messages[t] ?? []), m] }),
    untrackedDone: () => {},
    openThread: () => {},
    blockingFor: async () => [],
  });
  /** A server event for turn "x" at time `at`. */
  const event = (at: number, e: ChatEvent) => { vi.setSystemTime(at); c.onChatEvent({ turnId: "x", threadId: T, event: e }); };
  /** The next frame at time `at`. */
  const frame = (at: number) => { vi.setSystemTime(at); for (const f of pending.splice(0)) f(); };
  return { event, frame };
}
const start = (replayed?: true): ChatEvent => ({ type: "start", model: "m", userMessage: user, ...(replayed === undefined ? {} : { replayed }) }) as ChatEvent;
const listed = (startedAt: number): LiveTurn => ({ gen: 1, threadId: T, turnId: "x", model: "", startedAt, thinking: "", text: "", tools: [], pendingUser: null, listed: true });

describe("a turn this client did not see start has no number", () => {
  // the page loads 20 s into a turn that thought 18 s and has a call running; the server replays its start and its words so far
  const sofar: readonly (readonly [number, TurnEvent])[] = [[20_010, { type: "thinking", text: "eighteen seconds of thought" }], [20_010, { type: "tool", step: step("a", "running") }]];

  it("listed first, then the replayed start", async () => {
    expect(bulb(await live(25_000, play(listed(20_000), [[20_000, start(true)], ...sofar])))).toBeUndefined();
  });

  it("listed first, then a start the server sends as it begins: watched from there", async () => {
    // the server lists a turn before it saves its question, so a listed turn's first start can be the real one
    expect(bulb(await live(25_000, play(listed(20_000), [[20_000, start()], [20_010, { type: "thinking", text: "Hm." }], [22_000, { type: "tool", step: step("a", "running") }]])))).toBe("2");
  });

  it("the replayed start first, with no turn listed yet", async () => {
    setState({ threadId: T, turns: {}, messages: { [T]: [user] } });
    const c = await chat();
    c.event(20_000, start(true));
    for (const [at, e] of sofar) c.event(at, e as ChatEvent);
    expect(getState().turns[T]?.turnId).toBe("x");
    expect(bulb(await render(25_000, { messages: { [T]: [user] }, turns: getState().turns }))).toBeUndefined();
  });

  it("a turn another device starts while this client watches gets its number", async () => {
    setState({ threadId: T, turns: {}, messages: { [T]: [user] } });
    const c = await chat();
    c.event(20_000, start());
    c.event(20_000, { type: "thinking", text: "Hm." });
    c.frame(20_016);
    c.event(22_000, { type: "tool", step: step("a", "running") });
    expect(bulb(await render(25_000, { messages: { [T]: [user] }, turns: getState().turns }))).toBe("2");
  });

  it("a watched turn the connection dropped: its replayed start leaves it with no number, words before the drop or not", async () => {
    for (const before of [[[0, { type: "thinking", text: "a" }]], []] as (readonly [number, TurnEvent])[][]) {
      const back = play(watched(), [...before, [5000, { type: "lost" }], [6000, { type: "running" }], [6000, start(true)], [6000, { type: "thinking", text: "ab" }], [6000, { type: "tool", step: step("a", "running") }]]);
      expect(bulb(await live(9000, back)), `${before.length} events before the drop`).toBeUndefined();
    }
  });
});

// The number a reply keeps once it ends, whether its chat was on screen or not, is the server's
// clock now (chat row 32): apps/server/src/chat/times.test.ts plays the same turn.

describe("the red mark", () => {
  it("means only that the last call failed: not a turn that ended on an error, not a Stop", async () => {
    const calls = play(watched(), [[0, { type: "thinking", text: "Hm." }], [1000, { type: "tool", step: step("a", "running") }], [2000, { type: "tool", step: step("a", "done", 1000) }]]);
    const failed = play(calls, [[3000, { type: "error", code: "model-error", message: "The model failed." }]]);
    const html = await live(4000, failed);
    expect(html).not.toContain('class="lv-bad"');
    expect(chipName(html)).toBe("Thinking 1 second, 1 tool call");
    const stopped = play(watched(), [[0, { type: "thinking", text: "Hm." }], [1000, { type: "tool", step: step("a", "running") }], [1500, { type: "stop" }]]);
    expect(await live(2000, stopped)).not.toContain('class="lv-bad"');
    const lastFailed = play(calls, [[2500, { type: "tool", step: step("b", "error", 10) }], [3000, { type: "delta", text: "Sorry." }], [3100, { type: "error", code: "model-error", message: "x" }]]);
    const marked = await live(4000, lastFailed);
    expect(marked).toContain('class="lv-bad"');
    expect(chipName(marked)).toBe("Thinking 1 second, 2 tool calls, 1 failed");
  });

  it("is not on a call the person stopped: the saved step says stopped after a reload, and a step that failed still says failed", async () => {
    const saved = (tools: ToolStep[]): Message => ({ id: "s", threadId: T, role: "assistant", createdAt: 2, content: "", thinking: "Hm.", tools, interrupted: true });
    const stopped = await render(9000, { messages: { [T]: [user, { ...saved([step("a", "done", 10), { ...step("b", "error", 900), stopped: true }]), times: stamped(undefined, "stopped", 3) }] } });
    expect(stopped).not.toContain('class="lv-bad"');
    expect(chipName(stopped)).toBe("Thinking, 2 tool calls");
    // the tool's label stays, as on a failed step
    expect(stopped).toContain('<span class="wr-m">Shell · stopped</span>');
    expect(stopped).not.toContain("failed");
    const failed = await render(9000, { messages: { [T]: [user, saved([step("a", "done", 10), step("b", "error", 900)])] } });
    expect(failed).toContain('class="lv-bad"');
    expect(failed).toMatch(/failed/);
  });
});

// Chat row 37, owner pick A (2026-11-13): one live line per reply.
const shell = (callId: string, state: ToolStep["state"], command: string): ToolStep => ({ callId, name: "shell", state, durationMs: 900,
  summary: state === "error" ? "Tool could not finish" : "Searched your library", detail: `${JSON.stringify({ name: "shell", input: { command } })}\nno such column` });

describe("one live line per reply", () => {
  it("while it runs: one lit mark, what it is doing now and the running time, in the line itself", async () => {
    const t1 = play(watched(), [[0, { type: "thinking", text: "Look." }], [5000, { type: "tool", step: step("a", "running") }]]);
    const during = await live(71_400, t1);
    const line = /<button[^>]*class="think fold"[^>]*>([\s\S]*?)<\/button>/.exec(during)?.[1] ?? "";
    expect(line).toContain('class="lv-dot"');
    // then the wrench and the calls so far (the icon is markup, so its 1 follows the seconds here)
    expect(line.replace(/<[^>]+>/g, "")).toBe("Searching your library · 71 s1");
    expect(line).toMatch(/class="lv-c"><svg[^>]*><use href="#i-wrench"><\/use><\/svg>1<\/span>/);
    expect(during, "no second node beside it").not.toContain("fold-now");
    // the same nodes when the call ends and it thinks again: words and digits change, nothing else
    const t2 = play(t1, [[72_000, { type: "tool", step: step("a", "done", 67_000) }], [72_000, { type: "thinking", text: " More." }]]);
    const next = /<button[^>]*class="think fold"[^>]*>([\s\S]*?)<\/button>/.exec(await live(73_000, t2))?.[1] ?? "";
    expect(next.replace(/>[^<]*</g, "><")).toBe(line.replace(/>[^<]*</g, "><"));
    expect(next.replace(/<[^>]+>/g, ""), "the count stays once the call has ended").toBe("Thinking · 73 s1");
  });

  it("after: the time, the step count and how many failed, with no sentence for a failed step", async () => {
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Tennessine.", thinking: "Which table?",
      tools: [shell("a", "error", "sqlite3 elements.db 'SELECT name, discovery_date'"), shell("b", "error", "sqlite3 elements.db .schema"), shell("c", "done", "sqlite3 elements.db 'ORDER BY year DESC'")],
      times: { startedAt: 0, spans: [{ from: 0, ms: 33_000 }], callsAt: { a: 12, b: 12, c: 12 }, ended: { reason: "done", at: 71_000 } } };
    const html = await render(99_000, { messages: { [T]: [user, reply] } });
    const line = /<button[^>]*class="think fold"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? "";
    expect(line).not.toContain("lv-dot");
    expect(line.replace(/<[^>]+>/g, "")).toBe("71 s · 3 steps · 2 failed");
    expect(line).toMatch(/class="lv-bad">[^<]*2 failed/);
    expect(html).not.toContain("Tool could not finish");
    // a failed step is its command with a red mark
    expect(html).toMatch(/data-st="rej"[\s\S]*?class="wr-h">sqlite3 elements.db &#x27;SELECT name, discovery_date&#x27;</);
    // the opened list says a round's seconds once: no "Thought ·" before them
    expect(html).toMatch(/class="th-line"[^>]*aria-label="Thought for 33 s"[^>]*>[\s\S]*?class="wr-h">33 s</);
  });

  it("a step Stop cut short is not counted or marked as failed", async () => {
    const cut: ToolStep = { ...shell("a", "error", "sqlite3 elements.db .schema"), stopped: true };
    const reply: Message = { id: "a", threadId: T, role: "assistant", createdAt: 2, content: "", thinking: "Which table?", tools: [cut],
      times: { startedAt: 0, spans: [{ from: 0, ms: 3000 }], callsAt: { a: 3 }, ended: { reason: "stopped", at: 9000 } } };
    const html = await render(99_000, { messages: { [T]: [user, reply] } });
    expect(html).toContain('data-st="cut"');
    expect(html).not.toContain('data-st="rej"');
    expect(html).not.toContain("lv-bad");
  });
});
