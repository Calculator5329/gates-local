// Render the real picker against a store snapshot. The catalog is already a
// measured answer, but a different context or a failed fresh check must not
// borrow that answer. Browser geometry remains a separate remote check.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../src/store.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});

import { fitKey, setState } from "../src/store.ts";

const report = methodSamples["fit.check"].result;
const catalog = [{ name: report.model, label: "Fixture chat model", purpose: "A deterministic chat fixture", downloadBytes: 1_000_000, installed: true, recommended: false, fit: report }];
let Picker: typeof import("../src/Composer.tsx")["Picker"];
const text = () => renderToStaticMarkup(createElement(Picker)).replace(/<[^>]*>/g, " ");

beforeAll(async () => {
  vi.stubGlobal("window", {});
  Picker = (await import("../src/Composer.tsx")).Picker;
});
beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({
    model: report.model,
    models: [{ name: report.model, digest: "fixture", sizeBytes: 1_000_000, modifiedAt: "2026-01-01T00:00:00Z", capabilities: ["completion"] }],
    catalog,
    fits: {},
    numCtx: 32768,
    pop: { id: "picker", kb: false },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("shows the catalog's measured verdict while its fresh check is pending", () => {
  const rendered = text();
  expect(rendered).not.toContain("Checking…");
  expect(rendered).toContain("Slower");
});

it("does not use a catalog verdict measured at a different context", () => {
  setState({ numCtx: 16384 });
  expect(text()).toContain("Checking…");
});

it("a fresh check failure ends the old catalog verdict", () => {
  setState({ fits: { [fitKey(report.model, report.numCtx)]: "error" } });
  expect(text()).not.toContain("Slower");
});
