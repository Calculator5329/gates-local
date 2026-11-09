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
let Picker: typeof import("../src/Picker.tsx")["Picker"];
const html = () => renderToStaticMarkup(createElement(Picker));
const row = () => html().split(`data-m="${report.model}"`)[1]?.split("</button>")[0];
const context = () => html().split(`data-ctx="${report.numCtx}"`)[1]?.split("</button>")[0];

beforeAll(async () => {
  vi.stubGlobal("window", {});
  Picker = (await import("../src/Picker.tsx")).Picker;
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
    pop: { id: "picker", kb: false, ready: true },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("does not expose the first picker view before the missing costs arrive", () => {
  setState({ pop: { id: "picker", kb: false } });
  expect(html()).not.toContain('id="picker"');
});

it("shows the catalog's measured cost as history while its fresh check is pending", () => {
  const rendered = context();
  expect(rendered).toBeDefined();
  expect(rendered).not.toContain("Checking…");
  expect(rendered).toContain("Previous check");
  expect(rendered).not.toContain("Slower");
  expect(row()).not.toContain("Checking…");
});

it("does not use a catalog verdict measured at a different context", () => {
  setState({ numCtx: 16384 });
  expect(row()).toContain("Checking…");
});

it("a fresh check failure ends the old catalog verdict", () => {
  setState({ fits: { [fitKey(report.model, report.numCtx)]: "error" } });
  expect(context()).not.toContain("Slower");
  expect(row()).toContain("Couldn&#x27;t check");
});

it("a newly opened context column only checks sizes that have never answered", () => {
  setState({ fits: { [fitKey(report.model, report.numCtx)]: report } });
  expect(html().match(/Checking…/g)).toHaveLength(3);
  const sizes = [8192, 16384, 32768, 65536];
  setState({ fits: Object.fromEntries(sizes.map(numCtx => [fitKey(report.model, numCtx), { ...report, numCtx }])) });
  // Each static render is a new Picker instance, as after a close and reopen.
  expect(html()).not.toContain("Checking…");
  setState({ pop: null });
  setState({ pop: { id: "picker", kb: false, ready: true } });
  expect(html()).not.toContain("Checking…");
});
