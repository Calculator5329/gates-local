// The model button and its picker with Image on: the button names the image model and size a
// send uses (the chat model with Image off), and the picker lists the presets the server
// read from ComfyUI and nothing else, in two menus: Defaults (one row per style) and Other models.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { GpuStatus, ImagePreset, ImagePresets, ModelInfo, Settings } from "@gates-local/contracts";
import { imageFitEdges, methodSamples } from "@gates-local/contracts/testing";
import { imageFit } from "../src/image-choice.ts";
import type { State } from "../src/store.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("../src/session.ts", async (original) => ({ ...(await original<object>()), loadImagePresets: vi.fn(async () => undefined), updateSettings: vi.fn(async () => undefined) }));
import { setState } from "../src/store.ts";

const GIB = 1024 ** 3;
const PIXEL: ImagePreset = { id: "flux2-klein-4b-pixel", name: "FLUX.2 Klein 4B pixel art", family: "flux", measured: false, sizes: [{ width: 768, height: 768, bytes: 9 * GIB }, { width: 1024, height: 1024, bytes: 10 * GIB }] };
const PLAIN: ImagePreset = { ...PIXEL, id: "flux2-klein-4b-compact", name: "FLUX.2 Klein 4B compact" };
const MOSS: ImagePreset = { id: "moss-image", name: "MOSS-Image", family: "moss", measured: false, sizes: [{ width: 1024, height: 1024, bytes: 10 * GIB }, { width: 1024, height: 768, bytes: 10 * GIB }] };
const presetsOf = (...presets: ImagePreset[]): ImagePresets => ({ presets, readAt: 1, current: { preset: presets[0] ?? PIXEL, width: 768, height: 768 } });
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
  setState({ settings: SETTINGS, models: [CHAT], model: CHAT.name, image: false, imagePresets: presetsOf(PIXEL, MOSS), pop: null });
});
afterEach(() => vi.unstubAllGlobals());

it("Image off: the button names the chat model", () => {
  const html = button();
  expect(html).not.toContain(PIXEL.name);
  expect(html).not.toContain("768×768");
});

it("Image on: the button names the image model and the size, and opens the image picker", () => {
  setState({ image: true });
  const html = button();
  expect(html).toContain(`<span class="t">${PIXEL.name}</span>`);
  expect(html).toContain('<small class="picker-trigger-ctx">768×768</small>');
  expect(html, "no chat-model readiness on the image button").not.toContain("aria-busy");
});

it("Image on: the button follows the saved choice", () => {
  setState({ image: true, settings: { ...SETTINGS, imageChoice: { preset: MOSS.id, width: 1024, height: 768 } } });
  const html = button();
  expect(html).toContain(`<span class="t">${MOSS.name}</span>`);
  expect(html).toContain("1024×768");
});

it("Image on with image generation off in Settings: the button stays the chat model's", () => {
  setState({ image: true, settings: { ...SETTINGS, imageGen: false } });
  expect(button()).not.toContain(PIXEL.name);
});

it("the picker lists only the presets the server read, with their sizes", () => {
  setState({ image: true, pop: { id: "images", kb: false }, imagePresets: presetsOf(PIXEL, MOSS) });
  const html = picker();
  expect(rowNames(html)).toEqual([PIXEL.name, MOSS.name]);
  expect(html).not.toContain(`data-preset="${PLAIN.id}"`);
  expect(html).toContain("768×768");
  expect(html).toContain("1024×1024");
  expect(html, "no search box for a short list").not.toContain("<input");
});

