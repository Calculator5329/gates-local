// The composer's notice keeps its full error on screen.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { State } from "../src/store.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
import { setState } from "../src/store.ts";
import { replaceDraft } from "../src/drafts.ts";

const detail = "The message could not be sent. " + "The full explanation remains available. ".repeat(6);
let Composer: typeof import("../src/Composer.tsx")["Composer"];
const notice = () => renderToStaticMarkup(createElement(Composer)).match(/<p[^>]*class="na c-note"[^>]*>[\s\S]*?<\/p>/)?.[0];
beforeAll(async () => {
  vi.stubGlobal("window", {});
  Composer = (await import("../src/Composer.tsx")).Composer;
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
