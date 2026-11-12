// The image choice the composer shows and sends: the open thread's, else (on the phone, which
// cannot write Settings) a new thread's own pick, else the app's last pick.
import type { ImageChoice, ImagePreset } from "@gates-local/contracts";
import { expect, it } from "vitest";
import { chosenImage } from "./image-choice.ts";
import type { State } from "./store.ts";

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
