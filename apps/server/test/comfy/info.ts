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

/** A person's own SDXL checkpoint and LoRA: none of the app's setups loads either. */
export const SDXL_FILES: FakeFiles = { checkpoints: ["juggernaut-xl.safetensors"], loras: ["ink-xl.safetensors"] };
/** The files the app's own setups load: FLUX.2 Klein 4B with its full text encoder, and with the compact one. */
export const KLEIN_FILES: FakeFiles = { diffusion_models: ["flux-2-klein-4b-fp8.safetensors"], text_encoders: ["qwen_3_4b.safetensors"], vae: ["flux2-vae.safetensors"] };
export const KLEIN_COMPACT_FILES: FakeFiles = { diffusion_models: ["flux-2-klein-4b-fp8.safetensors"], text_encoders: ["qwen_3_4b_fp4_flux2.safetensors"], vae: ["flux2-vae.safetensors"] };
/** Z-Image Turbo int8, and MOSS-Image (which decodes with the Klein VAE). */
export const ZIMAGE_FILES: FakeFiles = { diffusion_models: ["z_image_turbo_int8_convrot.safetensors"], text_encoders: ["qwen_3_4b_fp8_mixed.safetensors"], vae: ["ae.safetensors"] };
export const MOSS_FILES: FakeFiles = { diffusion_models: ["moss_image_sft_int8_convrot.safetensors"], text_encoders: ["qwen3.5_9b_w4a8_gptq.safetensors"], vae: ["flux2-vae.safetensors"] };
/** Every file the app's own setups load. */
export const APP_FILES: readonly FakeFiles[] = [KLEIN_FILES, KLEIN_COMPACT_FILES, ZIMAGE_FILES, MOSS_FILES];

/** ComfyUI's /object_info with these files listed and every other list empty. */
export function comfyInfo(...lists: readonly FakeFiles[]): Record<string, unknown> {
  const info = structuredClone(base);
  for (const [kind, inputs] of Object.entries(INPUTS) as [keyof FakeFiles, (typeof INPUTS)[keyof FakeFiles]][]) {
    const names = lists.flatMap((l) => l[kind] ?? []);
    for (const [node, field] of inputs) info[node]!.input.required[field]![0] = kind === "vae" ? [...names, "pixel_space"] : names;
  }
  return info;
}
