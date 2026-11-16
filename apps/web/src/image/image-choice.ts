import { cardBytes, type GpuStatus, type ImageChoice, type ImagePreset, type ImagePresets } from "@gates-local/contracts";
import { type Maybe, NA, type State } from "../lib/store/store.ts";

export interface ImageView {
  readonly preset: ImagePreset;
  readonly width: number;
  readonly height: number;
  readonly listed: boolean;
}

export const imageMode = (s: State): boolean => s.image && s.settings !== NA && s.settings?.imageGen === true;

export const setupHeld = (s: Pick<State, "imageSetup" | "imageStatus">): boolean => {
  const step = s.imageSetup?.progress?.step;
  if (step === undefined || step === "done") return false;
  if (s.imageSetup?.progress?.toCard === true) return false;
  const st = s.imageStatus;
  return st === undefined || st === NA || st.addressSet !== true;
};

export const imagesUnset = (s: State): boolean => (s.imageStatus !== undefined && s.imageStatus !== NA && s.imageStatus.state === "missing") || setupHeld(s);

export const noImageEngine = (s: Pick<State, "imageStatus" | "imageSetup">): boolean => {
  if (setupHeld(s)) return true;
  const st = s.imageStatus;
  if (st === undefined || st === NA) return false;
  return st.state === "off" ? st.nowhere === true : st.state === "missing" && st.addressSet !== true;
};

let lastView: { presets: ImagePresets; saved: ImageChoice | undefined; view: ImageView } | undefined;

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

export function drawChoice(s: State): ImageChoice | undefined {
  if (!imageMode(s)) return undefined;
  const view = chosenImage(s);
  return view === undefined ? undefined : { preset: view.preset.id, width: view.width, height: view.height };
}

export function imageCount(s: State): number {
  const open = s.view === "thread" && s.threadId !== null ? s.threads.find((t) => t.id === s.threadId) : undefined;
  return open === undefined ? s.imageCountNew : open.imageCount ?? 1;
}

export const sizeLabel = (width: number, height: number): string => `${width}×${height}`;

export const runKey = (c: ImageChoice): string => `${c.preset}:${c.width}x${c.height}`;

export function presetName(s: State, id: string): string {
  return presetOf(s, id)?.name ?? id;
}

export function presetOf(s: State, id: string) {
  const listed = s.imagePresets === undefined || s.imagePresets === NA ? undefined : s.imagePresets;
  return [...listed?.presets ?? [], ...listed?.others ?? [], ...listed ? [listed.current.preset] : []].find((p) => p.id === id);
}

export function imageCard(gpu: Maybe<GpuStatus>): number | undefined {
  return gpu === undefined || gpu === NA || gpu.totalBytes === undefined ? undefined : cardBytes(gpu.totalBytes);
}