it("one family or two: the rail is the two menus, named, with no family codes", () => {
  for (const presets of [presetsOf(PIXEL, PLAIN), presetsOf(PIXEL, MOSS)]) {
    setState({ image: true, pop: { id: "images", kb: false }, imagePresets: presets });
    const html = picker();
    const rail = html.match(/<nav class="pk-rail"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect([...rail.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((m) => m[1])).toEqual(["Defaults", "Other models"]);
    expect(rail, "no family code on the rail").not.toContain("maker-mark");
    expect(rail.replace(/<[^>]*>/g, ""), "the rail shows icons, no letters").toBe("");
    expect(html).not.toContain("no-rail");
  }
});

it("ComfyUI has none of the files: the picker says so and lists nothing", () => {
  setState({ image: true, pop: { id: "images", kb: false }, imagePresets: { presets: [], readAt: 1, current: { preset: PIXEL, width: 768, height: 512 } } });
  const html = picker();
  expect(rowNames(html)).toEqual([]);
  expect(html).toContain("ComfyUI has none of the files these image models load.");
});

it.each([
  ["the file list was never read", { presets: [], current: { preset: MOSS, width: 1024, height: 1024 } }],
  ["ComfyUI has none of the files", { presets: [], readAt: 1, current: { preset: MOSS, width: 1024, height: 1024 } }],
] satisfies [string, ImagePresets][])("%s: the button never names the default it would fall to", (_, imagePresets) => {
  setState({ image: true, imagePresets });
  const html = button();
  expect(html).toContain('<span class="t">Image model</span>');
  expect(html).not.toContain(MOSS.name);
  expect(html).not.toContain("1024×1024");
});

it.each(imageFitEdges)("the picker's answer at the fit's edge, $name: $verdict, the server's answer (module.test.ts reads the same table)", ({ estimateBytes, freeBytes, creditedBytes, freeableBytes = 0, verdict }) => {
  const gpu: GpuStatus = { ...methodSamples["gpu.status"].result, freeBytes, occupants: [
    { label: "ComfyUI", bytes: creditedBytes, kind: "image", protected: false },
    { label: "Qwen 3.5 9B", bytes: freeableBytes, kind: "chat-model", protected: false },
    { label: "Whisper", bytes: 2 * GIB, kind: "whisper", protected: true },
  ] };
  const fit = imageFit(estimateBytes, gpu);
  expect(fit?.v.k === "no" ? "refuse" : fit?.frees ? "frees" : "fits").toBe(verdict);
});

it("Image on: the button says the short name beside the family mark, its tip the full name", () => {
  setState({ image: true, imagePresets: presetsOf({ ...PIXEL, short: "Pixel art" }, { ...PLAIN, short: "Compact" }) });
  const html = button();
  expect(html).toContain('<span class="t">Pixel art</span>');
  expect(html).toContain(`data-tip="${PIXEL.name}"`);
  expect(html).not.toContain("style=");
});

it("the picker says each size's GB once, on its size row, with a mark and no word", () => {
  setState({ image: true, pop: { id: "images", kb: false }, imagePresets: presetsOf(PIXEL, PLAIN, MOSS), gpu: methodSamples["gpu.status"].result });
  const html = picker();
  const models = html.slice(html.indexOf('role="listbox"'), html.indexOf('class="pk-context"'));
  expect(models).not.toContain("GB");
  const sizes = html.slice(html.indexOf('class="pk-context"'));
  expect(sizes.match(/>\d+\.\d GB</g)).toHaveLength(PIXEL.sizes.length);
  expect(html.replace(/<[^>]*>/g, " "), "no word on screen; the tip and the label say it").not.toMatch(/Fits|Too big|Stops chat/);
  expect(sizes).toContain('data-tip="Fits on the GPU"');
  expect(html).not.toContain("usable");
});

// the status the server pushes once a turn of this app answered on a model that was warm before it started
const warm = (guarded: boolean): GpuStatus => ({ ...methodSamples["gpu.status"].result, freeBytes: 3 * GIB, occupants: [
  { label: "Qwen 3.5 9B", bytes: 7 * GIB, kind: "chat-model", protected: guarded },
  { label: "Whisper", bytes: 2 * GIB, kind: "whisper", protected: true },
] });
/** The first size row's cost mark, with the warm model's occupant guarded or not. */
const warmRow = (guarded: boolean) => {
  setState({ image: true, pop: { id: "images", kb: false }, imagePresets: presetsOf(PIXEL), gpu: warm(guarded) });
  const html = picker();
  return html.slice(html.indexOf('class="pk-context"')).match(/<span class="pk-cost [^"]*"[^>]*>/)?.[0] ?? "";
};

it("a warm chat model a turn answered on: the status calls it unprotected, so the size row says it stops the chat model, not Too big", () => {
  expect(warmRow(false)).toContain('class="pk-cost spill"');
  expect(warmRow(false)).toContain("Stops the chat model first");
  expect(warmRow(true),"another program's model: the server will not free it either").toContain('class="pk-cost no"');
});

it("the default ComfyUI lists is named, as the first row", () => {
  setState({ image: true, imagePresets: { presets: [MOSS, PLAIN, PIXEL], readAt: 1, current: { preset: MOSS, width: 1024, height: 1024 } } });
  expect(button()).toContain(`<span class="t">${MOSS.name}</span>`);
  setState({ pop: { id: "images", kb: false } });
  expect(rowNames(picker())).toEqual([MOSS.name, PLAIN.name, PIXEL.name]);
});

const KLEIN: ImagePreset = { ...PIXEL, id: "flux2-klein-4b", name: "FLUX.2 Klein 4B", group: "General" };
const ZIMAGE: ImagePreset = { ...MOSS, id: "z-image-int8", name: "Z-Image Turbo int8", family: "zimage", group: "General" };

/** The style cells the server lists for a card's level (styles.ts): one per style, in its style's group. */
const GENERAL: ImagePreset = { ...PLAIN, id: "general--r2-2a-klein-compact8", name: "FLUX.2 Klein 4B compact general", group: "General", style: "general" };
const PIXEL_CELL: ImagePreset = { ...PIXEL, id: "pixel-art--r2-1a-klein-compact8", name: "FLUX.2 Klein 4B compact pixel art", group: "Pixel art", style: "pixel-art" };

it("Defaults runs the server's setup for each style and names it by the style alone; Other models shows the tier rows first, in tier order, each with its tier; a tier row still to download keeps its place", () => {
  // the server's order is not the Defaults order nor the tier order, and Z-Image's files are not there yet
  const imagePresets: ImagePresets = {
    presets: [{ ...MOSS, group: "General", tier: "Best" }, PIXEL_CELL, { ...PLAIN, group: "General" }, { ...KLEIN, tier: "Fast" }, GENERAL],
    others: [{ ...ZIMAGE, tier: "Balanced", needs: { files: ["z_image_turbo_int8.safetensors"], download: true } }],
    readAt: 1, current: { preset: GENERAL, width: 896, height: 896 },
  };
  setState({ image: true, pop: { id: "images", kb: false }, imagePresets });
  const html = picker();
  // Defaults, then Other models: the styles by name, then the rest by their own
  expect(rowNames(html)).toEqual(["General", "Pixel art", KLEIN.name, ZIMAGE.name, MOSS.name, PLAIN.name]);
  expect(html.match(/<div class="pk-r style[^"]*"[^>]*data-preset="([^"]*)"/g)?.map((r) => /data-preset="([^"]*)"/.exec(r)?.[1])).toEqual([GENERAL.id, PIXEL_CELL.id]);
  expect(html, "a Defaults row has no tip: the size pane already names its setup").not.toMatch(/class="pk-select"[^>]*data-tip=/);
  expect([...html.matchAll(/<span class="pk-variant">([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(["Fast", "Balanced", "Best"]);
  expect(html.match(/class="maker-mark"/g), "the four Other models rows keep their family marks; the rail and the styles have none").toHaveLength(4);
});

it("a style's setup is listed once: in Defaults, not again in Other models", () => {
  setState({ image: true, pop: { id: "images", kb: false }, imagePresets: { presets: [{ ...PLAIN, group: "General", tier: "Fast and balanced" }, { ...MOSS, group: "General", tier: "Best" }, GENERAL], readAt: 1, current: { preset: GENERAL, width: 896, height: 896 } } });
  const html = picker();
  expect(html.match(new RegExp(`data-preset="${GENERAL.id}"`, "g"))).toHaveLength(1);
  expect(rowNames(html)).toEqual(["General", PLAIN.name, MOSS.name]);
  expect([...html.matchAll(/<span class="pk-variant">([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(["Fast and balanced", "Best"]);
});

const NO_GPU = "Image mode needs a GPU with 4 GB.";
it.each([
  ["with 3 GB free", { ...methodSamples["gpu.status"].result, freeBytes: 3 * GIB, occupants: [] } as GpuStatus, "3.0 GB free"],
])("%s: no default is named or marked, and the picker says why once", (_, gpu, figure) => {
  // what the server answers below 4 GB: Klein listed by its files, no tier rows, the reason
  const imagePresets: ImagePresets = { presets: [KLEIN, MOSS], readAt: 1, current: { preset: KLEIN, width: 1024, height: 1024 }, noGpu: NO_GPU };
  setState({ image: true, imagePresets, gpu, pop: null });
  expect(button()).toContain('<span class="t">Image model</span>');
  expect(button()).not.toContain(KLEIN.name);
  setState({ pop: { id: "images", kb: false } });
  const html = picker();
  expect(html).not.toContain('aria-selected="true"');
  expect(html).not.toContain('aria-checked="true"');
  const footer = html.slice(html.indexOf('class="pk-bottom"'));
  expect(footer).toContain(NO_GPU);
  expect(html.split(NO_GPU)).toHaveLength(2);
  expect(footer, "not a second line saying the opposite").not.toContain("Runs in system memory");
  // gb() joins the number and its unit with a no-break space
  if (figure !== "") expect(footer.replace(/\s/g, " ")).toContain(figure);
});

it("on the CPU: the basic-PC General setup is the default, named and marked, and the picker says once how slow it is", () => {
  // what the server answers when ComfyUI runs on the CPU: the CPU cells and the slow line, no noGpu
  const SLOW = "No GPU: a picture takes 2 to 4 minutes.";
  const CPU_GENERAL: ImagePreset = { ...PLAIN, id: "general--cpu-klein-fp4-768-2", name: "FLUX.2 Klein 4B general on the CPU", group: "General", style: "general" };
  const imagePresets: ImagePresets = { presets: [KLEIN, MOSS, CPU_GENERAL], readAt: 1, current: { preset: CPU_GENERAL, width: 768, height: 768 }, slow: SLOW };
  setState({ image: true, imagePresets, gpu: { ...methodSamples["gpu.status"].result, vendor: "none" } as GpuStatus, pop: null });
  expect(button()).toContain("768×768");
  expect(button()).not.toContain('<span class="t">Image model</span>');
  setState({ pop: { id: "images", kb: false } });
  const html = picker();
  expect(html).toContain(`aria-selected="true" data-preset="${CPU_GENERAL.id}"`);
  const footer = html.slice(html.indexOf('class="pk-bottom"'));
  expect(footer).toContain(SLOW);
  expect(html.split(SLOW)).toHaveLength(2);
  expect(footer, "not a second line saying it again").not.toContain("Runs in system memory");
});

it("a saved pick on a machine with no default is still named: an explicit pick runs", () => {
  setState({ image: true, imagePresets: { presets: [KLEIN, MOSS], readAt: 1, current: { preset: KLEIN, width: 1024, height: 1024 }, noGpu: NO_GPU }, settings: { ...SETTINGS, imageChoice: { preset: MOSS.id, width: 1024, height: 768 } } });
  expect(button()).toContain(`<span class="t">${MOSS.name}</span>`);
});
