// The image picker's rows and buttons, read from its element tree with React's hooks stubbed (as
// FirstRun-actions.test.ts does): what a download shows once, in the disk row, and on each row, which controls a listener
// that refuses their methods (the phone's) offers, and the empty picker's button.
import { isValidElement, type ReactElement } from "react";
import type { ImageDownload, ImagePreset } from "@gates-local/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  state: {} as Record<string, unknown>, calls: [] as string[], args: [] as [string, unknown[]][],
  // useState by call order: a slot set here starts at that value, and every setter call is kept
  slots: {} as Record<number, unknown>, sets: [] as [number, unknown][], slot: 0,
  chosen: undefined as unknown, ruler: undefined as unknown, place: undefined as ((root: unknown) => void) | undefined,
  answer: null as unknown,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  // an effect runs at once: what opening the picker does is what the tree's first expansion does
  useEffect: (run: () => void) => { run(); },
  useLayoutEffect: () => undefined,
  useRef: () => ({ current: null }),
  useState: (initial: unknown) => { const i = probe.slot++; return [i in probe.slots ? probe.slots[i] : initial, (v: unknown) => { probe.sets.push([i, v]); }]; },
}));
vi.mock("../lib/store/store.ts", () => ({ NA: "na", useStore: (fn: (s: unknown) => unknown) => fn(probe.state) }));
vi.mock("../lib/session/index.ts", () => ({
  ...Object.fromEntries(["downloadImageSetup", "pickImage", "saveImageFolder", "startImage", "stopImageDownload"]
    .map((name) => [name, async (...args: unknown[]) => { probe.calls.push(name); probe.args.push([name, args]); return probe.answer; }])),
  folderDialog: () => undefined,
}));
vi.mock("../composer/focus.ts", () => ({ focusComposer: () => undefined }));
vi.mock("../lib/ui/icons.tsx", () => ({ Icon: () => null }));
vi.mock("./ImageMark.tsx", () => ({ ImageMark: () => null }));
vi.mock("../picker/picker-models.ts", () => ({ memoryRuler: () => probe.ruler }));
vi.mock("../lib/ui/kit/popover.ts", () => ({ usePopover: (_ref: unknown, _open: boolean, place: (root: unknown) => void) => { probe.place = place; } }));
vi.mock("./image-choice.ts", () => ({ chosenImage: () => probe.chosen, imageCard: (gpu?: { totalBytes?: number }) => gpu?.totalBytes, sizeLabel: (w: number, h: number) => `${w}×${h}` }));
vi.mock("../lib/ui/ui.tsx", () => ({ PHONE: "", closePop: () => undefined, closeTip: () => undefined, isTouch: () => false, tabStops: () => [], useMedia: () => false }));

const { ImagePicker, middle, needsText } = await import("./ImagePicker.tsx");
const { cardGb, gb, timeLeft } = await import("../lib/words/format.ts");
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
const tree = () => { probe.slot = 0; return nodes(ImagePicker()); };
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
beforeEach(() => { probe.calls = []; probe.args = []; probe.slots = {}; probe.sets = []; probe.chosen = undefined; probe.ruler = undefined; probe.answer = null; });

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
  expect(shown.props["data-tipt"], "a value has no tip").toBeUndefined();
  expect(text(row0.node)).toContain(`${gb(left)} to fetch · ${gb(4.6 * GIB)} free on disk`);
  expect(row0.all.find((n) => n.props["data-testid"] === "image.picker.disk-free")?.props["className"]).toBe("short");
  expect(labels(row0.all)).toContain("Change the download folder");
  expect(bars()).toHaveLength(0);
  picker({ imagePresets: { presets: [], others: [klein], readAt: 1, disk: { folder: "F:\\models", freeBytes: 876 * GIB, picked: true } } });
  expect(disk().all.find((n) => n.props["data-testid"] === "image.picker.disk-free")?.props["className"]).toBeUndefined();
});

