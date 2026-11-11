// The app's one image choice (Settings.imageChoice) as the composer shows and sends it. The
// server's image.presets lists the presets ComfyUI has every file for and names what a send
// runs now; a choice saved since that read wins, so the button follows a pick at once.
import type { GpuStatus, ImageChoice, ImagePreset, ImagePresets } from "@gates-local/contracts";
import type { Verdict } from "./format.ts";
import { type Maybe, NA, type State } from "./store.ts";

export interface ImageView {
  readonly preset: ImagePreset;
  readonly width: number;
  readonly height: number;
  /** A saved pick, or a default ComfyUI's last file list has: the button names only these. */
  readonly listed: boolean;
}

/** Image is on and image generation is on: Send goes to the image model. */
export const imageMode = (s: State): boolean => s.image && s.settings !== NA && s.settings?.imageGen === true;

/** The last answer, so a store selector gets the same object back until its inputs change. */
let lastView: { presets: ImagePresets; saved: ImageChoice | undefined; view: ImageView } | undefined;

/** What an Image send runs now; undefined until image.presets has answered once. Stable for the same inputs. */
export function chosenImage(s: State): ImageView | undefined {
  const presets = s.imagePresets;
  if (presets === undefined || presets === NA) return undefined;
  const saved = s.settings === NA ? undefined : s.settings?.imageChoice;
  if (lastView?.presets === presets && lastView.saved === saved) return lastView.view;
  const preset = saved === undefined ? undefined : [...presets.presets, presets.current.preset].find((p) => p.id === saved.preset);
  const fits = saved !== undefined && preset !== undefined && preset.sizes.some((z) => z.width === saved.width && z.height === saved.height);
  const view = fits
    ? { preset, width: saved.width, height: saved.height, listed: true }
    : { ...presets.current, listed: presets.presets.some((p) => p.id === presets.current.preset.id) };
  lastView = { presets, saved, view };
  return view;
}

/** The choice an Image send carries, or undefined when this send goes to a chat model. */
export function drawChoice(s: State): ImageChoice | undefined {
  if (!imageMode(s)) return undefined;
  const view = chosenImage(s);
  return view === undefined ? undefined : { preset: view.preset.id, width: view.width, height: view.height };
}

export const sizeLabel = (width: number, height: number): string => `${width}×${height}`;

/** The server's VRAM safety margin, as the chat picker shows it. */
const MARGIN = 512 * 1024 ** 2;
const held = (gpu: GpuStatus, keep: (o: GpuStatus["occupants"][number]) => boolean) => gpu.occupants.filter(keep).reduce((n, o) => n + o.bytes, 0);

/**
 * How a job at `bytes` sits in GPU memory now, the way the server's image fit counts it:
 * ComfyUI's own resident memory is credited, and an idle chat model the app loaded is stopped
 * when that makes room (`frees`). Every byte count is the preset's estimate. Undefined
 * without a GPU reading.
 */
export function imageFit(bytes: number, gpu: Maybe<GpuStatus>): { readonly v: Verdict; readonly frees: boolean } | undefined {
  if (gpu === undefined || gpu === NA || gpu.freeBytes === undefined) return undefined;
  const avail = gpu.freeBytes + held(gpu, (o) => o.kind === "image");
  const base = { need: bytes, avail, measured: false, chip: "", word: "", detail: "" };
  if (bytes <= avail - MARGIN) return { v: { ...base, k: "gpu", amt: 0 }, frees: false };
  const chats = held(gpu, (o) => o.kind === "chat-model" && !o.protected);
  if (bytes <= avail + chats - MARGIN) return { v: { ...base, k: "gpu", amt: 0 }, frees: true };
  return { v: { ...base, k: "no", amt: bytes - Math.max(0, avail - MARGIN) }, frees: false };
}
