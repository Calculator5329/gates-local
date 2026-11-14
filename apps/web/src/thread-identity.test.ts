import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { State } from "./store.ts";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [typeof value === "function" ? value() : value, () => undefined],
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}));
vi.mock("./store.ts", async (original) => {
  const actual = await original<typeof import("./store.ts")>();
  return { ...actual, useStore: <T,>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("./session.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: vi.fn() }));
import { Timeline } from "./Thread.tsx";
import { setState } from "./store.ts";

afterEach(() => { setState({ messages: {}, turns: {} }); vi.unstubAllGlobals(); });

/** The times the server saved on a row (chat row 32): a turn that started at 1 s and ended `secs` later. */
const times = (reason: "done" | "stopped" | "preempted" | "failed", secs: number, more: object = {}) =>
  ({ startedAt: 1_000, spans: [], callsAt: {}, ended: { reason, at: 1_000 + secs * 1_000 }, ...more });

/** The stop square's name and tooltip: the one place the app says a stopped reply stays out of later prompts. */
const UNSEEN = "Stopped. The model won&#x27;t see this reply.";
/** Focusable (tabindex 0), so the keyboard reaches the square's tooltip. */
const MARK = `role="img" data-testid="chat.reply.unseen-mark" tabindex="0" aria-label="${UNSEEN}" data-tip="${UNSEEN}"`;
const OLD_WORDS = /excluded from later model prompts|Its text is kept here|Stopped after|Interrupted before this reply finished/;

it("marks an interrupted reply whose cause this client does not know (a reload) with the stop square alone", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({ turns: {}, messages: { proof: [{ id: "partial", threadId: "proof", role: "assistant", content: "A retained partial answer", createdAt: 1, interrupted: true }] } });
  const html = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  expect(html).toContain('class="turn a interrupted"');
  expect(html).toContain('aria-label="Interrupted reply"');
  expect(html).toContain("A retained partial answer");
  expect(html.split(MARK)).toHaveLength(2);
  expect(html).toMatch(/<div class="a-act stop"><span class="stop-mark"><span [^>]*><\/span><\/span>/);
  expect(html).not.toMatch(OLD_WORDS);
  expect(html).not.toContain('class="stop-note"');
  expect(html).not.toContain('class="turn a done"');
});

it("marks a reply the person stopped with the stop square and its seconds in its actions row, and no line of words, from the row alone (a reload, a second window)", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({ turns: {}, messages: { proof: [{ id: "partial", threadId: "proof", role: "assistant", content: "A retained partial answer", createdAt: 1, interrupted: true, times: times("stopped", 187) }] } });
  const html = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  expect(html.split(MARK)).toHaveLength(2);
  expect(html).toMatch(/<div class="a-act stop"><span class="stop-mark"><span [^>]*><\/span><span class="s">187 s<\/span><\/span>/);
  expect(html).not.toMatch(OLD_WORDS);
  expect(html).not.toContain('class="stop-note"');
});

it.each([
  ["Stopped so Qwen 3.5 9B could load.", "preempted", { code: "preempted", message: "Another model needed the memory", neededBy: "qwen3.5:9b" }],
  ["Stopped when the Ollama runtime changed.", "preempted", { code: "runtime-changed", message: "The runtime changed" }],
] as const)("shows only the known stop reason, in its own words, with the stop square: %s", (reason, ended, why) => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({ turns: {}, messages: { proof: [{ id: "partial", threadId: "proof", role: "assistant", content: "A retained partial answer", createdAt: 1, interrupted: true, times: times(ended, 9, { why }) }] } });
  const html = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  expect(html.match(/class="stop-note"/g)).toHaveLength(1);
  expect(html).toMatch(new RegExp(`<div class="stop-note" role="status"><span class="stop-mark"><span ${MARK}></span></span>${reason.replace(/[.']/g, (c) => c === "." ? "\\." : "&#x27;")}</div>`));
  expect(html.split(MARK)).toHaveLength(2);
  expect(html).not.toContain('class="a-act stop"');
  expect(html).not.toMatch(OLD_WORDS);
  expect(html).toContain("A retained partial answer");
  expect(html).toContain('aria-label="Interrupted reply"');
});

it("a reply that did not finish is never drawn as stopped: no square, its words, Retry and the runtime's text in the tip (decision 7)", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({ turns: {}, messages: { proof: [{ id: "partial", threadId: "proof", role: "assistant", content: "A retained partial answer", createdAt: 1, interrupted: true, times: times("failed", 9, { why: { code: "model-error", message: "the model crashed" } }) }] } });
  const html = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  expect(html).toMatch(/data-testid="chat.reply.failed" data-tip="the model crashed"><svg[\s\S]*?<span>The reply didn&#x27;t finish.<\/span><button[^>]*data-testid="chat.reply.retry"/);
  expect(html).not.toContain(MARK);
  expect(html).not.toContain('class="stop-note"');
  expect(html).toContain("A retained partial answer");
});

it("keeps a reason under a question with no reply as words alone: there is no reply for the model not to see", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({ turns: {}, messages: { proof: [{ id: "q", threadId: "proof", role: "user", content: "A question", createdAt: 1, times: times("preempted", 2, { why: { code: "preempted", message: "Another model needed the memory" } }) }] } });
  const html = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  // under-u: the note starts below the message's action row, so the row's unseen Edit and Copy never sit over it
  expect(html).toContain('<div class="stop-note under-u" role="status">Stopped so another model could load.</div>');
  expect(html).not.toContain(UNSEEN);
});