it("with no free figure for the folder, what is left to fetch ends the disk row with no stray dot, and the card's size shares the one footer row", () => {
  const klein = { ...others[0]!, needs: { files: KLEIN_FILES, download: true, bytes: 8 * GIB, leftBytes: 8 * GIB } };
  picker({ imagePresets: { presets: [], others: [klein], readAt: 1, disk: { picked: false } }, gpu: { vendor: "nvidia", totalBytes: 16 * GIB, freeBytes: 2 * GIB } });
  expect(text(disk().node)).toBe(`No folder yet${gb(8 * GIB)} to fetch`);
  const footer = tree().find((n) => n.type === "footer")!;
  expect(nodes(footer.props["children"]).some((n) => n.props["data-testid"] === "image.picker.disk")).toBe(true);
  expect(text(footer)).toContain(`${cardGb(16 * GIB)} GPU`);
  expect(text(footer), "the card, not what is free this second").not.toContain("free");
});

it("a row with its Download button says the size alone; without the button, or with no size known, the words say what it needs", () => {
  const sized = { ...others[0]!, needs: { files: KLEIN_FILES, download: true, bytes: 8 * GIB, leftBytes: 7 * GIB } };
  expect(needsText(sized, true)).toBe(gb(7 * GIB));
  expect(needsText(sized, false)).toBe(`Needs 3 files · ${gb(7 * GIB)}`);
  expect(needsText(others[0]!, true)).toBe("Needs 3 files");
  expect(needsText({ ...sized, why: "ComfyUI lacks a node it uses" }, true)).toBe("ComfyUI lacks a node it uses");
});

it("a stopped download keeps its part: the bar stays there, no Stop, and the row's button says Resume", () => {
  picker({ imagePresets: { presets: [ready], others, readAt: 1, disk: { folder: "F:\\models", freeBytes: 876 * GIB, picked: false } }, imageDownload: { ...running, state: "cancelled", ended: true } });
  expect(bars()).toHaveLength(1);
  expect(bar(disk().all)?.props["aria-valuenow"]).toBe(25);
  expect(labels(disk().all).filter((l) => l.startsWith("Stop"))).toEqual([]);
  expect(labels(row("flux2-klein-4b").all)).toContain("Resume downloading FLUX.2 Klein 4B");
  expect(text(row("flux2-klein-4b").node)).toContain("Needs 3 files");
});

