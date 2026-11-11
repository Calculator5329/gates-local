// Origin: ai/local-ai-lab/workflows/flux-default.json at fd7abb65f8cb02ad71a0c81b688e98b81272997b.
// local-ai-lab is Ethan Gates's own repository, so this port is his work and is covered by this
// repository's MIT license (LICENSE). The model, text encoder and VAE named below are not part
// of this repository: their weights are downloaded separately under their own licenses.
// API graph preserved, with runtime values in place of the {{PROMPT}}, {{SEED}}, {{WIDTH}} and
// {{HEIGHT}} tokens, and one change: 8 steps where the file has 4. The lab's settings study
// (bench-results.md, 2026-07-11, 34 votes on this model) found every 4-step image mediocre and
// recommends 6 to 8 steps for fast drafts, 12 for quality, never fewer than 6.
export const FLUX_UNET = "flux-2-klein-4b-fp8.safetensors";
export const FLUX_CLIP = "qwen_3_4b.safetensors";
export const FLUX_VAE = "flux2-vae.safetensors";
export const FLUX_STEPS = 8;

export function fluxWorkflow(prompt: string, seed: number, files: { unet: string; clip: string; vae: string }, size: { width: number; height: number }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: files.unet, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: files.clip, type: "flux2" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: files.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
    "6": { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], cfg: 1.0 } },
    "7": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "9": { class_type: "Flux2Scheduler", inputs: { steps: FLUX_STEPS, width: size.width, height: size.height } },
    "10": { class_type: "EmptyFlux2LatentImage", inputs: { width: size.width, height: size.height, batch_size: 1 } },
    "11": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["7", 0], guider: ["6", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["10", 0] } },
    "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } },
    "13": { class_type: "SaveImage", inputs: { filename_prefix: "gates-local/flux2-klein", images: ["12", 0] } },
  };
}
