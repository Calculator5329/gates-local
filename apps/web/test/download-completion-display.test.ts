// A finished transfer is still pending installation until the model list arrives.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../src/store.ts";
import { firstChatPull } from "../src/pick.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
import { setState } from "../src/store.ts";

const fit = methodSamples["fit.check"].result;
const model = methodSamples["models.list"].result[0]!;
const pulls = { [fit.model]: { name: fit.model, state: "done" as const, completedBytes: model.sizeBytes, totalBytes: model.sizeBytes } };
let DownloadTab: typeof import("../src/ModelDownloads.tsx")["DownloadTab"];
let Picker: typeof import("../src/Composer.tsx")["Picker"];
let pendingDownloads: typeof import("../src/ModelDownloads.tsx")["usePendingDownloads"];
let DownloadingRows: typeof import("../src/ModelDownloads.tsx")["DownloadingRows"];
beforeAll(async () => {
  vi.stubGlobal("window", {});
  DownloadTab = (await import("../src/ModelDownloads.tsx")).DownloadTab;
  pendingDownloads = (await import("../src/ModelDownloads.tsx")).usePendingDownloads;
  DownloadingRows = (await import("../src/ModelDownloads.tsx")).DownloadingRows;
  Picker = (await import("../src/Composer.tsx")).Picker;
});
beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({ model: fit.model, models: [], pulls, fits: {}, numCtx: 32768, pop: { id: "picker", kb: false }, catalog: [{ name: fit.model, label: "Fixture model", purpose: "Fixture chat model", downloadBytes: model.sizeBytes, installed: false, recommended: false, fit }] });
});
afterEach(() => vi.unstubAllGlobals());

it("Download keeps its progress instead of offering Download again", () => {
  const html = renderToStaticMarkup(createElement(DownloadTab));
  expect(html).toContain('role="progressbar"');
  expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>Download<\/button>/);
});

it("the picker keeps the completed pending row until it can become installed", () => {
  expect(renderToStaticMarkup(createElement(Picker))).toContain("Downloading · 100%");
});

it("the first-model composer keeps waiting through the same handoff", () => {
  expect(firstChatPull([], pulls)).toBe(fit.model);
});

it("an installed list ends the pending state", () => {
  setState({ models: [model] });
  expect(renderToStaticMarkup(createElement(DownloadTab))).toContain("Installed</span>");
  expect(renderToStaticMarkup(createElement(Picker))).not.toContain("Downloading · 100%");
  expect(firstChatPull([model], pulls)).toBeUndefined();
});

it("the installed rows and picker match an untagged pull to its latest tag", () => {
  setState({ models: [{ ...model, name: "llama3:latest" }], pulls: { llama3: { ...pulls[fit.model]!, name: "llama3" } } });
  expect(pendingDownloads()).toEqual([]);
  expect(renderToStaticMarkup(createElement(Picker))).not.toContain("Downloading · 100%");
});

it("an active untagged pull stays visible and cancellable beside its installed latest tag", () => {
  const progress = { name: "llama3", state: "downloading" as const, completedBytes: 5, totalBytes: 10 };
  setState({ models: [{ ...model, name: "llama3:latest" }], pulls: { llama3: progress } });
  expect.soft(pendingDownloads()).toEqual([progress]);
  const rows = renderToStaticMarkup(createElement(DownloadingRows));
  expect.soft(rows).toContain('data-pull="llama3"');
  expect.soft(rows).toContain('aria-label="Cancel download"');
  expect.soft(rows).not.toContain('disabled=""');
  expect.soft(renderToStaticMarkup(createElement(Picker))).toContain("Downloading · 50%");
  // An exact-name row remains suppressed so its installed row keeps a unique key.
  setState({ models: [{ ...model, name: "llama3" }] });
  expect(pendingDownloads()).toEqual([]);
  expect(renderToStaticMarkup(createElement(Picker))).not.toContain("Downloading · 50%");
});