it("draws the saved reply's row the moment Stop ends a reply: the mark, then Regenerate, off until the server has ended the turn", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const turn = { threadId: "proof", gen: 1, model: "m", startedAt: 1, text: "Words so far", thinking: "", tools: [], pendingUser: null, end: { kind: "stopped", secs: 187 } };
  for (const ending of [true, false]) {
    setState({ messages: { proof: [] }, turns: { proof: { ...turn, ...(ending ? { ending } : {}) } as never } });
    const html = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
    expect(html).toMatch(/<div class="a-act stop"><span class="stop-mark"><span [^>]*><\/span><span class="s">187 s<\/span><\/span>/);
    expect(html).not.toContain('class="stopped"');
    expect(html.match(/<button [^>]*aria-label="Regenerate"[^>]*>/)?.[0]).toMatch(ending ? /\sdisabled=""/ : /^(?![^>]*\sdisabled)/);
    expect(html.split(MARK)).toHaveLength(2);
    expect(html).not.toMatch(OLD_WORDS);
  }
});

it("a reply stopped while thinking keeps Stop's seconds on the thought's pill, not on the square too, live and saved", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  // the server's record held still where Stop ended it (decision 33)
  const reply = { stage: "ended", startedAt: 1, readyAt: 1, workMs: 4_000, toolMs: 0, attempt: 1, spans: [], callsAt: {} };
  const live = { threadId: "proof", gen: 1, model: "m", startedAt: 1, text: "", thinking: "The question is short", tools: [], pendingUser: null, end: { kind: "stopped", secs: 4 }, reply, replyAt: 5_000 };
  setState({ messages: { proof: [] }, turns: { proof: live as never } });
  const liveHtml = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  setState({ turns: {}, messages: { proof: [{ id: "partial", threadId: "proof", role: "assistant", content: "", thinking: "The question is short", createdAt: 1, interrupted: true, times: times("stopped", 4, { thoughtMs: 4_000, spans: [{ from: 0, ms: 4_000 }] }) }] } });
  const savedHtml = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  for (const html of [liveHtml, savedHtml]) {
    expect(html).toContain("Thought for 4 s");
    expect(html.split(MARK)).toHaveLength(2);
    expect(html).not.toContain('class="s"');
  }
});

it("chat row 32: a finished reply's thought and first-token times come from its row, so a reload and a second window show what the first window showed", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const reply = { id: "a", threadId: "proof", role: "assistant" as const, content: "The answer", thinking: "Short question", model: "qwen3.5:9b", createdAt: 1,
    times: times("done", 5, { firstTokenAt: 4_200, thoughtMs: 2_600, spans: [{ from: 0, ms: 2_600 }] }) };
  setState({ turns: {}, messages: { proof: [reply] } });
  const html = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  expect(html).toContain("Thought for 3 s");
  // the numbers under the reply are its work and speed, never the wait for the first word (decision 4)
  expect(html).toContain('<span class="meta">2.6 s</span>');
  expect(html).not.toContain("to first token");
});

const at = (id: string, role: "user" | "assistant", more: object = {}) => ({ id, threadId: "proof", role, content: `Words of ${id}`, createdAt: 1, ...more });

