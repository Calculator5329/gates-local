import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { CHAT_MODELS, suggestedList, type CatalogEntry, type ImagePreset, type Message, type Reply } from "@gates-local/contracts";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { LiveTurn, TurnClock } from "../lib/store/store.ts";
import { FakeDocument, FakeElement, FakeIFrame } from "../../test/fake-dom.ts";

const runs = vi.hoisted(() => ({ modelChanges: 0 }));
vi.mock("./model-change.ts", async (original) => {
  const actual = await original<typeof import("./model-change.ts")>();
  return {
    ...actual,
    modelChanges: (...args: Parameters<typeof actual.modelChanges>) => {
      runs.modelChanges++;
      return actual.modelChanges(...args);
    },
  };
});
vi.mock("../lib/session/index.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: vi.fn(), loadEarlier: vi.fn(async () => false), earlierOf: () => 0, onEarlier: () => () => undefined }));

const doc = new FakeDocument();
let root: Root;
let store: typeof import("../lib/store/store.ts");

const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

beforeAll(async () => {
  const win = { document: doc, HTMLIFrameElement: FakeIFrame, matchMedia: media, requestIdleCallback: () => 0, cancelIdleCallback() {}, addEventListener() {}, removeEventListener() {} };
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

const Z_TURBO: ImagePreset = { id: "z-image-int8", name: "Z-Image Turbo int8", short: "Z-Image", family: "flux", measured: true, sizes: [{ width: 1024, height: 1024, bytes: 0 }] };
const QWEN_ENTRY: CatalogEntry = { name: "qwen3.5:9b", label: "Qwen 3.5 9B", purpose: "", downloadBytes: 0, installed: true, recommended: false };
const GEMMA_ENTRY: CatalogEntry = { name: "gemma4:e4b", label: "Gemma 4 E4B", purpose: "", downloadBytes: 0, installed: true, recommended: false };

beforeEach(() => {
  act(() => store.setState({
    suggested: suggestedList(CHAT_MODELS),
    catalog: [QWEN_ENTRY, GEMMA_ENTRY],
    imagePresets: { presets: [Z_TURBO], current: { preset: Z_TURBO, width: 1024, height: 1024 } },
    messages: {}, turns: {}, replies: new Map(),
  }));
});

const ask = (id: string, content: string): Message => ({ id, threadId: "T", role: "user", content, createdAt: 1 });
const answer = (id: string, model: string): Message => ({ id, threadId: "T", role: "assistant", content: "Lighthouses guide ships.", model, createdAt: 2 });
const clock = (stage: TurnClock["stage"]): TurnClock => ({ stage, startedAt: 1, workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {} });
const live = (model: string, more: Partial<LiveTurn> = {}): LiveTurn => ({ threadId: "T", turnId: "running", model, startedAt: 1, thinking: "", text: "", tools: [], ...more });
const starting = (text: string): Reply => ({ id: "running", threadId: "T", rev: 1, messageId: "m-running", text, at: 1, stage: "starting", attempt: 1, startedAt: 1 });

const lines = () => doc.body.querySelectorAll(".model-change");
const names = (line: FakeElement | undefined) => line?.querySelectorAll(".mc-name").map((n) => n.textContent);
/** The element right after the line: what the line sits above. */
const under = (line: FakeElement | undefined) => {
  const next = line?.nextSibling;
  return next instanceof FakeElement ? next : undefined;
};

async function mount(key: string) {
  const { Timeline } = await import("./Thread.tsx");
  act(() => root.render(createElement(Timeline, { threadId: "T", key })));
}

it("puts the line for a live question not saved yet directly above its pending bubble, from the turn's first frame", async () => {
  act(() => store.setState({
    messages: { T: [ask("u1", "What guides ships?"), answer("a1", "qwen3.5:9b")] },
    turns: { T: live("z-image-int8", { reply: clock("drawing") }) },
    replies: new Map([["running", starting("a lighthouse at dusk")]]),
  }));
  await mount("unsaved");
  expect(lines()).toHaveLength(1);
  const line = lines()[0];
  expect(names(line)).toEqual(["Qwen 3.5 9B", "Z-Image"]);
  expect(under(line)?.classList).toEqual(["turn", "u"]);
  expect(under(line)?.textContent).toContain("a lighthouse at dusk");
});

it("draws the line above a saved question whose live turn went to another model, for a chat model and for a picture setup alike", async () => {
  const thread = [ask("u1", "What guides ships?"), answer("a1", "qwen3.5:9b"), ask("u2", "And at night?")];
  act(() => store.setState({ messages: { T: thread }, turns: { T: live("gemma4:e4b", { userMessageId: "u2" }) } }));
  await mount("saved-chat");
  expect(lines()).toHaveLength(1);
  expect(names(lines()[0])).toEqual(["Qwen 3.5 9B", "Gemma 4 E4B"]);
  expect(under(lines()[0])?.textContent).toContain("And at night?");
  act(() => store.setState({ turns: { T: live("z-image-int8", { userMessageId: "u2", reply: clock("drawing") }) } }));
  expect(lines()).toHaveLength(1);
  expect(names(lines()[0])).toEqual(["Qwen 3.5 9B", "Z-Image"]);
  expect(under(lines()[0])?.textContent).toContain("And at night?");
});

it("works the lines out again when the messages change, never for a token of the live reply", async () => {
  const thread = [ask("u1", "What guides ships?"), answer("a1", "qwen3.5:9b"), ask("u2", "And at night?")];
  const writing = live("gemma4:e4b", { userMessageId: "u2", reply: clock("writing") });
  act(() => store.setState({ messages: { T: thread }, turns: { T: writing } }));
  await mount("tokens");
  const before = runs.modelChanges;
  for (const text of ["A", "A beam", "A beam sweeps", "A beam sweeps the sea."]) act(() => store.setState({ turns: { T: { ...writing, text } } }));
  expect(runs.modelChanges - before, "model-change passes run by four tokens").toBe(0);
  expect(names(lines()[0])).toEqual(["Qwen 3.5 9B", "Gemma 4 E4B"]);
  act(() => store.setState({ messages: { T: [...thread, ask("u3", "And in fog?")] } }));
  expect(runs.modelChanges - before, "a new message is worked out").toBeGreaterThan(0);
});
