import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { State } from "./store.ts";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (value: unknown) => ({ current: value }),
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

afterEach(() => { setState({ messages: {}, live: null, stopNotes: {} }); vi.unstubAllGlobals(); });

it("retains interrupted text and its unfinished label in the shared live-to-saved reply slot", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({ live: null, messages: { proof: [{ id: "partial", threadId: "proof", role: "assistant", content: "A retained partial answer", createdAt: 1, interrupted: true }] } });
  const html = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  expect(html).toContain('class="turn a interrupted"');
  expect(html).toContain('aria-label="Interrupted reply"');
  expect(html).toContain("A retained partial answer");
  expect(html).toContain("excluded from later model prompts");
  expect(html).not.toContain('class="turn a done"');
});

it.each(["Stopped so Qwen 3.5 9B could load.", "Stopped when the Ollama runtime changed."])("shows only the known stop reason: %s", reason => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({ live: null, messages: { proof: [{ id: "partial", threadId: "proof", role: "assistant", content: "A retained partial answer", createdAt: 1, interrupted: true }] }, stopNotes: { partial: reason } });
  const html = renderToStaticMarkup(createElement(Timeline, { threadId: "proof" }));
  expect(html.match(/class="stop-note"/g)).toHaveLength(1);
  expect(html).toContain(`${reason} Its text is kept here and excluded from later model prompts.`);
  expect(html).not.toContain("Interrupted before this reply finished");
  expect(html).toContain("A retained partial answer");
  expect(html).toContain('aria-label="Interrupted reply"');
});

function child(node: unknown, index: number): unknown {
  if (!isValidElement<{ children: unknown }>(node)) throw new Error("Expected an element");
  return Array.isArray(node.props.children) ? node.props.children[index] : node.props.children;
}

// This is React's actual reconciliation key, before the browser renders it.
// The browser spec additionally checks DOM identity, thinking and pacing.
function keys(): (string | null)[] {
  // The conversation's loading status comes first; the reply slots follow it.
  const turns = child(child(Timeline({ threadId: "proof" }), 0), 1);
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
  setState({ messages: { proof: [user] }, live });
  const before = keys().at(-1);
  setState({ messages: { proof: [user, image] } });
  const arrived = keys();
  expect(arrived.at(-1), "image insertion must not change the live reply's reconciliation key").toBe(before);
  expect(new Set(arrived).size).toBe(arrived.length);
  const answer = { id: "answer", threadId: "proof", role: "assistant" as const, content: live.text, createdAt: 3 };
  setState({ live: null, messages: { proof: [user, image, answer] } });
  expect(keys().at(-1)).toBe(before);
  setState({ live: { ...live, gen: 2, userMessageId: undefined, pendingUser: "Next report" } });
  const pending = keys();
  expect(new Set(pending).size, "a new unadmitted send needs its own pending slot").toBe(pending.length);
});

it("keeps an unadmitted stopped reply's generation key after its pending user is cleared", () => {
  vi.stubGlobal("window", {});
  const user = { id: "user1", threadId: "proof", role: "user" as const, content: "First question", createdAt: 1 };
  const answer = { id: "answer1", threadId: "proof", role: "assistant" as const, content: "First answer", createdAt: 2 };
  const live = { gen: 2, threadId: "proof", turnId: null, model: "model", startedAt: 3, thinking: "", text: "", tools: [], pendingUser: "Second question" };
  setState({ messages: { proof: [user, answer] }, live });
  const pending = keys();
  const stopped = { ...live, pendingUser: null, end: { kind: "stopped" as const, secs: 1 } };
  setState({ live: stopped });
  const refused = keys();
  expect(refused.at(-1), "admission failure must not reuse the previous user's reply key").toBe(pending.at(-1));
  expect(new Set(refused).size).toBe(refused.length);
  expect(refused.slice(0, 2)).toEqual(pending.slice(0, 2));
  setState({ live: { ...stopped, gen: 3 } });
  expect(keys().at(-1)).not.toBe(refused.at(-1));
});