it("marks exactly the turns with a stop note under them, whatever state the turn is in", () => {
  // the mark is what gives the turn's gap up to its note (styles.css, `.col>.turn.noted`): a note
  // under an unmarked turn sits a whole gap too low, a marked turn with no note loses its gap
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({
    turns: {},
    messages: { proof: [at("u1", "user"), at("a1", "assistant", { times: times("done", 2) }), at("u2", "user"), at("a2", "assistant", { times: times("failed", 2, { why: { code: "model-error", message: "" } }) }),
      at("u3", "user", { times: times("stopped", 3) }), at("a3", "assistant", { interrupted: true, times: times("stopped", 3) }),
      at("u4", "user", { times: times("preempted", 1, { why: { code: "preempted", message: "Another model needed the memory" } }) })] },
  });
  const html = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  const classes = [...html.matchAll(/<div class="(turn [^"]*|stop-note[^"]*)"/g)].map((m) => m[1]);
  // a reply the person stopped carries its mark in its own actions row, so it has no note and keeps its gap;
  // a failed reply says so inside itself, with Retry (decision 7), so it has no note either
  expect(classes).toEqual(["turn u", "turn a done", "turn u", "turn a done", "turn u", "turn a interrupted", "turn u noted", "stop-note under-u"]);
  expect(html.match(/data-testid="chat.reply.failed"/g)).toHaveLength(1);
});

function child(node: unknown, index: number): unknown {
  if (!isValidElement<{ children: unknown }>(node)) throw new Error("Expected an element");
  return Array.isArray(node.props.children) ? node.props.children[index] : node.props.children;
}

// This is React's actual reconciliation key, before the browser renders it.
// The browser spec additionally checks DOM identity, thinking and pacing.
function keys(): (string | null)[] {
  // The conversation's loading status and the Load earlier slot come first; the reply slots follow.
  const turns = child(child(Timeline({ threadId: "proof" }), 0), 2);
  if (!Array.isArray(turns)) throw new Error("Expected reply slots");
  return turns.map((turn: unknown) => {
    if (!isValidElement(turn)) throw new Error("Expected a keyed turn");
    return turn.key;
  });
}

it("keeps the live reply's owning-user key when an image card arrives and the reply saves", () => {
  vi.stubGlobal("window", {});
  const user = { id: "user", threadId: "proof", role: "user" as const, content: "A ship and a report", createdAt: 1 };
  const image = { id: "image", threadId: "proof", role: "assistant" as const, content: "a ship", createdAt: 2, imageJob: { jobId: "image", threadId: "proof", state: "queued" as const } };
  const live = { gen: 1, threadId: "proof", turnId: "turn", userMessageId: "user", model: "model", startedAt: 1, thinking: "Checking the report", text: "The report total is 42.", tools: [], pendingUser: null };
  setState({ messages: { proof: [user] }, turns: { proof: live } });
  const before = keys().at(-1);
  setState({ messages: { proof: [user, image] } });
  const arrived = keys();
  expect(arrived.at(-1), "image insertion must not change the live reply's reconciliation key").toBe(before);
  expect(new Set(arrived).size).toBe(arrived.length);
  const answer = { id: "answer", threadId: "proof", role: "assistant" as const, content: live.text, createdAt: 3 };
  setState({ turns: {}, messages: { proof: [user, image, answer] } });
  expect(keys().at(-1)).toBe(before);
  setState({ turns: { proof: { ...live, gen: 2, userMessageId: undefined, pendingUser: "Next report" } } });
  const pending = keys();
  expect(new Set(pending).size, "a new unadmitted send needs its own pending slot").toBe(pending.length);
});

it("keeps an unadmitted stopped reply's generation key after its pending user is cleared", () => {
  vi.stubGlobal("window", {});
  const user = { id: "user1", threadId: "proof", role: "user" as const, content: "First question", createdAt: 1 };
  const answer = { id: "answer1", threadId: "proof", role: "assistant" as const, content: "First answer", createdAt: 2 };
  const live = { gen: 2, threadId: "proof", turnId: null, model: "model", startedAt: 3, thinking: "", text: "", tools: [], pendingUser: "Second question" };
  setState({ messages: { proof: [user, answer] }, turns: { proof: live } });
  const pending = keys();
  const stopped = { ...live, pendingUser: null, end: { kind: "stopped" as const, secs: 1 } };
  setState({ turns: { proof: stopped } });
  const refused = keys();
  expect(refused.at(-1), "admission failure must not reuse the previous user's reply key").toBe(pending.at(-1));
  expect(new Set(refused).size).toBe(refused.length);
  expect(refused.slice(0, 2)).toEqual(pending.slice(0, 2));
  setState({ turns: { proof: { ...stopped, gen: 3 } } });
  expect(keys().at(-1)).not.toBe(refused.at(-1));
});
