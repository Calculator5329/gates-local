// Settings › Tools, the Make images row. On a phone settings.update is computer-only, so the row has
// no switch and still says whether the chat model's image tool is on. When image generation or
// ComfyUI is why the switch cannot be turned on, the reason goes to Image generation.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Settings } from "@gates-local/contracts";
import type { State } from "../src/store.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
const { getState, setState } = await import("../src/store.ts");
const initial = getState();

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 15)" });
});
afterEach(() => { setState(initial); vi.unstubAllGlobals(); });

const settings = (imageTool: boolean, imageGen = true): Settings => ({ defaultNumCtx: 16384, thinking: true, theme: "dark", runtimeMode: "system", tools: true, imageGen, imageTool });

/** The Make images row as Settings › Tools renders it. */
async function makeImagesRow(imageTool: boolean, phone: boolean, imageGen = true, image: "ready" | "missing" = "ready"): Promise<string> {
  const { SettingsView } = await import("../src/Settings.tsx");
  setState({
    ...initial, conn: { kind: "open" }, view: "settings", section: "tools", settings: settings(imageTool, imageGen), sources: [],
    imageStatus: { state: imageGen ? image : "off", owner: "external" },
    unavailable: phone ? { "settings.update": true } : {},
  });
  const html = renderToStaticMarkup(createElement(SettingsView));
  // from the row's start to the end of its value cell, the row's last child
  const start = html.search(/<div class="srow tool[^"]*" data-tool="images">/);
  if (start < 0) throw new Error("no Make images row");
  return html.slice(start, html.indexOf("</div>", html.indexOf('class="sv"', start)) + 6);
}

it.each([true, false])("on a phone the Make images row has no switch and says the tool is %s", async (on) => {
  const row = await makeImagesRow(on, true);
  expect(row).not.toContain('role="switch"');
  expect(row).toContain(`>${on ? "On" : "Off"}</span>`);
});

it.each([
  ["image generation is off", false, "ready", "Needs Generate images, in "],
  ["ComfyUI is not connected", true, "missing", "ComfyUI: Not connected. Set it up in "],
] as const)("when %s, the reason goes to Image generation and the switch cannot be turned on", async (_why, imageGen, image, words) => {
  const row = await makeImagesRow(false, false, imageGen, image);
  expect(row).toContain(words);
  expect(row).toMatch(/<button type="button" class="link" data-go="images">Image generation<\/button>/);
  expect(row).toMatch(/role="switch" aria-checked="false" aria-label="Make images" disabled=""/);
  expect(row).toContain('class="srow tool dim"');
});

it("with the master switch off the hidden reason holds the same link box, out of the tab order, so the row keeps its height", async () => {
  const { SettingsView } = await import("../src/Settings.tsx");
  setState({ ...initial, conn: { kind: "open" }, view: "settings", section: "tools", settings: { ...settings(false, false), tools: false }, sources: [], imageStatus: { state: "off", owner: "external" }, unavailable: {} });
  const html = renderToStaticMarkup(createElement(SettingsView));
  expect(html).toContain('<span aria-hidden="true">Needs Generate images, in <button type="button" class="link" data-go="images" tabindex="-1">Image generation</button>.</span>');
});

it.each<[string, { imageGen?: boolean; image?: "missing"; tools?: boolean }]>([
  ["image generation is off", { imageGen: false }],
  ["ComfyUI is not connected", { image: "missing" }],
  ["tools are off", { tools: false }],
])("on a phone, when %s, the saved On has the off dot and the reason beside it", async (_why, over) => {
  const { SettingsView } = await import("../src/Settings.tsx");
  setState({
    ...initial, conn: { kind: "open" }, view: "settings", section: "tools", sources: [],
    settings: { ...settings(true, over.imageGen ?? true), tools: over.tools ?? true },
    imageStatus: { state: over.imageGen === false ? "off" : over.image ?? "ready", owner: "external" },
    unavailable: { "settings.update": true },
  });
  const html = renderToStaticMarkup(createElement(SettingsView));
  const start = html.search(/data-tool="images"/);
  const row = html.slice(start, html.indexOf("</div>", html.indexOf('class="sv"', start)));
  expect(row).toContain('<span class="stat"><span class="dot off"></span>On</span>');
  expect(row).toMatch(/<span aria-hidden="false">(Needs|ComfyUI)/);
});

it("on a phone, when the tool is offered, On has the on dot", async () => {
  expect(await makeImagesRow(true, true)).toContain('<span class="stat"><span class="dot ok"></span>On</span>');
});

it("when the switch can be turned on, the row has no link", async () => {
  expect(await makeImagesRow(false, false)).not.toContain('class="link"');
});

it("on the computer the row is the switch alone, with no word beside it", async () => {
  const row = await makeImagesRow(true, false);
  expect(row).toContain('role="switch"');
  expect(row).toContain('aria-checked="true"');
  expect(row).not.toMatch(/>(On|Off)<\/span>/);
});