it("a finished download that moved an older file aside says where it was kept, once, where its bar was", () => {
  const word = "A file named flux2-vae.safetensors was already there. It was kept as flux2-vae.safetensors.replaced-1.";
  const done: ImageDownload = { ...running, name: "flux2-vae.safetensors", file: 3, state: "done", completedBytes: 10, setupCompletedBytes: 120, ended: true, message: word };
  picker({ imagePresets: { presets: [ready], others, readAt: 1, disk: { folder: "F:\\models", freeBytes: 876 * GIB, picked: false } }, imageDownload: done });
  expect(disk().all.find((n) => n.props["data-testid"] === "image.picker.download-note")?.props["role"]).toBe("status");
  expect(text(disk().node)).toContain(word);
  expect(tree().map(text).filter((t) => t === word)).toHaveLength(1);
  // a download that ended with nothing moved says nothing more
  picker({ imagePresets: { presets: [ready], others, readAt: 1, disk: { folder: "F:\\models", freeBytes: 876 * GIB, picked: false } }, imageDownload: { ...done, message: undefined } });
  expect(disk().all.some((n) => n.props["data-testid"] === "image.picker.download-note")).toBe(false);
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

it("the empty picker reads nothing when it opens (the server sends the list) and never starts ComfyUI; its button says Start ComfyUI when the app's is stopped", async () => {
  picker({ imagePresets: { presets: [], readAt: 1 }, imageStatus: { state: "stopped" } });
  const button = blankButton();
  expect(probe.calls).toEqual([]);
  expect(button && text(button)).toBe("Start ComfyUI");
  if (!button) throw new Error("no button");
  (button.props["onClick"] as () => void)();
  await Promise.resolve();
  expect(probe.calls).toEqual(["startImage"]);
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

it("setups that cannot run are listed greyed out, closed to a pick, each saying what it needs or why not", async () => {
  const needing: ImagePreset = { ...others[2]!, needs: { files: ["other.safetensors"], download: false } };
  const refused: ImagePreset = { id: "nodes", name: "Needs nodes", family: "flux", group: "General", measured: false, sizes, why: "ComfyUI lacks a node it uses" };
  picker({ imagePresets: { presets: [ready], others: [needing, refused], readAt: 1 } });
  for (const [p, words] of [[needing, "Needs 1 file"], [refused, "ComfyUI lacks a node it uses"]] as const) {
    const { node, all } = row(p.id);
    expect(String(node.props["className"]).split(" ")).toContain("off");
    expect(all.find((n) => n.props["className"] === "pk-select")?.props["aria-disabled"]).toBe("true");
    expect(text(node)).toContain(words);
  }
  expect(String(row(ready.id).node.props["className"]).split(" ")).not.toContain("off");
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("./image-picker.css", import.meta.url), "utf8");
  expect(css).toContain(".image-picker .pk-r.off .pk-nm{color:var(--muted-foreground)}");
});

const tiered = (id: string, tier: string | undefined, group = "General", isReady = true): ImagePreset => ({ id, name: id, family: "flux", group, measured: false, sizes, ...(tier === undefined ? {} : { tier }), ...(isReady ? {} : { needs: { files: [`${id}.safetensors`], download: false } }) });
const otherList = () => tree().find((n) => n.props["data-testid"] === "image.picker.other-list")!;
const groupOrder = () => nodes(otherList().props["children"]).filter((n) => n.props["role"] === "group").map((n) => n.props["aria-label"]);
const rowOrder = () => nodes(otherList().props["children"]).map((n) => n.props["data-preset"]).filter((id): id is string => typeof id === "string");

it("Other models lists the server's groups in its order (presets.ts GROUPS), a group it does not name after them in the order first seen", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../../../server/src/image/presets.ts", import.meta.url), "utf8");
  const groups = [...(/export const GROUPS = \{([^}]*)\}/.exec(server)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  expect(groups.length).toBeGreaterThan(5);
  const presets = ["Zeta", ...groups.toReversed(), "Alpha"].map((g, i) => tiered(`p${i}`, undefined, g));
  picker({ imagePresets: { presets, others: [], readAt: 1 } });
  expect(groupOrder()).toEqual([...groups, "Zeta", "Alpha"]);
});

it("in a group the tier rows come first in the server's tier order (presets.ts TIERS, two tiers' pick between them), then ready rows, then the rest", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../../../server/src/image/presets.ts", import.meta.url), "utf8");
  const tiers = [...(/export const TIERS[^=]*= \[([\s\S]*?)\];/.exec(server)?.[1] ?? "").matchAll(/name: "([^"]+)"/g)].map((m) => m[1]!);
  expect(tiers.length).toBe(3);
  const two = `${tiers[0]} and ${tiers[1]!.toLowerCase()}`;
  const wanted = [tiers[0]!, two, tiers[1]!, tiers[2]!];
  picker({ imagePresets: { presets: [tiered("plain", undefined), ...wanted.toReversed().map((t) => tiered(t, t))], others: [tiered("unready", undefined, "General", false)], readAt: 1 } });
  expect(rowOrder()).toEqual([...wanted, "plain", "unready"]);
});

it("a row waits on the running download when it needs one of its files, whatever folder either lists the file under", () => {
  const a = { ...off("a", "A", ["diffusion_models/shared.safetensors", "vae/a-vae.safetensors"]) };
  const b = { ...off("b", "B", ["unet\\shared.safetensors"]) };
  const c = { ...off("c", "C", ["checkpoints/c.safetensors"]) };
  picker({ imagePresets: { presets: [ready], others: [a, b, c], readAt: 1 }, imageDownload: { ...running, preset: "a" } });
  expect(text(row("b").node)).toContain("Waiting on the download");
  expect(text(row("c").node)).not.toContain("Waiting");
});

it("a picked row keeps the size picked now when it has it, else runs at its first", async () => {
  const two = [{ width: 1024, height: 1024, bytes: GIB }, { width: 512, height: 512, bytes: GIB }];
  const b: ImagePreset = { ...ready, id: "b", name: "B", sizes: two };
  const c: ImagePreset = { ...ready, id: "c", name: "C", sizes: [sizes[0]!] };
  probe.chosen = { preset: ready, width: 512, height: 512, listed: true };
  picker({ imagePresets: { presets: [ready, b, c], others: [], readAt: 1 } });
  (row("b").all.find((n) => n.props["className"] === "pk-select")!.props["onClick"] as () => void)();
  (row("c").all.find((n) => n.props["className"] === "pk-select")!.props["onClick"] as () => void)();
  await Promise.resolve();
  expect(probe.args.filter(([n]) => n === "pickImage").map(([, a]) => a[0])).toEqual([{ preset: "b", width: 512, height: 512 }, { preset: "c", width: 1024, height: 1024 }]);
});

it("a size past the card's memory shows the ruler's overflow past the edge, in red, and says by how much", async () => {
  probe.ruler = { fill: 80, overflow: 20, continues: false };
  picker({ gpu: { vendor: "nvidia", totalBytes: 8 * GIB, freeBytes: GIB } });
  const cost = tree().find((n) => typeof n.props["className"] === "string" && (n.props["className"] as string).startsWith("pk-cost "))!;
  expect(cost.props["className"]).toBe("pk-cost no");
  expect(cost.props["aria-label"]).toBe(`${gb(10 * GIB)} estimated; ${gb(2 * GIB)} more than the GPU has`);
  expect(nodes(cost.props["children"]).find((n) => n.props["className"] === "pk-cost-over")?.props["style"]).toEqual({ width: "20%" });
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(new URL("../picker/picker.css", import.meta.url), "utf8")).toContain(".pk-cost.no .pk-cost-over{background:var(--red)}");
});

it("a long folder keeps its drive and its last folders, its middle cut", () => {
  const short = middle("F:\\ComfyUI_windows_portable\\ComfyUI\\models\\diffusion_models");
  expect(short).toHaveLength(34);
  expect(short.startsWith("F:\\ComfyUI")).toBe(true);
  expect(short.endsWith("\\diffusion_models")).toBe(true);
  expect(short).toContain("…");
});

it("a download whose setup total is not known counts this file's bytes", () => {
  const { setupCompletedBytes: _a, setupTotalBytes: _b, ...file } = running;
  picker({ imagePresets: { presets: [ready], others, readAt: 1, disk: { folder: "F:\\models", picked: false } }, imageDownload: { ...file, completedBytes: 5 * GIB, totalBytes: 10 * GIB, bytesPerSecond: undefined } });
  expect(bar(disk().all)?.props["aria-valuenow"]).toBe(50);
  expect(text(disk().node)).toContain(`${gb(5 * GIB)} of ${gb(10 * GIB)}`);
});

it("the empty picker's button keeps the words it was pressed as until the start or the look ends", () => {
  probe.slots = { 6: "check" };
  picker({ imagePresets: { presets: [], readAt: 1 }, imageStatus: { state: "missing" } });
  expect(text(blankButton()!)).toBe("Checking…");
  expect(blankButton()?.props["disabled"]).toBe(true);
  probe.slots = { 6: "start" };
  expect(text(blankButton()!)).toBe("Starting ComfyUI…");
});

it("with no folder dialog, Change folder opens a path field at the folder; Enter saves it, and a refusal shows in place of the numbers", async () => {
  const folders = { presets: [ready], others, readAt: 1, disk: { folder: "F:\\models", freeBytes: 876 * GIB, picked: false } };
  picker({ imagePresets: folders });
  (disk().all.find((n) => n.props["data-testid"] === "image.picker.change-folder")!.props["onClick"] as () => void)();
  await Promise.resolve();
  expect(probe.sets).toContainEqual([8, "F:\\models"]);
  probe.slots = { 8: "G:\\pictures" };
  const field = disk().all.find((n) => n.props["data-testid"] === "image.picker.folder-field")!;
  expect(field.props["value"]).toBe("G:\\pictures");
  (field.props["onKeyDown"] as (e: unknown) => void)({ key: "Enter", preventDefault: () => undefined });
  await Promise.resolve();
  expect(probe.args).toContainEqual(["saveImageFolder", ["G:\\pictures"]]);
  probe.slots = { 9: "That folder cannot be written." };
  expect(text(disk().node)).toContain("That folder cannot be written.");
  expect(text(disk().node)).not.toContain("free on disk");
});

it("the newest word on a download wins: a push over the copy the list was read with, the list's copy with no push", () => {
  const listed = { presets: [ready], others, readAt: 1, disk: { folder: "F:\\models", picked: false }, download: { ...running, setupCompletedBytes: 60 } };
  picker({ imagePresets: listed });
  expect(bar(disk().all)?.props["aria-valuenow"]).toBe(50);
  picker({ imagePresets: listed, imageDownload: running });
  expect(bar(disk().all)?.props["aria-valuenow"]).toBe(25);
});

it("a closed picker forgets the menu pressed on its rail", () => {
  probe.slots = { 0: "other" };
  picker({ pop: null });
  probe.slot = 0;
  expect(ImagePicker()).toBeNull();
  expect(probe.sets).toContainEqual([0, null]);
});

const whyOf = (all: Node[]) => all.find((n) => n.props["className"] === "pk-why");

it("a download that failed says what failed, why and what to do on its row; the server's own words are in the details", () => {
  const raw = "qwen_3_4b.safetensors: the download stopped at 2.1 GB of 7.8 GB. Download it again to carry on.";
  const failed: ImageDownload = { ...running, state: "error", ended: true, message: raw };
  picker({ imageDownload: failed });
  const { node, all } = row("flux2-klein-4b");
  expect(text(node)).toContain("Couldn't download FLUX.2 Klein 4B because the download stopped partway; download it again to carry on.");
  expect(text(node)).not.toContain("qwen_3_4b");
  expect(whyOf(all)?.props["data-why"]).toBe(raw);
  picker({ imageDownload: { ...failed, message: undefined } });
  expect(text(row("flux2-klein-4b").node)).toContain("The download failed.");
});

it("a refused Download says the template words on its row, the server's words in the details", async () => {
  picker();
  const said = { message: "Couldn't download the image setup because ComfyUI isn't running on this computer; start it first.", why: "Start ComfyUI on this computer first: downloads go into its model folders." };
  probe.answer = said;
  const button = row("other").all.find((n) => n.props["data-testid"] === "image.picker.download");
  expect(button, "the row offers its download").toBeDefined();
  (button!.props["onClick"] as () => void)();
  await vi.waitFor(() => expect(probe.sets.some(([, v]) => (v as { id?: string } | null)?.id === "other")).toBe(true));
  const [slot, value] = probe.sets.find(([, v]) => (v as { id?: string } | null)?.id === "other")!;
  probe.slots[slot] = value;
  const { node, all } = row("other");
  expect(text(node)).toContain(said.message);
  expect(whyOf(all)?.props["data-why"]).toBe(said.why);
});

it("a highlighted setup with files left to fetch shows those numbers in place of the last download's note", () => {
  const klein = { ...others[0]!, needs: { files: KLEIN_FILES, download: true, bytes: 8 * GIB, leftBytes: 8 * GIB } };
  const done: ImageDownload = { ...running, preset: "other", state: "done", ended: true, message: "A file was kept as x.replaced-1." };
  probe.slots = { 1: klein.id };
  picker({ imagePresets: { presets: [ready], others: [klein], readAt: 1, disk: { folder: "F:\\models", freeBytes: 876 * GIB, picked: false } }, imageDownload: done });
  expect(text(disk().node)).toContain(`${gb(8 * GIB)} to fetch`);
  expect(text(disk().node)).not.toContain("replaced");
});

it("the picker's own Close shows on the phone only: the button that opened it already names it", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("./image-picker.css", import.meta.url), "utf8");
  const phone = css.indexOf("@media (max-width:640px)") >= 0 ? css.indexOf("@media (max-width:640px)") : css.indexOf("@media(max-width:640px)");
  expect(css.indexOf(".image-picker .pk-search{display:none}")).toBeGreaterThanOrEqual(0);
  expect(css.indexOf(".image-picker .pk-search{display:none}")).toBeLessThan(phone);
  expect(css.indexOf(".image-picker .pk-search{display:flex", phone)).toBeGreaterThan(phone);
});

