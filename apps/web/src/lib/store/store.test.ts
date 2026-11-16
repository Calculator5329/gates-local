import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Reply } from "@gates-local/contracts";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame } from "../../../test/fake-dom.ts";
import { type LiveTurn, getState, runningThreads, setState, unsavedQuestion, useStore } from "./store.ts";

const doc = new FakeDocument();
const renders = { threads: 0, search: 0 };
let root: Root;

function ThreadCount() {
  const threads = useStore((s) => s.threads);
  renders.threads++;
  return createElement("i", null, String(threads.length));
}

function SearchWords() {
  const search = useStore((s) => s.search);
  renders.search++;
  return createElement("b", null, search);
}

const turn = (threadId: string, over: Partial<LiveTurn> = {}): LiveTurn => ({ threadId, turnId: `r-${threadId}`, model: "qwen3:8b", startedAt: 1, thinking: "", text: "", tools: [], ...over });
const starting = (id: string, over: Partial<Extract<Reply, { stage: "starting" }>> = {}): Reply =>
  ({ id, threadId: "A", rev: 1, messageId: `m-${id}`, text: "what is a quasar?", at: 1, stage: "starting", attempt: 1, startedAt: 1, ...over });
const saved = (id: string): Reply =>
  ({ id, threadId: "A", rev: 2, questionId: `m-${id}`, model: "qwen3:8b", startedAt: 1, workMs: 0, toolMs: 0, try: 1, spans: [], callsAt: {}, stage: "loading" });

beforeAll(async () => {
  doc.defaultView = { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", doc.defaultView);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterEach(() => { act(() => root.render(null)); });
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it("a change to one part of the state keeps every other part as it was, and a reader of an unchanged part does not draw again", () => {
  setState({ threads: [{ id: "A", title: "A", createdAt: 1, updatedAt: 1 }], search: "" });
  act(() => root.render(createElement("div", null, createElement(ThreadCount), createElement(SearchWords))));
  const before = getState();
  const drawn = { ...renders };
  act(() => setState({ search: "quasar" }));
  const after = getState();
  expect(after.search).toBe("quasar");
  for (const key of Object.keys(before) as (keyof typeof before)[]) if (key !== "search") expect(after[key], key).toBe(before[key]);
  expect(renders.threads).toBe(drawn.threads);
  expect(renders.search).toBe(drawn.search + 1);
});

it("before a reply is saved its question is its record's own words, the same object through other changes, and none once the saved row has taken its place", () => {
  const live = turn("A", { turnId: "r1" });
  setState({ turns: { A: live }, replies: new Map([["r1", starting("r1")]]) });
  const asked = unsavedQuestion(getState(), live);
  expect(asked?.text).toBe("what is a quasar?");
  setState({ search: "anything", turns: { A: { ...live, text: "A quasar" } } });
  expect(unsavedQuestion(getState(), live)).toBe(asked);
  setState({ replies: new Map([["r1", saved("r1")]]) });
  expect(unsavedQuestion(getState(), live)).toBeUndefined();
});

it("a Retry starting has no question of its own on screen: its question is in the chat already", () => {
  const live = turn("A", { turnId: "r2" });
  setState({ turns: { A: live }, replies: new Map([["r2", starting("r2", { retryOf: "m-earlier" })]]) });
  expect(unsavedQuestion(getState(), live)).toBeUndefined();
});

it("the set of chats with a reply on its way stays the same object while words arrive, and is new only when a chat joins or leaves it", () => {
  setState({ turns: { A: turn("A") } });
  const first = runningThreads(getState());
  expect([...first]).toEqual(["A"]);
  setState({ turns: { A: turn("A", { text: "a word" }) } });
  expect(runningThreads(getState())).toBe(first);
  setState({ turns: { A: turn("A", { text: "a word" }), B: turn("B") } });
  const both = runningThreads(getState());
  expect(both).not.toBe(first);
  expect([...both].toSorted()).toEqual(["A", "B"]);
  setState({ turns: { A: turn("A", { text: "a word", end: { kind: "stopped", secs: 2 } }), B: turn("B", { text: "more" }) } });
  expect([...runningThreads(getState())]).toEqual(["B"]);
});
