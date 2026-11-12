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
- `sdxl-lightning-pixel.json`: from local-ai-lab
  `workflows/sdxl-lightning.json` at
  `c092f4d2bba88c4c76b37e34c31f9c2e28643c9c` (written in `d2e58f5` there),
  four steps, the pixel-art LoRA at 0.8.
- `sdxl-lightning.json`: the same graph without the LoRA (node 2 left out,
  nodes 3, 4 and 6 read node 1) and without the pixel-art terms in the
  negative prompt. At cfg 1.0 ComfyUI skips the negative pass, so that prompt
  changes nothing today; it stays for a later setup with a higher cfg.
- `flux2-klein-4b-pixel.json`: the Klein graph with ComfyUI's own ImageScale (to 128 x 128,
  `area`) and ImageQuantize (32 colours, no dither) between the decode and the save, for the
  pixel-art and game-sprite themes. The theme rows themselves (prompt wrapping and sizes) are in
  `presets.ts`, taken from the image-themes research of 2026-11-12, whose 16 GB level uses Klein
  4B for all five themes. None of its quality, timing or memory figures is measured.
- `files.json`: where each file these setups load is downloaded from (a pinned Hugging Face
  revision), its size in bytes, its sha256 and its licence, from the same research. The SDXL
  pixel-art LoRA has no entry: it has no source the research checked.

local-ai-lab is Ethan Gates's own repository, so these files are his work and
are covered by this repository's MIT license. The model weights they name are
not part of this repository and come under their own licenses.

The memory each setup needs is in `presets.ts`. The SDXL 9 GiB figure is a
conservative estimate above the lab's 7.86 GiB warm reading at 768x512, not a
measured peak or a hard GPU reservation.
