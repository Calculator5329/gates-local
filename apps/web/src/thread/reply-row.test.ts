import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Message, ReplyTimes } from "@gates-local/contracts";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { LiveTurn } from "../lib/store/store.ts";
import { FakeDocument, FakeElement, FakeIFrame } from "../../test/fake-dom.ts";

vi.mock("../lib/session/index.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: vi.fn(), loadEarlier: vi.fn(async () => false), earlierOf: () => 0, onEarlier: () => () => undefined }));

const doc = new FakeDocument();
const glRows: { renders: Record<string, number> } = { renders: {} };
let root: Root;
let store: typeof import("../lib/store/store.ts");

const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

beforeAll(async () => {
  const win = { document: doc, HTMLIFrameElement: FakeIFrame, matchMedia: media, requestIdleCallback: () => 0, cancelIdleCallback() {}, addEventListener() {}, removeEventListener() {}, glRows };
  doc.defaultView = win;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("matchMedia", media);
  vi.stubGlobal("requestIdleCallback", () => 0);
  vi.stubGlobal("cancelIdleCallback", () => {});
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("HTMLElement", FakeElement);
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
beforeEach(() => {
  act(() => root.render(createElement("div")));
  act(() => store.setState({ messages: {}, turns: {} }));
  glRows.renders = {};
});

const ask = (id: string, content = `Question ${id}`, more: Partial<Message> = {}): Message => ({ id, threadId: "T", role: "user", content, createdAt: 1, ...more });
const answer = (id: string, more: Partial<Message> = {}): Message => ({ id, threadId: "T", role: "assistant", content: `Answer ${id}`, model: "qwen3.5:9b", createdAt: 2, ...more });
const pairs = (n: number) => Array.from({ length: n }, (_, i) => [ask(`u${i}`), answer(`a${i}`)]).flat();
const failed = (message: string): ReplyTimes => ({ startedAt: 1_000, spans: [], callsAt: {}, ended: { reason: "failed", at: 3_000 }, why: { code: "model-error", message } });
const live = (more: Partial<LiveTurn>): LiveTurn => ({ threadId: "T", turnId: "running", userMessageId: "u0", model: "qwen3.5:9b", startedAt: 1, thinking: "", text: "", tools: [], ...more });

async function mount(key: string) {
  const { Timeline } = await import("./Thread.tsx");
  act(() => root.render(createElement(Timeline, { threadId: "T", key })));
}

async function subscriptionsFor(messages: readonly Message[], key: string): Promise<number> {
  act(() => root.render(createElement("div")));
  act(() => store.setState({ messages: { T: messages } }));
  const before = store.listenerCount();
  await mount(key);
  return store.listenerCount() - before;
}

const failLine = (scope: string) => doc.body.querySelector(`${scope} [data-testid="chat.reply.failed"]`);
const failWords = (line: FakeElement | null) => line?.querySelector("span")?.textContent;

it("a saved reply reads nothing from the store: ten saved replies hold as many store subscriptions as one", async () => {
  const one = await subscriptionsFor(pairs(1), "one");
  const ten = await subscriptionsFor(pairs(10), "ten");
  expect(doc.body.querySelectorAll(".turn.a")).toHaveLength(10);
  expect(ten).toBe(one);
});

it("a saved reply with no picture is not drawn again when a message is added; one whose picture links read the thread is", async () => {
  const picture = answer("a0", { tools: [{ callId: "c0", name: "image", state: "done", summary: "Drew a lighthouse" }] });
  const thread = [ask("u0"), picture, ask("u1"), answer("a1"), ask("u2"), answer("a2")];
  act(() => store.setState({ messages: { T: thread } }));
  await mount("grow");
  expect([glRows.renders["a0"], glRows.renders["a1"]]).toEqual([1, 1]);
  act(() => store.setState({ messages: { T: [...thread, ask("u3")] } }));
  expect(glRows.renders["a0"], "the row that reads the thread").toBe(2);
  expect(glRows.renders["a1"], "a plain saved reply").toBe(1);
});

it("a live reply that ended because its model gave way or its runtime changed, or because its context was too small, says the server's own words", async () => {
  const cases = [
    ["preempted", "Stopped so Gemma 4 E4B could load.", "Stopped so Gemma 4 E4B could load."],
    ["runtime-changed", "Stopped when the Ollama runtime changed.", "Stopped when the Ollama runtime changed."],
    ["context-too-small", "This chat no longer fits in the model's context.", "This chat no longer fits in the model's context."],
    ["model-error", "llama runner process has terminated", "The reply didn't finish."],
  ] as const;
  for (const [code, message, words] of cases) {
    act(() => root.render(createElement("div")));
    act(() => store.setState({ messages: { T: [ask("u0")] }, turns: { T: live({ text: "Partly", end: { kind: "error", code, message } }) } }));
    await mount(code);
    const line = failLine(".turn.a");
    expect(failWords(line), code).toBe(words);
    expect(line?.getAttribute("data-tip"), code).toBe(message);
  }
});

it("a question whose reply failed before its first word carries the failed reply's line: its words, the runtime's text in the tip, and Retry only on the last turn", async () => {
  const question = ask("u0", "What guides ships?", { times: failed("the model crashed") });
  act(() => store.setState({ messages: { T: [question] } }));
  await mount("last");
  const last = failLine(".stop-note.under-u");
  expect(failWords(last)).toBe("The reply didn't finish.");
  expect(last?.getAttribute("data-tip")).toBe("the model crashed");
  expect(last?.querySelector('[data-testid="chat.reply.retry"]')?.textContent).toBe("Retry");
  act(() => store.setState({ messages: { T: [question, ask("u1"), answer("a1")] } }));
  const earlier = failLine(".stop-note.under-u");
  expect(failWords(earlier)).toBe("The reply didn't finish.");
  expect(earlier?.querySelector('[data-testid="chat.reply.retry"]')).toBeNull();
});
