// The composer's notice keeps its full error on screen.
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

const detail = "The message could not be sent. " + "The full explanation remains available. ".repeat(6);
let Composer: typeof import("./Composer.tsx")["Composer"];
const offerShown = () => renderToStaticMarkup(createElement(Composer)).includes('data-testid="chat.composer.offer"');
const notice = () => renderToStaticMarkup(createElement(Composer)).match(/<p[^>]*class="na c-note"[^>]*>[\s\S]*?<\/p>/)?.[0];
beforeAll(async () => {
  vi.stubGlobal("window", {});
  Composer = (await import("./Composer.tsx")).Composer;
});
beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  replaceDraft(null, { text: "A draft" });
  setState({ notice: detail, models: [], model: undefined, pop: null });
});
afterEach(() => vi.unstubAllGlobals());

// decision 19 B: the notice wraps, so its whole text is on screen and a tip would only say it again
it("shows the full error once, in the notice itself, with no tip repeating it", () => {
  const html = notice();
  expect(html).toContain(detail);
  expect(html).not.toContain("data-tip");
});

it("has no notice when there is no failure", () => {
  setState({ notice: null });
  expect(notice()).toBeUndefined();
});

it("a memory refusal's offer shows in the note only while the note still says the words it came with", () => {
  const refused = "qwen3.5:9b at 32K doesn't fit in GPU memory.";
  const short = { needBytes: 0, gpuBytes: 0, ramBytes: 0, shortBytes: 0 };
  setState({ notice: refused, noticeOffer: { notice: refused, model: "qwen3.5:9b", numCtx: 32768, offer: { short, context: { numCtx: 8192, verdict: "fits" } } } });
  expect(offerShown()).toBe(true);
  setState({ notice: "The image models are still being read. Send again in a moment." });
  expect(offerShown()).toBe(false);
  expect(notice()).toContain("The image models are still being read.");
});
