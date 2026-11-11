// A finished transfer is still pending installation until the model list arrives.
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../src/store.ts";
import { firstChatPull } from "../src/pick.ts";

const sent = vi.hoisted(() => ({ cancelPull: vi.fn(async (_name: string) => null) }));
vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("../src/session.ts", async (original) => ({ ...await original<typeof import("../src/session.ts")>(), cancelPull: sent.cancelPull }));
// useAct's state starts empty either way; without its hook a row can be expanded outside a render.
vi.mock("../src/settings-ui.tsx", async (original) => ({
  ...await original<typeof import("../src/settings-ui.tsx")>(),
  useAct: () => [null, async (action: Promise<unknown>) => (await action) === null],
}));

type Node = ReactElement<Record<string, unknown>>;
/** Expands function components (here only hook-free ones) and lists every element. */
function nodes(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (typeof node.type === "function") return nodes((node.type as (p: unknown) => unknown)(node.props));
  return [node, ...nodes(node.props["children"])];
}
import { setState } from "../src/store.ts";

const fit = methodSamples["fit.check"].result;
const model = methodSamples["models.list"].result[0]!;
const pulls = { [fit.model]: { name: fit.model, state: "done" as const, completedBytes: model.sizeBytes, totalBytes: model.sizeBytes } };
let DownloadTab: typeof import("../src/ModelDownloads.tsx")["DownloadTab"];
let Picker: typeof import("../src/Picker.tsx")["Picker"];
let pendingDownloads: typeof import("../src/ModelDownloads.tsx")["usePendingDownloads"];
let DownloadingRows: typeof import("../src/ModelDownloads.tsx")["DownloadingRows"];
beforeAll(async () => {
  vi.stubGlobal("window", {});
  DownloadTab = (await import("../src/ModelDownloads.tsx")).DownloadTab;
  pendingDownloads = (await import("../src/ModelDownloads.tsx")).usePendingDownloads;
  DownloadingRows = (await import("../src/ModelDownloads.tsx")).DownloadingRows;
  Picker = (await import("../src/Picker.tsx")).Picker;
});
beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({ model: fit.model, models: [], pulls, fits: {}, numCtx: 32768, pop: { id: "picker", kb: false, ready: true }, catalog: [{ name: fit.model, label: "Fixture model", purpose: "Fixture chat model", downloadBytes: model.sizeBytes, installed: false, recommended: false, fit }] });
});
afterEach(() => vi.unstubAllGlobals());

it("Download keeps its progress instead of offering Download again", () => {
  const html = renderToStaticMarkup(createElement(DownloadTab));
  expect(html).toContain('role="progressbar"');
  expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>Download<\/button>/);
});

it("the picker keeps the completed pending row until it can become installed", () => {
  const html = renderToStaticMarkup(createElement(Picker));
  expect(html).toContain(`data-m="${fit.model}"`);
  expect(html.match(/<div[^>]*role="option"[^>]*>/g)).toEqual([expect.stringContaining('aria-disabled="true"')]);
  const row = html.slice(html.indexOf(`data-m="${fit.model}"`)).split("</button>")[0];
  expect(row).toMatch(/class="pk-v[^"]*">100%/);
});

it("the first-model composer keeps waiting through the same handoff", () => {
  expect(firstChatPull([], pulls)).toBe(fit.model);
});

it("an installed list ends the pending state", () => {
  setState({ models: [model] });
  expect(renderToStaticMarkup(createElement(DownloadTab))).toContain("Installed</span>");
  const picker = renderToStaticMarkup(createElement(Picker));
  expect(picker).toContain(`data-m="${fit.model}"`);
  expect(picker).not.toMatch(/class="pk-v[^"]*">100%/);
  expect(firstChatPull([model], pulls)).toBeUndefined();
});

it("the installed rows and picker match an untagged pull to its latest tag", () => {
  setState({ models: [{ ...model, name: "llama3:latest" }], pulls: { llama3: { ...pulls[fit.model]!, name: "llama3" } } });
  expect(pendingDownloads()).toEqual([]);
  const html = renderToStaticMarkup(createElement(Picker));
  expect(html).toContain('data-m="llama3:latest"');
  expect(html).not.toContain('data-m="llama3"');
  expect(html.match(/role="option"/g)).toHaveLength(1);
  expect(html).not.toMatch(/class="pk-v[^"]*">100%/);
});

it("a different installed tag does not retire a completed pending pull", () => {
  setState({ models: [{ ...model, name: "llama3:other" }], pulls: { llama3: { ...pulls[fit.model]!, name: "llama3" } } });
  expect(pendingDownloads()).toHaveLength(1);
  const html = renderToStaticMarkup(createElement(Picker));
  expect(html).toContain('data-m="llama3"');
  expect(html).toMatch(/class="pk-v[^"]*">100%/);
});

it("an active untagged pull stays visible and cancellable beside its installed latest tag", () => {
  const progress = { name: "llama3", state: "downloading" as const, completedBytes: 5, totalBytes: 10 };
  setState({ models: [{ ...model, name: "llama3:latest" }], pulls: { llama3: progress } });
  expect.soft(pendingDownloads()).toEqual([progress]);
  const rows = renderToStaticMarkup(createElement(DownloadingRows));
  expect.soft(rows).toContain('data-pull="llama3"');
  expect.soft(rows).toContain('aria-label="Cancel download"');
  expect.soft(rows).not.toContain('disabled=""');
  const cancel = nodes(createElement(DownloadingRows)).find(n => n.props["aria-label"] === "Cancel download");
  (cancel?.props["onClick"] as (() => void) | undefined)?.();
  expect.soft(sent.cancelPull.mock.calls).toEqual([["llama3"]]);
  const picker = renderToStaticMarkup(createElement(Picker));
  expect.soft(picker).toContain('data-m="llama3"');
  const pendingRow = picker.slice(picker.indexOf('data-m="llama3"')).split("</button>")[0];
  expect.soft(pendingRow).toMatch(/class="pk-v[^"]*">50%/);
  // An exact-name row remains suppressed so its installed row keeps a unique key.
  setState({ models: [{ ...model, name: "llama3" }] });
  expect(pendingDownloads()).toEqual([]);
  const exact = renderToStaticMarkup(createElement(Picker));
  expect(exact).toContain('data-m="llama3"');
  expect(exact.match(/role="option"/g)).toHaveLength(1);
  expect(exact).not.toMatch(/class="pk-v[^"]*">50%/);
});
