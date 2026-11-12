// A /object_info answer for fake ComfyUIs: ComfyUI 0.45.0's own (object-info.json, every node
// class the app's setups and the fixtures use) with the file lists filled in.
import { readFileSync } from "node:fs";

const base = JSON.parse(readFileSync(new URL("./object-info.json", import.meta.url), "utf8")) as Record<string, { input: { required: Record<string, unknown[]> } }>;

export interface FakeFiles {
  checkpoints?: readonly string[];
  loras?: readonly string[];
  diffusion_models?: readonly string[];
  text_encoders?: readonly string[];
  vae?: readonly string[];
}

const INPUTS: Record<keyof FakeFiles, readonly (readonly [string, string])[]> = {
  checkpoints: [["CheckpointLoaderSimple", "ckpt_name"]],
  loras: [["LoraLoader", "lora_name"], ["LoraLoaderModelOnly", "lora_name"]],
  diffusion_models: [["UNETLoader", "unet_name"]],
  text_encoders: [["CLIPLoader", "clip_name"]],
  vae: [["VAELoader", "vae_name"]],
};

/** The files the app's own setups load: SDXL Lightning, its pixel-art LoRA, and FLUX.2 Klein 4B. */
export const SDXL_FILES: FakeFiles = { checkpoints: ["sdxl_lightning_4step.safetensors"], loras: ["RW_pixelart_XL_v1.safetensors"] };
export const KLEIN_FILES: FakeFiles = { diffusion_models: ["flux-2-klein-4b-fp8.safetensors"], text_encoders: ["qwen_3_4b.safetensors"], vae: ["flux2-vae.safetensors"] };

/** ComfyUI's /object_info with these files listed and every other list empty. */
export function comfyInfo(...lists: readonly FakeFiles[]): Record<string, unknown> {
  const info = structuredClone(base);
  for (const [kind, inputs] of Object.entries(INPUTS) as [keyof FakeFiles, (typeof INPUTS)[keyof FakeFiles]][]) {
    const names = lists.flatMap((l) => l[kind] ?? []);
    for (const [node, field] of inputs) info[node]!.input.required[field]![0] = kind === "vae" ? [...names, "pixel_space"] : names;
  }
  return info;
}
