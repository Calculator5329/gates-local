// Origin: ai/local-ai-lab/workflows/sdxl-lightning.json at c092f4d2bba88c4c76b37e34c31f9c2e28643c9c
// (the file was written in d2e58f5 there). local-ai-lab is Ethan Gates's own repository, so this
// port is his work and is covered by this repository's MIT license (LICENSE).
// The checkpoint and LoRA named below are not part of this repository: their weights are
// downloaded separately and come under their own licenses.
// API graph preserved, with runtime values in place of template tokens.
// The default 9 GiB budget is a conservative estimate above the lab's 7.86 GiB
// warm measurement at 768x512, NOT a measured peak or a hard GPU reservation.
export const IMAGE_ESTIMATED_BYTES = 9 * 1024 ** 3;
export const CHECKPOINT = "sdxl_lightning_4step.safetensors";
export const LORA = "RW_pixelart_XL_v1.safetensors";

export function workflow(prompt: string, seed: number, checkpoint = CHECKPOINT, lora = LORA) {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "2": { class_type: "LoraLoader", inputs: { lora_name: lora, strength_model: 0.8, strength_clip: 0.8, model: ["1", 0], clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 1] } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "blurry, photorealistic, 3d render, smooth gradients, anti-aliased, text, watermark, logo, low quality, jpeg artifacts", clip: ["2", 1] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 768, height: 512, batch_size: 1 } },
    "6": { class_type: "KSampler", inputs: { seed, steps: 4, cfg: 1.0, sampler_name: "euler", scheduler: "sgm_uniform", denoise: 1.0, model: ["2", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0] } },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    "8": { class_type: "SaveImage", inputs: { filename_prefix: "gates-local/sdxl-lightning-pixelart", images: ["7", 0] } },
  };
}
