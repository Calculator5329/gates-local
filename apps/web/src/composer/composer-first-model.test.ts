// No model yet and the first one offered above the composer: the box does not say "download a
// model" a second time. The Send button, off until a model exists, still says why.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { State } from "../lib/store/store.ts";

vi.mock("../lib/store/store.ts", async (original) => {
  const actual = await original<typeof import("../lib/store/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
import { setState } from "../lib/store/store.ts";
import { replaceDraft } from "../lib/store/drafts.ts";

const NEEDS = "Download a model to start chatting";
const entry = { name: "qwen3.5:9b", label: "Qwen 3.5 9B", purpose: "Everyday answers", downloadBytes: 6_600_000_000, installed: false, recommended: true, rank: 0 };
let Composer: typeof import("./Composer.tsx")["Composer"];
const html = () => renderToStaticMarkup(createElement(Composer));
const box = () => html().match(/<textarea[^>]*>/)?.[0] ?? "";
beforeAll(async () => {
  vi.stubGlobal("window", {});
  Composer = (await import("./Composer.tsx")).Composer;
});
beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  replaceDraft(null, { text: "" });
  setState({ conn: { kind: "open" }, hydrationSettled: true, runtime: { state: "ready", owner: "app", baseUrl: "http://127.0.0.1:1" }, models: [], model: undefined, catalog: [entry], pop: null });
});
afterEach(() => vi.unstubAllGlobals());

it("with the first model offered, the box keeps its everyday words", () => {
  expect(box()).toContain('placeholder="Ask anything…"');
  expect(html()).not.toContain(NEEDS);
});

it("with nothing to offer, the box is where the missing model is said", () => {
  setState({ catalog: [] });
  expect(box()).toContain(`placeholder="${NEEDS}"`);
});

it("typed words with no model: Send says why it is off, offer or not", () => {
  replaceDraft(null, { text: "hello" });
  expect(html()).toContain(NEEDS);
  expect(box()).toContain('placeholder="Ask anything…"');
});
