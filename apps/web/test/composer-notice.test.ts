// A compact notice must retain its full error for focus and hover.
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

it("keeps the full error and makes the status keyboard focusable", () => {
  const html = notice();
  expect(html).toContain(detail);
  expect(html).toContain('tabindex="0"');
});

it("offers the same complete text through the existing tooltip", () => {
  expect(notice()).toContain(`data-tip="${detail}"`);
});

it("has no notice when there is no failure", () => {
  setState({ notice: null });
  expect(notice()).toBeUndefined();
});
