// The image choice the composer shows and sends: the open thread's, else (on the phone, which
// cannot write Settings) a new thread's own pick, else the app's last pick.
import type { ImageChoice, ImagePreset } from "@gates-local/contracts";
import { expect, it } from "vitest";
import { chosenImage, imageCount, imagesUnset, noImageEngine, setupHeld } from "./image-choice.ts";
import type { State } from "../lib/store/store.ts";

const sizes = [{ width: 1024, height: 1024, bytes: 1 }, { width: 768, height: 512, bytes: 1 }];
const preset = (id: string): ImagePreset => ({ id, name: id, family: "sdxl", group: "General", measured: false, sizes });
const presets = { presets: [preset("a"), preset("b"), preset("c")], current: { preset: preset("a"), width: 1024, height: 1024 }, readAt: 1 };
const choice = (id: string): ImageChoice => ({ preset: id, width: 768, height: 512 });
const state = (over: Partial<Record<keyof State, unknown>>) => ({ imagePresets: presets, view: "thread", threadId: null, threads: [], settings: { imageChoice: choice("b") }, imagePick: undefined, ...over }) as unknown as State;

it("a new thread shows the phone's own pick over the app's last; an open thread shows its own", () => {
  expect(chosenImage(state({}))?.preset.id).toBe("b");
  expect(chosenImage(state({ imagePick: choice("c") }))?.preset.id).toBe("c");
  const open = { threadId: "t1", threads: [{ id: "t1", imageChoice: choice("a") }], imagePick: choice("c") };
  expect(chosenImage(state(open))).toMatchObject({ preset: { id: "a" }, width: 768 });
  // an open thread with no choice of its own follows the app's last pick, not a new thread's
  expect(chosenImage(state({ ...open, threads: [{ id: "t1" }] }))?.preset.id).toBe("b");
});

it("a setup building the card's engine beside the processor's holds nothing: pictures keep running on the processor, and a stop partway leaves them running", () => {
  const ready = { state: "stopped", owner: "none", own: true };
  for (const step of ["engine", "model", "starting", "error"] as const) {
    const first = { imageSetup: { progress: { step, completedBytes: 0, totalBytes: 1 } }, imageStatus: ready };
    expect(setupHeld(first as never), step).toBe(true);
    const toCard = { imageSetup: { toCard: true, progress: { step, completedBytes: 0, totalBytes: 1, toCard: true } }, imageStatus: ready };
    expect(setupHeld(toCard as never), step).toBe(false);
    expect(imagesUnset(toCard as never), step).toBe(false);
  }
});

it("an open thread with no count of its own makes one picture, not a new thread's pick", () => {
  expect(imageCount(state({ threadId: "t1", threads: [{ id: "t1" }], imageCountNew: 3 }))).toBe(1);
  expect(imageCount(state({ threadId: "t1", threads: [{ id: "t1", imageCount: 2 }], imageCountNew: 3 }))).toBe(2);
  expect(imageCount(state({ imageCountNew: 3 }))).toBe(3);
});

it("an address of one's own that does not answer is not no engine anywhere: Settings keeps its Generate images switch", () => {
  expect(noImageEngine({ imageStatus: { state: "missing", owner: "none", addressSet: true }, imageSetup: undefined } as never)).toBe(false);
  expect(noImageEngine({ imageStatus: { state: "missing", owner: "none" }, imageSetup: undefined } as never)).toBe(true);
});
