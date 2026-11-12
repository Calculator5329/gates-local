// The image picker's rows and buttons, read from its element tree with React's hooks stubbed (as
// FirstRun-actions.test.ts does): what a download shows on each row, which controls a listener
// that refuses their methods (the phone's) offers, and the empty picker's button.
import { isValidElement, type ReactElement } from "react";
import type { ImageDownload, ImagePreset } from "@gates-local/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ state: {} as Record<string, unknown>, calls: [] as string[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  // an effect runs at once: what opening the picker does is what the tree's first expansion does
  useEffect: (run: () => void) => { run(); },
  useLayoutEffect: () => undefined,
  useRef: () => ({ current: null }),
  useState: (initial: unknown) => [initial, () => undefined],
}));
vi.mock("./store.ts", () => ({ NA: "na", useStore: (fn: (s: unknown) => unknown) => fn(probe.state) }));
vi.mock("./session.ts", () => Object.fromEntries(["downloadImageSetup", "loadImagePresets", "pickImage", "startImage", "stopImageDownload"]
  .map((name) => [name, async () => { probe.calls.push(name); return null; }])));
vi.mock("./Sidebar.tsx", () => ({ focusComposer: () => undefined }));
vi.mock("./icons.tsx", () => ({ Icon: () => null }));
vi.mock("./ImageMark.tsx", () => ({ ImageMark: () => null }));
vi.mock("./picker-models.ts", () => ({ memoryRuler: () => undefined }));
vi.mock("./image-choice.ts", () => ({ chosenImage: () => undefined, imageFit: () => undefined, sizeLabel: (w: number, h: number) => `${w}×${h}` }));
vi.mock("./ui.tsx", () => ({ PHONE: "", closePop: () => undefined, closeTip: () => undefined, isTouch: () => false, tabStops: () => [], useMedia: () => false }));

const { ImagePicker } = await import("./ImagePicker.tsx");

type Node = ReactElement<Record<string, unknown>>;
function nodes(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (typeof node.type === "function") return nodes((node.type as (p: unknown) => unknown)(node.props));
  return [node, ...nodes(node.props["children"])];
}
const text = (node: Node): string => nodes(node).flatMap((n) => {
  const c = n.props["children"];
  return (Array.isArray(c) ? c : [c]).filter((x) => typeof x === "string" || typeof x === "number");
}).join("");
const tree = () => nodes(ImagePicker());
const row = (id: string) => {
  const found = tree().find((n) => n.props["data-preset"] === id);
  if (!found) throw new Error(`no row ${id}`);
  return { node: found, all: nodes(found.props["children"]) };
};
const labels = (all: Node[]) => all.map((n) => n.props["aria-label"]).filter((l): l is string => typeof l === "string");
const bar = (all: Node[]) => all.find((n) => n.props["role"] === "progressbar");

const KLEIN_FILES = ["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b.safetensors", "flux2-vae.safetensors"];
const sizes = [{ width: 1024, height: 1024, bytes: 10 * 1024 ** 3 }];
const off = (id: string, name: string, files: string[]): ImagePreset => ({ id, name, family: "flux", group: "General", measured: false, sizes, needs: { files, download: true } });
const others = [
  off("flux2-klein-4b", "FLUX.2 Klein 4B", KLEIN_FILES),
  off("flux2-klein-4b-portraits", "FLUX.2 Klein 4B portraits", KLEIN_FILES),
  off("other", "Other", ["other.safetensors"]),
];
const ready: ImagePreset = { id: "sdxl-lightning", name: "SDXL Lightning", family: "sdxl", group: "General", measured: false, sizes };
const running: ImageDownload = { preset: "flux2-klein-4b", name: "qwen_3_4b.safetensors", file: 2, files: 3, state: "downloading", completedBytes: 5, totalBytes: 10, setupCompletedBytes: 30, setupTotalBytes: 120, bytesPerSecond: 9 };

function picker(over: Record<string, unknown> = {}) {
  probe.state = { pop: { id: "images" }, imagePresets: { presets: [ready], others, readAt: 1 }, imageStatus: { state: "ready" }, imageDownload: undefined, gpu: undefined, unavailable: {}, ...over };
}
beforeEach(() => { probe.calls = []; });

it("a running download is one bar for the whole setup: the setup's bytes, not the file's", () => {
  picker({ imageDownload: running });
  const klein = row("flux2-klein-4b").all;
  expect(bar(klein)?.props["aria-valuenow"]).toBe(25);
  expect(text(row("flux2-klein-4b").node)).toContain("File 2/3 · 25% · 10 s left");
});

it("a row whose files the running download brings shows its progress, with no button; one that needs others keeps its Download, held", () => {
  picker({ imageDownload: running });
  const portraits = row("flux2-klein-4b-portraits").all;
  expect(bar(portraits)?.props["aria-valuenow"]).toBe(25);
  expect(labels(portraits).filter((l) => l.startsWith("Download") || l.startsWith("Stop"))).toEqual([]);
  expect(text(row("flux2-klein-4b-portraits").node)).not.toContain("Needs");
  const other = row("other").all;
  expect(bar(other)).toBeUndefined();
  expect(other.find((n) => n.props["aria-label"] === "Download Other")?.props["disabled"]).toBe(true);
  expect(labels(row("flux2-klein-4b").all)).toContain("Stop downloading FLUX.2 Klein 4B");
});

it("a listener that refuses downloads (the phone's) shows no Download or Stop: the rows keep their reasons and progress", () => {
  picker({ unavailable: { "image.download": true, "image.stopDownload": true, "image.start": true } });
  for (const id of ["flux2-klein-4b", "other"]) expect(labels(row(id).all).filter((l) => /^(Download|Stop)/.test(l))).toEqual([]);
  expect(text(row("other").node)).toContain("Needs 1 file");
  picker({ imageDownload: running, unavailable: { "image.download": true, "image.stopDownload": true } });
  expect(bar(row("flux2-klein-4b").all)?.props["aria-valuenow"]).toBe(25);
  expect(labels(row("flux2-klein-4b").all).filter((l) => /^(Download|Stop)/.test(l))).toEqual([]);
});

const blankButton = () => tree().find((n) => n.type === "button" && (n.props["className"] as string | undefined)?.includes("btn"));

it("the empty picker reads the list when it opens and never starts ComfyUI; its button says Start ComfyUI when the app's is stopped", async () => {
  picker({ imagePresets: { presets: [], readAt: 1 }, imageStatus: { state: "stopped" } });
  const button = blankButton();
  expect(probe.calls).toEqual(["loadImagePresets"]);
  expect(button && text(button)).toBe("Start ComfyUI");
  if (!button) throw new Error("no button");
  (button.props["onClick"] as () => void)();
  await Promise.resolve();
  expect(probe.calls).toEqual(["loadImagePresets", "startImage"]);
  picker({ imagePresets: { presets: [], readAt: 1 }, imageStatus: { state: "missing" } });
  expect(text(blankButton()!)).toBe("Check again");
});

it("while ComfyUI comes up the empty picker's button keeps saying Starting ComfyUI…, held", () => {
  picker({ imagePresets: { presets: [], readAt: 1 }, imageStatus: { state: "starting" } });
  const button = blankButton();
  expect(button && text(button)).toBe("Starting ComfyUI…");
  expect(button?.props["disabled"]).toBe(true);
});

it("a listener that refuses image.start shows no Start or Check again button", () => {
  picker({ imagePresets: { presets: [], readAt: 1 }, imageStatus: { state: "stopped" }, unavailable: { "image.start": true } });
  expect(blankButton()).toBeUndefined();
});
