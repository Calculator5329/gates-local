// The model button and its picker with Image on: the button names the image model and size a
// send uses (the chat model with Image off), and the picker lists the presets the server
// read from ComfyUI and nothing else, with a family rail only when there is more than one family.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ImagePreset, ImagePresets, ModelInfo, Settings } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../src/store.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("../src/session.ts", async (original) => ({ ...(await original<object>()), loadImagePresets: vi.fn(async () => undefined), updateSettings: vi.fn(async () => undefined) }));
import { setState } from "../src/store.ts";

const GIB = 1024 ** 3;
const PIXEL: ImagePreset = { id: "sdxl-lightning-pixel", name: "SDXL Lightning pixel art", family: "sdxl", measured: false, sizes: [{ width: 768, height: 512, bytes: 9 * GIB }, { width: 1024, height: 1024, bytes: 10 * GIB }] };
const PLAIN: ImagePreset = { ...PIXEL, id: "sdxl-lightning", name: "SDXL Lightning" };
const FLUX: ImagePreset = { id: "flux2-klein-4b", name: "FLUX.2 Klein 4B", family: "flux", measured: false, sizes: [{ width: 1024, height: 1024, bytes: 10 * GIB }, { width: 1024, height: 768, bytes: 10 * GIB }] };
const presetsOf = (...presets: ImagePreset[]): ImagePresets => ({ presets, readAt: 1, current: { preset: presets[0] ?? PIXEL, width: 768, height: 512 } });
const SETTINGS: Settings = { ...methodSamples["settings.get"].result, imageGen: true };
const CHAT: ModelInfo = methodSamples["models.list"].result[0]!;

let Composer: typeof import("../src/Composer.tsx")["Composer"];
let ImagePicker: typeof import("../src/ImagePicker.tsx")["ImagePicker"];
const button = () => renderToStaticMarkup(createElement(Composer)).match(/<button[^>]*id="modelBtn"[\s\S]*?<\/button>/)?.[0] ?? "";
const picker = () => renderToStaticMarkup(createElement(ImagePicker));
const rowNames = (html: string) => [...html.matchAll(/<span class="pk-nm">([^<]*)<\/span>/g)].map((m) => m[1]);

beforeAll(async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Composer = (await import("../src/Composer.tsx")).Composer;
  ImagePicker = (await import("../src/ImagePicker.tsx")).ImagePicker;
});
beforeEach(() => {
  vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 800 });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  setState({ settings: SETTINGS, models: [CHAT], model: CHAT.name, image: false, imagePresets: presetsOf(PIXEL, FLUX), pop: null });
});
afterEach(() => vi.unstubAllGlobals());

it("Image off: the button names the chat model", () => {
  const html = button();
  expect(html).not.toContain(PIXEL.name);
  expect(html).not.toContain("768×512");
});

it("Image on: the button names the image model and the size, and opens the image picker", () => {
  setState({ image: true });
  const html = button();
  expect(html).toContain(`<span class="t">${PIXEL.name}</span>`);
  expect(html).toContain('<small class="picker-trigger-ctx">768×512</small>');
  expect(html, "no chat-model readiness on the image button").not.toContain("aria-busy");
});

it("Image on: the button follows the saved choice", () => {
  setState({ image: true, settings: { ...SETTINGS, imageChoice: { preset: FLUX.id, width: 1024, height: 768 } } });
  const html = button();
  expect(html).toContain(`<span class="t">${FLUX.name}</span>`);
  expect(html).toContain("1024×768");
});

it("Image on with image generation off in Settings: the button stays the chat model's", () => {
  setState({ image: true, settings: { ...SETTINGS, imageGen: false } });
  expect(button()).not.toContain(PIXEL.name);
});

it("the picker lists only the presets the server read, with their sizes", () => {
  setState({ image: true, pop: { id: "images", kb: false }, imagePresets: presetsOf(PIXEL, FLUX) });
  const html = picker();
  expect(rowNames(html)).toEqual([PIXEL.name, FLUX.name]);
  expect(html).not.toContain(`data-preset="${PLAIN.id}"`);
  expect(html).toContain("768×512");
  expect(html).toContain("1024×1024");
  expect(html, "two families get the rail").not.toContain("no-rail");
  expect(html, "no search box for a short list").not.toContain("<input");
});

it("one family: no rail", () => {
  setState({ image: true, pop: { id: "images", kb: false }, imagePresets: presetsOf(PIXEL, PLAIN) });
  const html = picker();
  expect(rowNames(html)).toEqual([PIXEL.name, PLAIN.name]);
  expect(html).toContain("no-rail");
});

it("ComfyUI has none of the files: the picker says so and lists nothing", () => {
  setState({ image: true, pop: { id: "images", kb: false }, imagePresets: { presets: [], readAt: 1, current: { preset: PIXEL, width: 768, height: 512 } } });
  const html = picker();
  expect(rowNames(html)).toEqual([]);
  expect(html).toContain("ComfyUI has none of the files these image models load.");
});

it.each([
  ["the file list was never read", { presets: [], current: { preset: FLUX, width: 1024, height: 1024 } }],
  ["ComfyUI has none of the files", { presets: [], readAt: 1, current: { preset: FLUX, width: 1024, height: 1024 } }],
] satisfies [string, ImagePresets][])("%s: the button never names the default it would fall to", (_, imagePresets) => {
  setState({ image: true, imagePresets });
  const html = button();
  expect(html).toContain('<span class="t">Image model</span>');
  expect(html).not.toContain(FLUX.name);
  expect(html).not.toContain("1024×1024");
});

it("the default ComfyUI lists is named, as the first row", () => {
  setState({ image: true, imagePresets: { presets: [FLUX, PLAIN, PIXEL], readAt: 1, current: { preset: FLUX, width: 1024, height: 1024 } } });
  expect(button()).toContain(`<span class="t">${FLUX.name}</span>`);
  setState({ pop: { id: "images", kb: false } });
  expect(rowNames(picker())).toEqual([FLUX.name, PLAIN.name, PIXEL.name]);
});
