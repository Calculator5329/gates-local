// The image choice as the composer shows and sends it: the open thread's own (Thread.imageChoice,
// its last pick or image send), else the app's last pick anywhere (Settings.imageChoice), which a
// new thread starts from; on the phone, which cannot write Settings, a new thread's own pick first. The server's image.presets lists the presets ComfyUI has every file for
// and names what a send runs now; a choice saved since that read wins, so the button follows a
// pick at once.
import { cardBytes, type GpuStatus, type ImageChoice, type ImagePreset, type ImagePresets } from "@gates-local/contracts";
import { type Maybe, NA, type State } from "./store.ts";

export interface ImageView {
  readonly preset: ImagePreset;
  readonly width: number;
  readonly height: number;
  /**
   * A saved pick, or a default ComfyUI's last file list has: the button names only these. Never a
   * default when the server says this GPU has none (ImagePresets.noGpu).
   */
  readonly listed: boolean;
}

/** Image is on and image generation is on: Send goes to the image model. */
export const imageMode = (s: State): boolean => s.image && s.settings !== NA && s.settings?.imageGen === true;

/** No ComfyUI answered and the app has none to start: Image mode is not reachable until one does. */
export const imagesUnset = (s: State): boolean => s.imageStatus !== undefined && s.imageStatus !== NA && s.imageStatus.state === "missing";

/**
 * No image engine anywhere: with generation on, none answered, there is none to start and no
 * address is set; with it off, the server's look found none. Settings then offers Set up images
 * and no Generate images switch.
 */
export const noImageEngine = (s: Pick<State, "imageStatus">): boolean => {
  const st = s.imageStatus;
  if (st === undefined || st === NA) return false;
  return st.state === "off" ? st.nowhere === true : st.state === "missing" && st.addressSet !== true;
};

/** The last answer, so a store selector gets the same object back until its inputs change. */
let lastView: { presets: ImagePresets; saved: ImageChoice | undefined; view: ImageView } | undefined;

/** What an Image send runs now; undefined until image.presets has answered once. Stable for the same inputs. */
export function chosenImage(s: State): ImageView | undefined {
  const presets = s.imagePresets;
  if (presets === undefined || presets === NA) return undefined;
  const open = s.view === "thread" && s.threadId !== null ? s.threads.find((t) => t.id === s.threadId) : undefined;
  const saved = open?.imageChoice ?? (open === undefined ? s.imagePick : undefined) ?? (s.settings === NA ? undefined : s.settings?.imageChoice);
  if (lastView?.presets === presets && lastView.saved === saved) return lastView.view;
  const preset = saved === undefined ? undefined : [...presets.presets, presets.current.preset].find((p) => p.id === saved.preset);
  const fits = saved !== undefined && preset !== undefined && preset.sizes.some((z) => z.width === saved.width && z.height === saved.height);
  const view = fits
    ? { preset, width: saved.width, height: saved.height, listed: true }
    : { ...presets.current, listed: presets.noGpu === undefined && presets.presets.some((p) => p.id === presets.current.preset.id) };
  lastView = { presets, saved, view };
  return view;
}

/** The choice an Image send carries, or undefined when this send goes to a chat model. */
export function drawChoice(s: State): ImageChoice | undefined {
  if (!imageMode(s)) return undefined;
  const view = chosenImage(s);
  return view === undefined ? undefined : { preset: view.preset.id, width: view.width, height: view.height };
}

/** How many pictures an Image send makes: the open thread's count, a new thread's pick, else 1. */
export function imageCount(s: State): number {
  const open = s.view === "thread" && s.threadId !== null ? s.threads.find((t) => t.id === s.threadId) : undefined;
  return open === undefined ? s.imageCountNew : open.imageCount ?? 1;
}

export const sizeLabel = (width: number, height: number): string => `${width}×${height}`;

/** A setup's full name as the server last listed it, else its id (a setup ComfyUI no longer has). */
export function presetName(s: State, id: string): string {
  return presetOf(s, id)?.name ?? id;
}

/** A preset the server listed, by id; undefined before the list or for one it no longer has. */
export function presetOf(s: State, id: string) {
  const listed = s.imagePresets === undefined || s.imagePresets === NA ? undefined : s.imagePresets;
  return [...listed?.presets ?? [], ...listed?.others ?? [], ...listed ? [listed.current.preset] : []].find((p) => p.id === id);
}

/**
 * The card image sizes are judged by: its memory to the nearest GB (contracts/image-fit.ts), never
 * what is free this second, since the chat model leaves the GPU before an image loads (one thing
 * in memory at a time). A size fits when its estimate is at most this. Undefined without a
 * reading of the card's size.
 */
export function imageCard(gpu: Maybe<GpuStatus>): number | undefined {
  return gpu === undefined || gpu === NA || gpu.totalBytes === undefined ? undefined : cardBytes(gpu.totalBytes);
}
