// The not-set-up pop-up's buttons, read from its element tree with React's hooks stubbed (as
// ImagePicker.test.ts does): what it offers with and without a download, the plan's numbers, and
// what its presses call.
import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ state: {} as Record<string, unknown>, calls: [] as [string, unknown[]][], slots: {} as Record<number, unknown>, sets: [] as [number, unknown][], slot: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: () => ({ current: null }),
  useState: (initial: unknown) => { const i = probe.slot++; return [i in probe.slots ? probe.slots[i] : initial, (v: unknown) => { probe.sets.push([i, v]); }]; },
}));
vi.mock("../lib/ui/kit/popover.ts", () => ({ usePopover: () => undefined }));
vi.mock("../lib/store/store.ts", () => ({ NA: "na", getState: () => probe.state, setState: (v: unknown) => { probe.calls.push(["setState", [v]]); }, useStore: (fn: (s: unknown) => unknown) => fn(probe.state) }));
vi.mock("../lib/session/index.ts", () => Object.fromEntries(["checkImageStatus", "loadImageSetup", "openSettings", "startImageSetup", "updateSettings"]
  .map((name) => [name, async (...args: unknown[]) => { probe.calls.push([name, args]); return null; }])));
vi.mock("../lib/ui/ui.tsx", () => ({ SheetHead: () => null, closePop: () => { probe.calls.push(["closePop", []]); }, place: () => undefined }));
vi.mock("./image-choice.ts", () => ({ imagesUnset: () => true }));

const { ImageUnset } = await import("./ImageUnset.tsx");
const { gb } = await import("../lib/words/format.ts");
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
const tree = () => { probe.slot = 0; return nodes(ImageUnset()); };
const button = (id: string) => tree().find((n) => n.props["data-testid"] === id);
const press = async (id: string) => { (button(id)!.props["onClick"] as () => void)(); for (let i = 0; i < 4; i++) await Promise.resolve(); };

const offer = { engine: { version: "0.44.0", bytes: 3 * GIB, installed: false }, model: { preset: "flux2-klein-4b-compact", name: "FLUX.2 Klein 4B", bytes: 5 * GIB }, freeBytes: 40 * GIB, needBytes: 9 * GIB };
const at = (over: Record<string, unknown>) => { probe.state = { pop: { id: "unset" }, imageStatus: { state: "missing", owner: "none" }, imageSetup: offer, unavailable: {}, ...over }; };
beforeEach(() => { probe.calls = []; probe.slots = {}; probe.sets = []; });

it("with the download on offer: Set up images, then Settings, and no Check again; Settings closes the pop-up and opens Settings at Images", async () => {
  at({});
  expect(button("image.unset.set-up")).toBeDefined();
  expect(text(button("image.unset.settings")!)).toBe("Settings");
  expect(button("image.unset.check-again-missing")).toBeUndefined();
  await press("image.unset.settings");
  expect(probe.calls).toEqual([["closePop", []], ["openSettings", ["images"]]]);
});

it("with nothing on offer: Open Settings and Check again, for a ComfyUI the person runs", () => {
  at({ imageSetup: { ...offer, why: "This computer cannot run the image engine." } });
  expect(button("image.unset.set-up")).toBeUndefined();
  expect(text(button("image.unset.settings")!)).toBe("Open Settings");
  expect(text(button("image.unset.check-again-missing")!)).toBe("Check again");
});

it("the plan says the whole download, engine and model, and what the drive needs and has", () => {
  at({});
  const plan = tree().find((n) => n.props["id"] === "imageSetupPlan")!;
  expect(text(plan)).toContain(gb(8 * GIB));
  expect(text(plan)).toContain(`Needs ${gb(9 * GIB)} free; ${gb(40 * GIB)} is free.`);
  at({ imageSetup: { ...offer, engine: { ...offer.engine, installed: true } } });
  expect(text(tree().find((n) => n.props["id"] === "imageSetupPlan")!)).toContain(gb(5 * GIB));
});

it("a closed pop-up keeps no note", () => {
  probe.slots = { 1: "Still no answer." };
  at({ pop: null });
  tree();
  expect(probe.sets).toContainEqual([1, null]);
  probe.sets = [];
  at({});
  tree();
  expect(probe.sets).toEqual([]);
});

it("an address that does not answer offers the app's own engine only as a press: it clears the address, then reads the status and the setup again", async () => {
  at({ imageStatus: { state: "missing", owner: "none", addressSet: true, baseUrl: "http://10.0.0.2:8188" } });
  expect(tree().some((n) => n.props["data-state"] === "not-running")).toBe(true);
  expect(probe.calls).toEqual([]);
  await press("image.unset.use-own");
  expect(probe.calls.map(([n]) => n)).toEqual(["updateSettings", "checkImageStatus", "loadImageSetup"]);
  expect(probe.calls[0]![1]).toEqual([{ comfyUrl: null }]);
});