it("the footer is one row as the chat picker's: the download first, the card the sizes are judged by last; no favorites and no context lengths", () => {
  picker({ imagePresets: { presets: [ready], others, readAt: 1, disk: { folder: "F:\\models", freeBytes: 876 * GIB, picked: false } }, gpu: { vendor: "nvidia", totalBytes: 16 * GIB, freeBytes: 2 * GIB } });
  const footer = tree().find((n) => n.type === "footer")!;
  const parts = (footer.props["children"] as unknown[]).filter(isValidElement) as Node[];
  expect(parts[0]?.props["data-testid"]).toBe("image.picker.disk");
  expect(parts.at(-1)?.props["data-testid"]).toBe("image.picker.card");
  expect(tree().filter((n) => /favorite|ctx-len|context-length/i.test(String(n.props["data-testid"] ?? "") + String(n.props["className"] ?? "")))).toEqual([]);
});

const placedAt = (rect: { top: number; bottom: number; right: number }, ph: number) => {
  vi.stubGlobal("document", { getElementById: (id: string) => id === "modelBtn" ? { getBoundingClientRect: () => rect } : null });
  vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
  picker();
  tree();
  const root = { style: {} as Record<string, string>, offsetWidth: 300, offsetHeight: ph };
  probe.place!(root);
  vi.unstubAllGlobals();
  return root.style;
};

describe("where the picker sits", () => {
  it("right edge on the button's, above it when it fits there", () => {
    expect(placedAt({ top: 500, bottom: 530, right: 900 }, 400)).toEqual({ maxHeight: "", left: "600px", top: `${500 - 6 - 400}px` });
  });
  it("above, shortened, when the room above is not cramped though below has more", () => {
    expect(placedAt({ top: 300, bottom: 330, right: 900 }, 600)).toEqual({ maxHeight: `${300 - 14}px`, left: "600px", top: "8px" });
  });
  it("below when the room above is cramped and below has more", () => {
    expect(placedAt({ top: 200, bottom: 230, right: 900 }, 600)).toEqual({ maxHeight: `${800 - 230 - 14}px`, left: "600px", top: "236px" });
  });
});

it("the download row keeps one height whatever it says: the footer row is fixed and the disk row fills it", async () => {
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(new URL("../picker/picker.css", import.meta.url), "utf8")).toContain(".pk-bottom{height:44px;min-height:44px;");
  expect(readFileSync(new URL("./image-picker.css", import.meta.url), "utf8")).toMatch(/\.image-picker \.pk-disk\{[^}]*;height:100%;/);
});
