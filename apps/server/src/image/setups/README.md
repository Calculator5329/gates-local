# Built-in image setups

Each file is a ComfyUI workflow in API format. Image mode reads it the way it
reads any workflow (`convert.ts`, then `controls.ts`): the prompt, size and
seed are found by the graph's shape and filled in for each job, and the
model files are matched against ComfyUI's own `/object_info` lists. The
prompt, seed and size written in the files are placeholders.

- `flux2-klein-4b.json`: from local-ai-lab `workflows/flux-default.json` at
  `fd7abb65f8cb02ad71a0c81b688e98b81272997b`, with one change: 8 steps where
  the file has 4. The lab's settings study (bench-results.md, 2026-07-11, 34
  votes on this model) found every 4-step image mediocre and recommends 6 to
  8 steps for fast drafts, 12 for quality, never fewer than 6.
- `flux2-klein-4b-compact.json`: the Klein graph with the FP4 text encoder
  (`qwen_3_4b_fp4_flux2.safetensors`) in place of the full one and 12 steps
  in place of 8: the GPU matrix's compact-12 setup (2026-11-12), for a card
  with under 8 GiB free. Its output prefix is its own.
- `z-image-turbo-int8.json`: ComfyUI's own Z-Image Turbo int8 template
  (`comfyui-workflow-templates-json` 0.1.132, MIT, Comfy Org; the trimmed copy
  is `test/comfy/templates/image_z_image_turbo_int8.json`) run through
  `convert.ts`, with one edit: the app's output prefix. Its files are the int8
  ones the matrix measured.
- `moss-image.json`: the same package's MOSS-Image template, converted, with
  these edits: the app's output prefix; the prompt enhancer off (its switch,
  and its branch muted); the size the instance's own (the resolution selector
  removed); and `flux2-vae.safetensors`, the full FLUX.2 VAE the matrix ran,
  in place of `flux2-vae_small.safetensors`. The small VAE's quality is not
  compared here. `convert.test.ts` makes exactly these edits and checks the
  result equals the file.
- `sdxl-checkpoint.json`: the graph for a person's own SDXL checkpoint
  (`installed.ts` fills in the file and its family's plain settings). It was
  the app's earlier built-in SDXL setup, from local-ai-lab at
  `c092f4d2bba88c4c76b37e34c31f9c2e28643c9c` (the workflow written in
  `d2e58f5` there; THIRD_PARTY_NOTICES.md names it) with the LoRA left out
  (nodes 3, 4 and 6 read node 1); here its file name,
  size and output prefix are placeholders. At cfg 1.0 ComfyUI skips the
  negative pass, so its negative prompt changes nothing today.
- `flux2-klein-4b-pixel.json`: the Klein graph with ComfyUI's own ImageScale (to 128 x 128,
  `area`) and ImageQuantize (32 colours, no dither) between the decode and the save, for the
  pixel-art and game-sprite themes. The theme rows themselves (prompt wrapping and sizes) are in
  `presets.ts`, taken from the image-themes research of 2026-11-12, whose 16 GB level uses Klein
  4B for all five themes. None of its quality, timing or memory figures is measured.
- `files.json`: where each file these setups load is downloaded from (a pinned Hugging Face
  revision), its size in bytes and its sha256, from the GPU runs of 2026-11-12 and the
  image-themes research. Its `licence` field is what the model card states; the licence texts
  themselves were not read.

The Klein and checkpoint graphs come from local-ai-lab, Ethan Gates's own
repository, so they are his work and are covered by this repository's MIT
license. The Z-Image and MOSS graphs are derived from Comfy Org's MIT
templates (see THIRD_PARTY_NOTICES.md). The model weights any of them name are
not part of this repository and come under their own licenses.

The memory each setup needs is in `presets.ts`: 8 GiB for Klein and its
themes, 6 GiB for Z-Image int8, 4 GiB for compact and MOSS. They are the tier
thresholds the owner set (2026-11-13), used as caps; none is a measured peak or
a hard GPU reservation, so every preset says `measured: false`.
