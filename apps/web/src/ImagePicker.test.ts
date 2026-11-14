// The image picker's rows and buttons, read from its element tree with React's hooks stubbed (as
// FirstRun-actions.test.ts does): what a download shows once, in the disk row, and on each row, which controls a listener
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
vi.mock("./session.ts", () => ({
  ...Object.fromEntries(["downloadImageSetup", "loadImagePresets", "pickImage", "saveImageFolder", "startImage", "stopImageDownload"]
    .map((name) => [name, async () => { probe.calls.push(name); return null; }])),
  folderDialog: () => undefined,
}));
vi.mock("./Sidebar.tsx", () => ({ focusComposer: () => undefined }));
vi.mock("./icons.tsx", () => ({ Icon: () => null }));
vi.mock("./ImageMark.tsx", () => ({ ImageMark: () => null }));
vi.mock("./picker-models.ts", () => ({ memoryRuler: () => undefined }));
vi.mock("./image-choice.ts", () => ({ chosenImage: () => undefined, imageFit: () => undefined, sizeLabel: (w: number, h: number) => `${w}×${h}` }));
vi.mock("./ui.tsx", () => ({ PHONE: "", closePop: () => undefined, closeTip: () => undefined, isTouch: () => false, tabStops: () => [], useMedia: () => false }));

const { ImagePicker, middle } = await import("./ImagePicker.tsx");
const { gb, timeLeft } = await import("./format.ts");
const GIB = 1024 ** 3;

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
const ready: ImagePreset = { id: "moss-image", name: "MOSS-Image", family: "moss", group: "General", measured: false, sizes };
const running: ImageDownload = { preset: "flux2-klein-4b", name: "qwen_3_4b.safetensors", file: 2, files: 3, state: "downloading", completedBytes: 5, totalBytes: 10, setupCompletedBytes: 30, setupTotalBytes: 120, bytesPerSecond: 9 };

function picker(over: Record<string, unknown> = {}) {
  probe.state = { pop: { id: "images" }, imagePresets: { presets: [ready], others, readAt: 1 }, imageStatus: { state: "ready" }, imageDownload: undefined, gpu: undefined, unavailable: {}, ...over };
}
beforeEach(() => { probe.calls = []; });

const disk = () => {
  const found = tree().find((n) => n.props["data-testid"] === "image.picker.disk");
  if (!found) throw new Error("no disk row");
  return { node: found, all: nodes(found.props["children"]) };
};
const bars = () => tree().filter((n) => n.props["role"] === "progressbar");

it("WIN-SETUP-01: seven setups that load the same files show one download, once: one bar in the disk row, each row only waiting", () => {
  const seven = Array.from({ length: 7 }, (_, i) => off(`klein-${i + 1}`, `FLUX.2 Klein 4B ${i + 1}`, KLEIN_FILES));
  const setup = { ...running, preset: "klein-1", setupCompletedBytes: 2 * GIB, setupTotalBytes: 8 * GIB, bytesPerSecond: 100 * 1024 ** 2 };
  picker({ imagePresets: { presets: [ready], others: [...seven, others[2]], readAt: 1, disk: { folder: "F:\\ComfyUI\\models", freeBytes: 876 * GIB, picked: false } }, imageDownload: setup });
  expect(bars()).toHaveLength(1);
  expect(bar(disk().all)?.props["aria-valuenow"]).toBe(25);
  expect(text(disk().node)).toContain(`${gb(2 * GIB)} of ${gb(8 * GIB)} · ${timeLeft((6 * GIB) / (100 * 1024 ** 2))} left`);
  expect(labels(disk().all)).toContain("Stop downloading FLUX.2 Klein 4B 1");
  for (const p of seven) {
    expect(text(row(p.id).node)).toBe(`FLUX.2 Klein 4B ${p.id.slice(-1)}Waiting on the download`);
    expect(labels(row(p.id).all).filter((l) => /^(Download|Stop|Resume)/.test(l))).toEqual([]);
  }
  // a setup that needs other files keeps its Download, held while the one download runs
  expect(row("other").all.find((n) => n.props["aria-label"] === "Download Other")?.props["disabled"]).toBe(true);
});

it("WIN-SETUP-01: before any download the disk row says where the files go, what is left to fetch and what is free there, red when short", () => {
  const left = 4_070_624_520 + 3_848_213_998 + 336_211_292;
  const klein = { ...others[0]!, needs: { files: KLEIN_FILES, download: true, bytes: left, leftBytes: left } };
  const folder = "F:\\ComfyUI_windows_portable\\ComfyUI\\models\\diffusion_models";
  picker({ imagePresets: { presets: [], others: [klein], readAt: 1, disk: { folder, freeBytes: Math.round(4.6 * GIB), picked: false } } });
  const row0 = disk();
  const shown = row0.all.find((n) => n.props["data-testid"] === "image.picker.disk-folder")!;
  expect(text(shown)).toBe(middle(folder));
  expect(text(shown).length).toBeLessThan(folder.length);
  expect(shown.props["data-tipt"]).toBe(folder);
  expect(text(row0.node)).toContain(`${gb(left)} to fetch · ${gb(4.6 * GIB)} free on disk`);
  expect(row0.all.find((n) => n.props["data-testid"] === "image.picker.disk-free")?.props["className"]).toBe("short");
  expect(labels(row0.all)).toContain("Change the download folder");
  expect(bars()).toHaveLength(0);
  picker({ imagePresets: { presets: [], others: [klein], readAt: 1, disk: { folder: "F:\\models", freeBytes: 876 * GIB, picked: true } } });
  expect(disk().all.find((n) => n.props["data-testid"] === "image.picker.disk-free")?.props["className"]).toBeUndefined();
});

it("a stopped download keeps its part: the bar stays there, no Stop, and the row's button says Resume", () => {
  picker({ imagePresets: { presets: [ready], others, readAt: 1, disk: { folder: "F:\\models", freeBytes: 876 * GIB, picked: false } }, imageDownload: { ...running, state: "cancelled", ended: true } });
  expect(bars()).toHaveLength(1);
  expect(bar(disk().all)?.props["aria-valuenow"]).toBe(25);
  expect(labels(disk().all).filter((l) => l.startsWith("Stop"))).toEqual([]);
  expect(labels(row("flux2-klein-4b").all)).toContain("Resume downloading FLUX.2 Klein 4B");
  expect(text(row("flux2-klein-4b").node)).toContain("Needs 3 files");
});

it("a listener that refuses downloads (the phone's) shows no Download, Stop or disk row: the rows keep their reasons", () => {
  picker({ unavailable: { "image.download": true, "image.stopDownload": true, "image.start": true } });
  for (const id of ["flux2-klein-4b", "other"]) expect(labels(row(id).all).filter((l) => /^(Download|Stop)/.test(l))).toEqual([]);
  expect(text(row("other").node)).toContain("Needs 1 file");
  picker({ imagePresets: { presets: [ready], others, readAt: 1, disk: { folder: "F:\\models", picked: false } }, imageDownload: running, unavailable: { "image.download": true, "image.stopDownload": true } });
  expect(tree().some((n) => n.props["data-testid"] === "image.picker.disk")).toBe(false);
  expect(text(row("flux2-klein-4b").node)).toContain("Waiting on the download");
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
